/** Reading saved exports: list folders, open one file through the access check, and find rows already saved. */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { AI_CONTEXT_DIR } from '../config.js';
import { LogEntry, LogLevel } from '../types.js';
import { logger } from '../utils/logger.js';
import { startExport } from './export-folder.js';
import { LHUB, LhubHeader, readLhub, readLhubHeader } from './lhub.js';
import { SnapshotMeta, compact, queryKey, safe, snapshotParent, toPosix, uncompact } from './model.js';

/**
 * Absolute path of an export folder given relative to baseDir. Errors name only the relative folder: tool results never
 * show where ai-context lives on disk.
 */
export function exportDir(snapshot: string, baseDir = AI_CONTEXT_DIR): string {
  const root = resolve(baseDir);
  const dir = resolve(root, snapshot);
  if (!dir.startsWith(root + sep) || !existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`Export folder not found inside ai-context/: ${snapshot}`);
  return dir;
}

/** Every .lhub file of an export folder, as paths relative to it (SUMMARY first). */
export function snapshotFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true }).map((f) => toPosix(String(f))).filter((f) => f.endsWith(LHUB))
    .sort((a, b) => Number(b === 'SUMMARY.lhub') - Number(a === 'SUMMARY.lhub') || a.localeCompare(b));
}

/** Every export folder under baseDir (finished or `_partial`), newest first, with its SUMMARY header when finished. */
export function listSnapshots(baseDir = AI_CONTEXT_DIR, includeCache = false): Array<{ snapshot: string; header?: LhubHeader; partial: boolean; files: number }> {
  if (!existsSync(baseDir)) return [];
  const out: Array<{ snapshot: string; header?: LhubHeader; partial: boolean; files: number; at: number }> = [];
  for (const file of readdirSync(baseDir, { recursive: true }).map(String)) {
    if (!includeCache && file.includes('_cache')) continue;
    const dir = join(baseDir, file);
    if (!/^\d{8}-\d{4}_\d{8}-\d{4}_/.test(file.split(sep).pop()!) || !statSync(dir).isDirectory()) continue;
    out.push({ snapshot: toPosix(file), header: summaryHeader(dir), partial: file.endsWith('_partial'), files: snapshotFiles(dir).length, at: statSync(dir).mtimeMs });
  }
  return out.sort((a, b) => b.at - a.at).map(({ at: _at, ...rest }) => rest);
}

function summaryHeader(dir: string): LhubHeader | undefined {
  const summary = join(dir, 'SUMMARY.lhub');
  try {
    return existsSync(summary) ? readLhubHeader(summary) : undefined;
  } catch {
    return undefined; // not readable
  }
}

/** The last decrypted file, kept for paging; released after CACHE_IDLE_MS so an idle MCP server holds no log text. */
let opened: { path: string; mtime: number; text: string } | undefined;
let release: ReturnType<typeof setTimeout> | undefined;
const CACHE_IDLE_MS = 5 * 60_000;

function keepOpened(path: string, mtime: number, read: () => string): string {
  if (opened?.path !== path || opened.mtime !== mtime) opened = { path, mtime, text: read() };
  clearTimeout(release);
  release = setTimeout(() => { opened = undefined; }, CACHE_IDLE_MS);
  release.unref?.(); // never keeps the process alive
  return opened.text;
}

/**
 * One file of an export folder: resolves both paths inside baseDir, asks `keyFor` for the organization key (the access
 * check, run on every call) and decrypts only that file. The last file read stays in memory for paging (see keepOpened).
 * `file` may omit the .lhub extension.
 */
export async function openSnapshot(snapshot: string, file: string | undefined, keyFor: (header: LhubHeader) => Promise<string>, baseDir = AI_CONTEXT_DIR): Promise<{ header: LhubHeader; text: string; file: string }> {
  const dir = exportDir(snapshot, baseDir);
  const name = (file || 'SUMMARY.lhub').replace(/(\.lhub)?$/i, LHUB);
  const path = resolve(dir, name);
  if (!path.startsWith(dir + sep)) throw new Error('file must be inside the export folder');
  if (!existsSync(path)) {
    const files = snapshotFiles(dir);
    throw new Error(`No file '${name}' in this export. Files: ${files.slice(0, 50).join(', ')}${files.length > 50 ? ` +${files.length - 50} more` : ''}`);
  }
  const header = readLhubHeader(path);
  const key = await keyFor(header);
  const text = keepOpened(path, statSync(path).mtimeMs, () => readLhub(path, key).text);
  return { header, text, file: toPosix(relative(dir, path)) };
}

