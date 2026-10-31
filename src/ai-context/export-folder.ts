/**
 * Writes one export folder:
 *   ai-context/INDEX.md   one line per export, newest first
 *   ai-context/<provider>/<env>/<org>/<stream>/<from>_<to>_<service>_<levels>_<rows>/   (times in AI_CONTEXT_TIME_ZONE)
 *     SUMMARY.lhub                    counts, patterns, bugs, noise and HTTP tables for the whole export (read first)
 *     patterns.lhub, manifest.lhub    every pattern; query parameters, aggregates and flow list
 *     services/<service>/<level>.lhub one compact log per line, oldest first
 *     rcid/<field>-<id>.lhub          one failing request end to end (optional)
 *     query.lhub                      a cached SQL search: its LogEntry rows in result order (optional; SUMMARY header has its queryKey)
 * Folder and file names are plaintext; every file's content is encrypted (see lhub.ts).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { AI_CONTEXT_DIR } from '../config.js';
import { ExportAggregates, LogEntry, RequestFlow } from '../types.js';
import { LHUB, LhubFile, LhubHeaderInput, appendFrame, createLhub, writeLhub } from './lhub.js';
import {
  ErrorId, ExportResult, FlowRow, Pattern, SnapshotMeta, compact, errorIdOf, exportLabel, messageTemplate, patternOf, pickIds, queryKey, safe,
  snapshotParent, toPosix,
} from './model.js';
import { mergeAggregates, noiseRows, rankPatterns, renderSummary } from './summary.js';

export interface ExportOptions {
  /** Identifier of the export's organization; it encrypts every .lhub file */
  orgKey: string;
  baseDir?: string;
}

/** Everything an export carries across windows; only the current window's rows are ever in memory. */
interface ExportState {
  meta: SnapshotMeta;
  orgKey: string;
  baseDir: string;
  parent: string;
  dir: string;
  common: Omit<LhubHeaderInput, 'kind'>;
  files: Map<string, LhubFile>;
  patterns: Map<string, Pattern>;
  /** service → level → rows */
  counts: Map<string, Map<string, number>>;
  errorIds: ErrorId[];
  /** Server-side counts summed over windows; absent for exports without them (custom SQL, one rcid). */
  aggregates?: ExportAggregates;
  flowRows: FlowRow[];
  rows: number;
  duplicates: number;
  truncated: boolean;
  inferredLevels: boolean;
  /** query.lhub was written (a cached SQL search) */
  query: boolean;
}

const INDEX_HEADER = '# ai-context index\n\nNewest first. Each line is one export folder; its files are encrypted .lhub files: read them with the read_ai_context MCP tool (SUMMARY.lhub first; it points to the exact log lines worth reading). Reading needs an OpenObserve account for the export\'s environment that is enabled for its organization.\n\n';
/** Flows longer than FLOW_MAX_LINES keep FLOW_BEFORE lines before the first error and FLOW_AFTER from it. */
const FLOW_MAX_LINES = 500;
const FLOW_BEFORE = 400;
const FLOW_AFTER = 100;

/**
 * Starts an export folder (`..._partial` until finish). Call addWindow once per fetch window (oldest first), then
 * flowIds/addFlows for request flows, then finish to write SUMMARY/patterns/manifest and rename the folder with
 * its row count. Counts and patterns are carried across windows.
 */
export function startExport(meta: SnapshotMeta, { orgKey, baseDir = AI_CONTEXT_DIR }: ExportOptions) {
  const state = openExport(meta, orgKey, baseDir);
  return {
    dir: state.dir,
    /** Appends one window's rows (deduplicated by the caller) to services/<service>/<level>.lhub and counts them. */
    addWindow: (entries: LogEntry[], window: { from: string; to: string }, aggregates?: ExportAggregates, duplicates = 0) =>
      addWindow(state, entries, window, aggregates, duplicates),
    /** Correlation ids of failing logs across the whole export (most frequent bug first), with a recent timestamp each. */
    flowIds: (max = 200) => pickIds(state.errorIds, max),
    /** Writes each flow to rcid/<field>-<value>.lhub (one request end to end, oldest first). */
    addFlows: (flows: RequestFlow[]) => addFlows(state, flows),
    /** Writes query.lhub: the rows of meta.sql exactly as the search returned them, so a repeat search is answered from it. */
    addQuery: (entries: LogEntry[]) => addQuery(state, entries),
    /** Writes SUMMARY/patterns/manifest, adds the INDEX.md line and renames the folder to ..._<rows>. */
    finish: () => finish(state),
  };
}

