import { LOG_LEVELS, LogLevel } from '../types.js';

/** Raw level names emitted by common loggers (Serilog, NLog, MEL, etc.) */
export const LEVEL_ALIASES: Record<LogLevel, string[]> = {
  Verbose: ['Verbose', 'Trace', 'VRB', 'TRC'],
  Debug: ['Debug', 'DBG'],
  Information: ['Information', 'Info', 'INF'],
  Warning: ['Warning', 'Warn', 'WRN'],
  Error: ['Error', 'ERR'],
  Fatal: ['Fatal', 'Critical', 'FTL', 'CRT'],
};

/** Lower-cased alias → level, so short names such as WRN or DBG are not mistaken for Information. */
const ALIAS_LEVEL = new Map(Object.entries(LEVEL_ALIASES).flatMap(([level, aliases]) => aliases.map((a) => [a.toLowerCase(), level as LogLevel])));

/** Correlation fields that tie logs of one request together, in the order used to pick a flow id. */
export const FLOW_ID_FIELDS = ['rcid', 'correlationid', 'trace_id', 'traceid'];

/**
 * Expands a level filter: one level means "this or more severe", an array means exactly those levels
 */
export function resolveLevels(level?: LogLevel | LogLevel[]): LogLevel[] | undefined {
  if (!level) return undefined;
  return Array.isArray(level) ? level : LOG_LEVELS.slice(LOG_LEVELS.indexOf(level));
}

/**
 * Normalizes provider-specific log levels into unified LogLevel type
 */
export function normalizeLogLevel(raw: string | undefined): LogLevel {
  if (!raw) return 'Information';
  const val = raw.toLowerCase().trim();
  const alias = ALIAS_LEVEL.get(val);
  if (alias) return alias;

  if (val.includes('fatal') || val.includes('emerg') || val.includes('crit')) return 'Fatal';
  if (val.includes('err')) return 'Error';
  if (val.includes('warn')) return 'Warning';
  if (val.includes('deb')) return 'Debug';
  if (val.includes('verb') || val.includes('trace')) return 'Verbose';
  return 'Information';
}

/**
 * Parses time expressions such as '15m', '1h', '24h', '7d' (that long before `now`) into an ISO 8601 UTC date string
 */
export function parseTimeBound(input?: string, now = Date.now()): string | undefined {
  if (!input) return undefined;

  // If already an ISO string
  if (input.includes('T') || input.includes('-')) {
    const d = new Date(input);
    if (!isNaN(d.getTime())) return d.toISOString();
  }

  // Relative notation: e.g. "15m", "2h", "1d"
  const match = input.trim().match(/^(\d+)\s*(m|h|d|w)$/i);
  if (match) {
    const count = parseInt(match[1] || '0', 10);
    const unit = (match[2] || '').toLowerCase();
    let ms = 0;
    if (unit === 'm') ms = count * 60 * 1000;
    else if (unit === 'h') ms = count * 3600 * 1000;
    else if (unit === 'd') ms = count * 86400 * 1000;
    else if (unit === 'w') ms = count * 7 * 86400 * 1000;

    return new Date(now - ms).toISOString();
  }

  return undefined;
}

const MINUTE_MS = 60_000;
const RELATIVE = /^\s*\d+\s*[mhdw]\s*$/i;

/**
 * Absolute bounds of an OpenObserve search. Relative values ('15m') and the default end (now) count from the start of
 * the current minute, so repeated searches within one minute share one window (and one ai-context cache key); the
 * newest < 1 minute of logs shows up from the next minute on. ISO values are kept as given. When `from` is an ISO time
 * inside the current minute, the end stays now instead of the minute start.
 */
export function searchWindow(from: string | undefined, to: string | undefined, defaultFrom: string, now = Date.now()): { from?: string; to?: string } {
  const minute = Math.floor(now / MINUTE_MS) * MINUTE_MS;
  const bound = (value: string) => parseTimeBound(value, RELATIVE.test(value) ? minute : now);
  const start = bound(from || defaultFrom);
  if (to) return { from: start, to: bound(to) };
  return { from: start, to: new Date(start && Date.parse(start) >= minute ? now : minute).toISOString() };
}