const lineHash = (line: string) => createHash('sha1').update(line).digest('base64');

/**
 * Drops entries already saved by an earlier export of the same stream (any service/level), so overlapping scans
 * (14h→18h, then 16h→20h) only keep new rows. A row is a duplicate when its compact JSONL line is identical.
 * Only frames overlapping `window` are decrypted, and only line hashes are kept in memory.
 */
// ponytail: re-reads overlapping frames every window; keep a per-stream hash index if ai-context grows large.
export function dropExported(entries: LogEntry[], meta: SnapshotMeta, orgKey: string, window: { from: string; to: string } = meta, baseDir = AI_CONTEXT_DIR): { fresh: LogEntry[]; duplicates: number; seenIn: string[] } {
  const parent = snapshotParent(meta, baseDir);
  const range = { from: Date.parse(window.from), to: Date.parse(window.to) };
  const seen = new Set<string>();
  const seenIn: string[] = [];
  for (const name of existsSync(parent) ? readdirSync(parent) : []) {
    if (name.includes('_cache')) continue;
    if (addSavedLines(join(parent, name, 'services'), orgKey, range, seen)) seenIn.push(name);
  }
  const fresh = seen.size ? entries.filter((entry) => !seen.has(lineHash(JSON.stringify(compact(entry))))) : entries;
  return { fresh, duplicates: entries.length - fresh.length, seenIn };
}

/** Adds the hash of every line saved under `services` within `range` to `seen`; true when any was found. */
function addSavedLines(services: string, orgKey: string, range: { from: number; to: number }, seen: Set<string>): boolean {
  if (!existsSync(services)) return false;
  let found = false;
  for (const file of readdirSync(services, { recursive: true }).map(String).filter((f) => f.endsWith(LHUB))) {
    try {
      for (const line of readLhub(join(services, file), orgKey, range).text.split('\n')) if (line) { seen.add(lineHash(line)); found = true; }
    } catch { /* another organization's key or an unreadable file */ }
  }
  return found;
}


/**
 * Checks ai-context for cached logs matching an RCID.
 */
export function findCachedRcid(stream: string, rcid: string, orgKey: string, baseDir = AI_CONTEXT_DIR): LogEntry[] | undefined {
  if (!rcid) return undefined;
  const target = safe(rcid);
  const snapshots = listSnapshots(baseDir, true).filter((s) => !s.partial && (!s.header || s.header.stream === stream));
  for (const { snapshot } of snapshots) {
    try {
      const dir = exportDir(snapshot, baseDir);
      const rcidDir = join(dir, 'rcid');
      if (!existsSync(rcidDir)) continue;
      const file = readdirSync(rcidDir).find((f) => f.endsWith(LHUB) && f.includes(target));
      if (file) {
        const { text } = readLhub(join(rcidDir, file), orgKey);
        const entries: LogEntry[] = [];
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          try {
            entries.push(uncompact(JSON.parse(line)));
          } catch { /* skip unparseable */ }
        }
        if (entries.length) return entries;
      }
    } catch { /* unreadable with this orgKey or corrupt */ }
  }
  return undefined;
}

/**
 * Checks ai-context for cached logs covering a service and time range.
 */