function openExport(meta: SnapshotMeta, orgKey: string, baseDir: string): ExportState {
  if (!orgKey) throw new Error('Organization key is required to write a snapshot');
  const parent = snapshotParent(meta, baseDir);
  const label = exportLabel(meta);
  let dir = join(parent, `${label}_partial`);
  for (let n = 2; existsSync(dir); n++) dir = join(parent, `${label}-${n}_partial`);
  mkdirSync(dir, { recursive: true });
  return {
    meta, orgKey, baseDir, parent, dir,
    common: { provider: meta.provider, env: meta.env, organization: meta.organization, stream: meta.stream, from: meta.from, to: meta.to },
    files: new Map(), patterns: new Map(), counts: new Map(), errorIds: [], flowRows: [],
    rows: 0, duplicates: 0, truncated: false, inferredLevels: false, query: false,
  };
}

function addWindow(state: ExportState, entries: LogEntry[], window: { from: string; to: string }, aggregates: ExportAggregates | undefined, duplicates: number): void {
  // services/<service>/<level>.lhub → this window's lines for it
  const byFile = new Map<string, { header: LhubHeaderInput; lines: string[] }>();
  for (const entry of [...entries].sort((a, b) => a.timestamp.localeCompare(b.timestamp))) {
    const { level, service } = patternOf(entry);
    const rel = `services/${safe(service)}/${safe(level.toLowerCase())}${LHUB}`;
    const pending = byFile.get(rel) ?? { header: { kind: 'logs', ...state.common, service, level }, lines: [] };
    pending.lines.push(JSON.stringify(compact(entry)));
    byFile.set(rel, pending);
    countEntry(state, entry, rel, pending.lines.length);
  }
  // One frame per file per window; its lines are dropped right after compression.
  for (const [rel, { header, lines }] of byFile) {
    const file = fileFor(state, rel, header);
    appendFrame(file, lines.join('\n') + '\n', Date.parse(window.from), Date.parse(window.to));
    file.lines += lines.length;
    byFile.delete(rel);
  }
  state.rows += entries.length;
  state.duplicates += duplicates;
  if (entries.length + duplicates >= state.meta.limit) state.truncated = true;
  if (aggregates) mergeAggregates(state.aggregates ??= { noise: [], templates: [], http: [] }, aggregates);
}

function fileFor(state: ExportState, rel: string, header: LhubHeaderInput): LhubFile {
  let file = state.files.get(rel);
  if (!file) state.files.set(rel, file = createLhub(join(state.dir, rel), header, state.orgKey));
  return file;
}

/** Counts, pattern and error id of one entry; `lineInWindow` is its line among this window's lines of `rel`. */
function countEntry(state: ExportState, entry: LogEntry, rel: string, lineInWindow: number): void {
  const { key, template, level, service } = patternOf(entry);
  const byLevel = state.counts.get(service) ?? new Map<string, number>();
  byLevel.set(level, (byLevel.get(level) ?? 0) + 1);
  state.counts.set(service, byLevel);
  const pattern = state.patterns.get(key);
  if (pattern) {
    pattern.count++;
    pattern.lastSeen = entry.timestamp;
  } else {
    const line = (state.files.get(rel)?.lines ?? 0) + lineInWindow;
    state.patterns.set(key, { template, level, service, count: 1, firstSeen: entry.timestamp, lastSeen: entry.timestamp, example: `${rel}:${line}` });
  }
  const id = errorIdOf(entry);
  if (id) state.errorIds.push(id);
  if (!entry.metadata?.severity && !entry.metadata?.level) state.inferredLevels = true;
}

function addFlows(state: ExportState, flows: RequestFlow[]): void {
  const keyOf = new Map<string, string>();
  for (const id of state.errorIds) if (!keyOf.has(id.value)) keyOf.set(id.value, id.key);
  for (const flow of flows.filter((f) => f.entries.length)) state.flowRows.push(writeFlow(state, flow, keyOf.get(flow.value)));
}

/** Writes one flow file, trimmed around its first failure when long, and returns its row for SUMMARY/manifest. */
function writeFlow(state: ExportState, flow: RequestFlow, patternKey: string | undefined): FlowRow {
  const timeline = [...flow.entries].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const failures = timeline.filter((entry) => entry.level === 'Error' || entry.level === 'Fatal');
  const first = failures[0];
  // Long-running jobs share one id for thousands of lines; keep the lead-up to the first failure and its aftermath.
  const at = first ? timeline.indexOf(first) : timeline.length - 1;
  const kept = timeline.length > FLOW_MAX_LINES ? timeline.slice(Math.max(0, at - FLOW_BEFORE), at + FLOW_AFTER) : timeline;
  const rel = `rcid/${safe(flow.field)}-${safe(flow.value)}${LHUB}`;
  const start = Date.parse(timeline[0]!.timestamp);
  const end = Date.parse(timeline[timeline.length - 1]!.timestamp);
  writeLhub(join(state.dir, rel), { kind: 'flow', ...state.common }, state.orgKey, kept.map((entry) => JSON.stringify(compact(entry))).join('\n') + '\n', start, end);
  return {
    id: `${flow.field}=${flow.value}`, file: rel, errors: failures.length, durationMs: end - start,
    rows: kept.length === timeline.length ? `${timeline.length}` : `${kept.length} of ${timeline.length} (trimmed around first error)`,
    path: [...new Set(timeline.map((entry) => entry.service || '_unknown'))].join(' → '),
    patternKey: patternKey ?? (first ? patternOf(first).key : undefined),
    firstFailure: first ? `${first.service || '_unknown'}: ${messageTemplate(first.message)}` : undefined,
  };
}

