/**
 * Core type definitions for mcp-server-logs
 */

/** Ordered from least to most severe. */
export const LOG_LEVELS = ['Verbose', 'Debug', 'Information', 'Warning', 'Error', 'Fatal'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface LogQuery {
  /** Search text, keyword, or provider-native query filter */
  query?: string;
  /** ISO 8601 timestamp or relative expression (e.g. '15m', '1h', '24h', '7d') */
  from?: string;
  /** ISO 8601 timestamp or end bound */
  to?: string;
  /** Maximum number of records to return (default: 50, max: 500) */
  limit?: number;
  /** One level = minimum severity; an array = exactly those levels */
  level?: LogLevel | LogLevel[];
  /** OpenObserve organization identifier */
  organization?: string;
  /** OpenObserve log stream */
  stream?: string;
}

export interface LogEntry {
  /** ISO 8601 formatted event timestamp */
  timestamp: string;
  /** Standardized log level */
  level: LogLevel | string;
  /** Rendered human-readable log message */
  message: string;
  /** Identifier of the provider that produced this log (e.g. 'seq', 'openobserve') */
  provider: string;
  /** Service that emitted the log, when the provider can tell (e.g. OpenObserve service_name or Kubernetes deployment) */
  service?: string;
  /** Raw or structured contextual properties */
  metadata?: Record<string, unknown>;
}

/** Every log sharing one correlation id (e.g. rcid or trace_id) across services: one request end to end. */
export interface RequestFlow {
  field: string;
  value: string;
  entries: LogEntry[];
}

/**
 * Server-side counts of what an export did not download row by row (framework noise) plus HTTP request totals.
 * See docs/OPENOBSERVE_GUIDE.md "What an export keeps and what it skips".
 */
export interface ExportAggregates {
  /** Framework noise rows counted but not downloaded, by service, level, logger category and hour (UTC) */
  noise: Array<{ service: string; level: string; category: string; hour: string; n: number }>;
  /** Most frequent framework noise messages */
  templates: Array<{ category: string; template: string; n: number; firstSeen: string; lastSeen: string }>;
  /** HTTP requests in the range (every row with a status code, noise included) */
  http: Array<{ path: string; method: string; status: string; n: number; avgMs: number; maxMs: number }>;
}

export interface ProviderStatus {
  name: string;
  configured: boolean;
  endpoint?: string;
  missingVariables?: string[];
  details?: string;
}

export interface LogProvider {
  readonly name: string;
  getStatus(): ProviderStatus;
  queryLogs(params: LogQuery): Promise<LogEntry[]>;
}
