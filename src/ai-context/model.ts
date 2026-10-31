/** What an export is made of: its parameters, how a log becomes a line / pattern / flow id, folder names and fetch windows. */
import { createHmac } from 'node:crypto';
import { join, sep } from 'node:path';
import { AI_CONTEXT_TIME_ZONE } from '../config.js';
import { FLOW_ID_FIELDS } from '../providers/base.js';
import { LogEntry, LogLevel } from '../types.js';

export interface SnapshotMeta {
  provider: string;
  env?: string;
  organization: string;
  stream: string;
  service?: string;
  levels?: LogLevel[];
  /** Resolved ISO 8601 bounds of the whole export */
  from: string;
  to: string;
  limit: number;
  sql?: string;
  /** Framework noise rows were downloaded too instead of only counted */
  includeNoise?: boolean;
  cache?: boolean;
}

export interface ExportResult {
  /** Absolute path of the export folder */
  dir: string;
  /** Folder path relative to the ai-context directory, as read_ai_context expects it */
  snapshot: string;
  rows: number;
  duplicates: number;
  flows: number;
  truncated: boolean;
}

export interface Pattern {
  template: string; level: string; service: string; count: number;
  firstSeen: string; lastSeen: string; example: string;
}

/** One saved request flow, as listed in SUMMARY and manifest. */
export interface FlowRow {
  id: string; file: string; rows: string; errors: number; path: string; durationMs: number;
  /** Bug # (pattern rank) once the export is finished */
  pattern?: number;
  patternKey?: string;
  firstFailure?: string;
}

/** One failing log's correlation id, remembered across windows to pick flows for the whole export. */
export interface ErrorId { key: string; ts: string; field: string; value: string }

const HOUR_MS = 60 * 60_000;
export const DAY_MS = 24 * HOUR_MS;
const ID_KEY = /rcid|correlation|trace_?id|span_?id|request_?id/i;
const DROP_KEYS = new Set(['_timestamp', 'message', 'body', 'log', 'msg', 'level', 'severity']);

export const safe = (value: string) => value.replace(/[^\w.-]+/g, '_').replace(/^\.+/, '_').slice(0, 80) || '_';
export const toPosix = (path: string) => path.split(sep).join('/');

/** SQL with whitespace runs outside quoted strings and identifiers collapsed to one space, trimmed. */
export function normalizeSql(sql: string): string {
  return sql.split(/('(?:[^']|'')*'|"(?:[^"]|"")*")/).map((part, i) => (i % 2 ? part : part.replace(/\s+/g, ' '))).join('').trim();
}

/**
 * Cache key of one SQL search: HMAC-SHA256 of env, normalized SQL and the absolute window, keyed by the organization
 * identifier. It goes into a plaintext SUMMARY header: it shows neither the SQL nor the identifier, and another
 * organization's key never matches.
 */
export function queryKey(search: { env?: string; sql: string; from: string; to: string }, orgKey: string): string {
  const window = [search.from, search.to].map((t) => new Date(t).toISOString());
  return createHmac('sha256', orgKey).update([search.env || 'default', normalizeSql(search.sql), ...window].join('\n')).digest('hex').slice(0, 32);
}