function addQuery(state: ExportState, entries: LogEntry[]): void {
  const text = entries.map((entry) => JSON.stringify(entry) + '\n').join('');
  writeLhub(join(state.dir, 'query.lhub'), { kind: 'query', ...state.common }, state.orgKey, text, Date.parse(state.meta.from), Date.parse(state.meta.to));
  state.query = true;
}

function finish(state: ExportState): ExportResult {
  const { meta, flowRows } = state;
  const createdAt = new Date().toISOString();
  const ranked = rankPatterns(state.patterns.values());
  const patternNumber = new Map(ranked.map((p, i) => [`${p.level}|${p.service}|${p.template}`, i + 1]));
  for (const flow of flowRows) flow.pattern = flow.patternKey ? patternNumber.get(flow.patternKey) : undefined;
  // Flow-only exports (one rcid) are named and counted by their flow rows.
  const total = state.rows || flowRows.reduce((n, f) => n + Number(f.rows.split(' ')[0]), 0);
  const note = state.inferredLevels ? 'Some levels are inferred from log text (stream has no level field).' : '';

  const write = (rel: string, kind: LhubHeaderInput['kind'], text: string, extra: Partial<LhubHeaderInput> = {}) =>
    writeLhub(join(state.dir, rel), { kind, ...state.common, ...extra }, state.orgKey, text, Date.parse(meta.from), Date.parse(meta.to));
  write('patterns.lhub', 'patterns', JSON.stringify(ranked, null, 2) + '\n');
  write('manifest.lhub', 'manifest', JSON.stringify({
    ...meta, rows: state.rows, duplicates: state.duplicates, truncated: state.truncated, patterns: ranked.length,
    aggregates: state.aggregates, flows: flowRows.map(({ patternKey: _key, ...flow }) => flow), createdAt,
  }, null, 2) + '\n');
  const query = state.query ? { query: queryKey({ ...meta, sql: meta.sql! }, state.orgKey), limit: meta.limit } : {};
  write('SUMMARY.lhub', 'summary', renderSummary({ ...state, note, createdAt, ranked }), { service: meta.service, rows: total, ...query });

  const finalDir = renameFinished(state, total);
  const snapshot = toPosix(relative(state.baseDir, finalDir));
  if (!state.meta.cache) prependIndexLine(state, snapshot, total, createdAt);
  return { dir: finalDir, snapshot, rows: total, duplicates: state.duplicates, flows: flowRows.length, truncated: state.truncated };
}

/** Renames ..._partial to ..._<rows>; an export with the same name (e.g. skip_duplicates off) is numbered instead of failing. */
function renameFinished(state: ExportState, total: number): string {
  const name = state.dir.slice(state.parent.length + 1).replace(/_partial$/, '');
  let finalDir = join(state.parent, `${name}_${total}`);
  for (let n = 2; existsSync(finalDir); n++) finalDir = join(state.parent, `${name}-${n}_${total}`);
  renameSync(state.dir, finalDir);
  return finalDir;
}

/** Prepends to INDEX.md so the newest export is first; lines of deleted folders are dropped. */
function prependIndexLine(state: ExportState, snapshot: string, total: number, createdAt: string): void {
  const { meta, baseDir, duplicates, flowRows, truncated } = state;
  const indexPath = join(baseDir, 'INDEX.md');
  const previous = existsSync(indexPath) ? (readFileSync(indexPath, 'utf8').match(/^- .*$/gm) ?? [])
    .filter((l) => existsSync(join(baseDir, l.match(/→ `([^`]+)`$/)?.[1] ?? '\0'))).map((l) => l + '\n').join('') : '';
  const noise = noiseRows(state.aggregates);
  const line = `- ${createdAt.slice(0, 16)}Z · ${meta.provider}/${meta.env || 'default'}/${meta.organization}/${meta.stream} · ${meta.service || 'all services'} · ${meta.levels?.join(',') || 'all levels'} · ${meta.from} → ${meta.to} · ${total} rows${duplicates ? ` · ${duplicates} dup` : ''}${noise ? ` · ${noise} noise counted` : ''}${flowRows.length ? ` · ${flowRows.length} flows` : ''}${truncated ? ' (truncated)' : ''} → \`${snapshot}\`\n`;
  writeFileSync(indexPath, INDEX_HEADER + line + previous, 'utf8');
}