export function findCachedLogs(params: { stream: string; service?: string; levels?: LogLevel[]; from: string; to: string }, orgKey: string, baseDir = AI_CONTEXT_DIR): LogEntry[] | undefined {
  const fromMs = Date.parse(params.from);
  const toMs = Date.parse(params.to);
  if (isNaN(fromMs) || isNaN(toMs)) return undefined;

  const targetLevels = params.levels ? new Set(params.levels.map((l) => l.toLowerCase())) : undefined;
  const snapshots = listSnapshots(baseDir, true).filter((s) => !s.partial && s.header && s.header.stream === params.stream);

  for (const { snapshot, header } of snapshots) {
    if (!header) continue;
    const snapFrom = Date.parse(header.from);
    const snapTo = Date.parse(header.to);
    if (isNaN(snapFrom) || isNaN(snapTo) || snapFrom > fromMs || snapTo < toMs) continue;
    if (params.service && header.service && header.service !== 'all-services' && header.service !== params.service) continue;

    try {
      const dir = exportDir(snapshot, baseDir);
      const servicesDir = join(dir, 'services');
      if (!existsSync(servicesDir)) continue;

      const svcDirs = params.service ? [join(servicesDir, safe(params.service))] : readdirSync(servicesDir).map((d) => join(servicesDir, d));
      const entries: LogEntry[] = [];

      for (const svcDir of svcDirs) {
        if (!existsSync(svcDir) || !statSync(svcDir).isDirectory()) continue;
        const files = readdirSync(svcDir).filter((f) => f.endsWith(LHUB));
        for (const file of files) {
          const levelName = file.replace(/\.lhub$/i, '').toLowerCase();
          if (targetLevels && !targetLevels.has(levelName)) continue;
          const { text } = readLhub(join(svcDir, file), orgKey, { from: fromMs, to: toMs });
          for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            try {
              const entry = uncompact(JSON.parse(line));
              const ts = Date.parse(entry.timestamp);
              if (ts >= fromMs && ts <= toMs) entries.push(entry);
            } catch { /* skip unparseable */ }
          }
        }
      }

      entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      return entries;
    } catch { /* unreadable with this orgKey */ }
  }
  return undefined;
}

/**
 * Rows of the newest cached SQL search with the same env, normalized SQL and absolute window (see queryKey), cut to
 * `limit`. A cache saved with a smaller limit only answers when it held every row (rows < its limit).
 */
export function findCachedQuery(search: { env?: string; sql: string; from: string; to: string }, limit: number, orgKey: string, baseDir = AI_CONTEXT_DIR): LogEntry[] | undefined {
  const key = queryKey(search, orgKey);
  for (const { snapshot, header } of listSnapshots(baseDir, true)) {
    if (!header || header.query !== key || header.limit === undefined) continue;
    if (limit > header.limit && (header.rows ?? 0) >= header.limit) continue;
    try {
      const { text } = readLhub(join(exportDir(snapshot, baseDir), 'query.lhub'), orgKey);
      return text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as LogEntry).slice(0, limit);
    } catch { /* missing, unreadable with this orgKey or corrupt */ }
  }
  return undefined;
}

/**
 * Clones fetched logs to an ai-context snapshot so future calls hit local cache. With `meta.sql` the rows are also kept
 * in result order in query.lhub, for findCachedQuery.
 */
export function cloneLogsToAiContext(meta: SnapshotMeta, orgKey: string, logs: LogEntry[], baseDir = AI_CONTEXT_DIR): string | undefined {
  if (!logs.length) return undefined;
  try {
    const out = startExport({ ...meta, cache: true }, { orgKey, baseDir });
    out.addWindow(logs, { from: meta.from, to: meta.to });
    if (meta.sql) out.addQuery(logs);
    const result = out.finish();
    logger.info('ai_context.cloned_logs', { snapshot: result.snapshot, rows: logs.length });
    return result.snapshot;
  } catch (err) {
    logger.warn('ai_context.clone_logs_failed', { errorType: err instanceof Error ? err.name : 'UnknownError' });
    return undefined;
  }
}

/**
 * Clones fetched RCID flow logs to an ai-context snapshot.
 */
export function cloneRcidToAiContext(meta: SnapshotMeta, orgKey: string, rcid: string, field = 'rcid', logs: LogEntry[], baseDir = AI_CONTEXT_DIR): string | undefined {
  if (!logs.length) return undefined;
  try {
    const out = startExport({ ...meta, service: safe(`rcid-${rcid}`), cache: true }, { orgKey, baseDir });
    out.addFlows([{ field, value: rcid, entries: logs }]);
    const result = out.finish();
    logger.info('ai_context.cloned_rcid', { snapshot: result.snapshot, rows: logs.length });
    return result.snapshot;
  } catch (err) {
    logger.warn('ai_context.clone_rcid_failed', { errorType: err instanceof Error ? err.name : 'UnknownError' });
    return undefined;
  }
}
