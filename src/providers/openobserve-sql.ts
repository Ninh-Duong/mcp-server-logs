/** Pure SQL and stream-shape helpers of the OpenObserve provider: quoting, noise filter, columns, service/level fields. */
import { LogLevel } from '../types.js';
import { normalizeLogLevel } from './base.js';

export interface OpenObserveField { name: string; type: string }

/**
 * Framework and library loggers whose Information/Debug/Verbose rows an export only counts (their warnings and errors
 * are kept). Measured over 24h: 80-88% of DEV rows; on PROD shop_prod 7.3M rows → 1.54M left to download.
 * They stay whole inside request flows. Patterns use SQL LIKE.
 * Keep in sync with docs/OPENOBSERVE_GUIDE.md "What an export keeps and what it skips".
 */
export const NOISE_CATEGORIES = [
  'Microsoft.AspNetCore.Hosting.%', // Request starting / Request finished
  'Microsoft.AspNetCore.Routing.%', // Executing / Executed endpoint
  'Microsoft.AspNetCore.Mvc.Infrastructure.%', // Executing action / result
  'Microsoft.AspNetCore.Cors.%', // CORS policy execution
  'Microsoft.EntityFrameworkCore.Database.Command', // Executed DbCommand (SQL text)
  'System.Net.Http.HttpClient.%', // outgoing HTTP start/end, OTLP exporter
  'Ocelot.%', // API gateway middleware steps
  'Grpc.%', // gRPC client/server call internals (GrpcCall, RetryCall, ServerCallHandler)
  'MassTransit.%', // message bus send/receive (MassTransit.Messages)
  'Elsa.%', // workflow engine internals (LogWorkflowExecution, DistributedLockProvider, BookmarkIndexer)
];
/** Levels a noise row can have; anything more severe is always downloaded. */
export const QUIET_LEVELS = ['Information', 'Debug', 'Verbose', 'Trace'].flatMap((l) => [l, l.toLowerCase()]);
/** Fields that are constant per stream or SDK metadata: never selected. */
export const DROP_FIELDS = new Set([
  'telemetry_sdk_version', 'telemetry_sdk_name', 'telemetry_sdk_language', 'dropped_attributes_count', 'environment',
  'deployment_environment', 'aspnetcore_namespace', 'processname', 'processid', 'threadid', 'newline', 'commandtype',
  'commandtimeout', 'protocol', 'scheme', 'service_version', 'application',
]);

export const quoteIdentifier = (value: string) => `"${value.replace(/"/g, '""')}"`;
export const quoteString = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** Kubernetes pod "shop-api-5c67fbd785-lcm4v" -> deployment "shop-api". */
export const deploymentName = (pod: string): string => pod.replace(/-[a-z0-9]{6,10}-[a-z0-9]{5}$/, '');

export const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

/** Level from free-text log lines such as "[NestWinston] ... \x1b[32mINFO\x1b[39m [Service] message". */
export function levelFromText(text: unknown): LogLevel {
  const head = stripAnsi(String(text ?? '')).slice(0, 120);
  return normalizeLogLevel(head.match(/\b(verbose|trace|debug|info|warn|error|fatal|crit)/i)?.[1]);
}

/** Same field priority as detectShape: service_name, applicationname, then Kubernetes deployment. */
export function serviceOf(row: Record<string, unknown>): string | undefined {
  const named = row.service_name || row.applicationname;
  if (named) return String(named);
  return row.kubernetes_pod_name ? deploymentName(String(row.kubernetes_pod_name)) : undefined;
}

/** Words searched in raw `log` text for streams without a level field. */
export const LEVEL_WORDS: Record<LogLevel, string[]> = {
  Verbose: ['verbose', 'trace'], Debug: ['debug'], Information: ['info'], Warning: ['warn'], Error: ['error'], Fatal: ['fatal', 'crit'],
};

/** Where the service and level live in a stream: structured fields, or Kubernetes pod name + log text. */
export function detectShape(fields: OpenObserveField[]): { serviceField?: string; levelField?: string; k8s: boolean } {
  const names = new Set(fields.map((f) => f.name));
  const levelField = ['severity', 'level'].find((n) => names.has(n));
  const structured = ['service_name', 'applicationname'].find((n) => names.has(n));
  if (structured) return { serviceField: structured, levelField, k8s: false };
  if (names.has('kubernetes_pod_name')) return { serviceField: 'kubernetes_pod_name', levelField, k8s: true };
  return { k8s: false };
}

/** SQL matching framework noise rows (NULL-safe), or undefined when the stream has no logger category and level. */
export function noiseWhere(names: Set<string>, levelField?: string): string | undefined {
  if (!levelField || !names.has('instrumentation_library_name')) return undefined;
  const category = `COALESCE("instrumentation_library_name", '')`;
  const kinds = NOISE_CATEGORIES.map((c) => `${category} ${c.includes('%') ? 'LIKE' : '='} ${quoteString(c)}`);
  if (names.has('endpointname')) kinds.unshift(`COALESCE("endpointname", '') = 'Health checks'`);
  if (names.has('path')) kinds.unshift(`COALESCE("path", '') LIKE '/health-checks/%'`);
  return `(COALESCE(${quoteIdentifier(levelField)}, '') IN (${QUIET_LEVELS.map(quoteString).join(', ')}) AND (${kinds.join(' OR ')}))`;
}

/** Column list without DROP_FIELDS (`*` when the stream has none of them). */
export function selectColumns(names: string[]): string {
  const kept = names.filter((name) => !DROP_FIELDS.has(name));
  return kept.length === names.length ? '*' : kept.map(quoteIdentifier).join(', ');
}