/** "20261015-0935" in AI_CONTEXT_TIME_ZONE (UTC by default). */
export function localStamp(iso: string, timeZone = AI_CONTEXT_TIME_ZONE): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}`;
}

/** First line of a message with ids, timestamps and numbers replaced, so repeats group together. */
export function messageTemplate(message: string): string {
  return (message.split('\n').find((line) => line.trim()) ?? '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?/g, '<ts>')
    .replace(/\d{1,2}\/\d{1,2}\/\d{4},? \d{1,2}:\d{2}(:\d{2})?( [AP]M)?/g, '<ts>')
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/'[^'\n]{1,80}'/g, "'<s>'")
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** One compact JSONL record: empty and duplicated fields dropped, correlation ids lifted into `ids`. */
export function compact(entry: LogEntry): Record<string, unknown> {
  const ids: Record<string, unknown> = {};
  const attrs: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry.metadata ?? {})) {
    if (value === null || value === undefined || value === '' || DROP_KEYS.has(key) || value === entry.service) continue;
    (ID_KEY.test(key) ? ids : attrs)[key] = value;
  }
  return {
    ts: entry.timestamp, level: entry.level, service: entry.service, message: entry.message,
    ...(Object.keys(ids).length ? { ids } : {}), ...(Object.keys(attrs).length ? { attrs } : {}),
  };
}

/** Reconstructs a LogEntry from a compact JSONL record. */
export function uncompact(raw: Record<string, unknown>, provider = 'openobserve'): LogEntry {
  const ids = (raw.ids && typeof raw.ids === 'object' ? raw.ids : {}) as Record<string, unknown>;
  const attrs = (raw.attrs && typeof raw.attrs === 'object' ? raw.attrs : {}) as Record<string, unknown>;
  return {
    timestamp: typeof raw.ts === 'string' ? raw.ts : new Date().toISOString(),
    level: (typeof raw.level === 'string' ? raw.level : 'Information') as LogLevel,
    service: typeof raw.service === 'string' ? raw.service : undefined,
    message: typeof raw.message === 'string' ? raw.message : '',
    provider,
    metadata: { ...ids, ...attrs },
  };
}

/** Pattern identity shared by grouping and flow sampling. The exception often holds the root cause behind a generic message. */
export function patternOf(entry: LogEntry): { key: string; template: string; level: string; service: string } {
  const service = entry.service || '_unknown';
  const level = String(entry.level);
  const exception = entry.metadata?.exception_message ?? entry.metadata?.exception_type;
  const template = messageTemplate(entry.message) + (exception ? ` :: ${messageTemplate(String(exception))}` : '');
  return { key: `${level}|${service}|${template}`, template, level, service };
}

export function errorIdOf(entry: LogEntry): ErrorId | undefined {
  if (entry.level !== 'Error' && entry.level !== 'Fatal') return undefined;
  const field = FLOW_ID_FIELDS.find((f) => entry.metadata?.[f] !== undefined && entry.metadata?.[f] !== null && entry.metadata?.[f] !== '');
  return field ? { key: patternOf(entry).key, ts: entry.timestamp, field, value: String(entry.metadata![field]) } : undefined;
}

/**
 * Picks correlation ids of failing logs to fetch full request flows for: every distinct id (newest first) of each
 * error pattern, most frequent pattern first, so the cap cuts the long tail rather than a whole kind of failure.
 */
// ponytail: `max` caps the flows of one export; raise it or expose it as a tool param if 200 failing requests isn't enough.
export function pickIds(records: ErrorId[], max = 200): Array<{ field: string; value: string; ts: string }> {
  const byPattern = new Map<string, Map<string, ErrorId>>();
  for (const record of [...records].sort((a, b) => b.ts.localeCompare(a.ts))) {
    const ids = byPattern.get(record.key) ?? new Map<string, ErrorId>();
    if (!ids.has(`${record.field}|${record.value}`)) ids.set(`${record.field}|${record.value}`, record);
    byPattern.set(record.key, ids);
  }
  // Keyed by value: rcid and trace_id often carry the same id, which is one request, not two.
  const picked = new Map<string, { field: string; value: string; ts: string }>();
  for (const ids of [...byPattern.values()].sort((a, b) => b.size - a.size)) {
    for (const id of ids.values()) if (picked.size < max && !picked.has(id.value)) picked.set(id.value, { field: id.field, value: id.value, ts: id.ts });
  }
  return [...picked.values()];
}

/** ai-context/<provider>/<env>/<org>/<stream>: every export of one stream lives here. */
export function snapshotParent(meta: SnapshotMeta, baseDir: string): string {
  return join(baseDir, safe(meta.provider), safe(meta.env || 'default'), safe(meta.organization), safe(meta.stream));
}

/** "<from>_<to>_<service>_<levels>" in local time: an export folder name without its row count. */
export function exportLabel(meta: SnapshotMeta): string {
  const levels = meta.levels?.length ? meta.levels.join('-').toLowerCase() : 'all-levels';
  const tag = meta.cache ? '_cache' : '';
  return `${localStamp(meta.from)}_${localStamp(meta.to)}_${safe(meta.service || 'all-services')}_${safe(levels)}${tag}`;
}

/** Splits [from, to) into windows of at most windowMs, so a long range is fetched one window at a time. */
export function timeWindows(from: string, to: string, windowMs = DAY_MS): Array<{ from: string; to: string }> {
  const windows: Array<{ from: string; to: string }> = [];
  const end = Date.parse(to);
  for (let start = Date.parse(from); start < end; start += windowMs) {
    windows.push({ from: new Date(start).toISOString(), to: new Date(Math.min(start + windowMs, end)).toISOString() });
  }
  return windows;
}

/** Rows one fetch window holds in memory. Measured on DEV: 411k rows of a wide stream (~160 fields) overflowed a 4 GB heap. */
// ponytail: sized from the average rate; a burst window can hold more. Lower it if an export runs out of memory.
const ROWS_PER_WINDOW = 250_000;

/** Largest fetch window (24h, 6h, 1h, else 15m) whose expected share of `estimatedRows` fits ROWS_PER_WINDOW. */
export function fetchWindowMs(estimatedRows: number, from: string, to: string): number {
  const range = Math.max(Date.parse(to) - Date.parse(from), 1);
  return [DAY_MS, 6 * HOUR_MS, HOUR_MS].find((ms) => estimatedRows * Math.min(ms, range) / range <= ROWS_PER_WINDOW) ?? 15 * 60_000;
}
