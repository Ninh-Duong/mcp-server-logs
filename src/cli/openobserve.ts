/**
 * CLI Observe search: environment → organization → stream → mode (service & level, RCID, SQL) → time range, then an
 * encrypted export folder. Accounts are read only from config/openobserve.<env>.env; the CLI never asks for them.
 */
import { config, OPENOBSERVE_ENVS, openObserveAccountFor, openObserveEnvFile, useOpenObserveEnv } from '../config.js';
import { ExportResult, SnapshotMeta, fetchWindowMs, startExport, timeWindows } from '../ai-context/index.js';
import { runExport } from '../export.js';
import { openObserveProvider } from '../providers/index.js';
import { ExportAggregates, LogEntry, LogLevel } from '../types.js';
import { Prompt, choose, clearLine, confirm, progressLine } from './io.js';
import { askTimeRange } from './time-range.js';

/** Rows printed to the terminal; the saved export keeps all of them. */
const SHOWN = 50;
const LEVEL_MENU: Array<[string, LogLevel[] | undefined]> = [
  ['Error (Error+Fatal/Critical)', ['Error', 'Fatal']], ['Warning', ['Warning']], ['Information', ['Information']], ['Debug/Verbose', ['Debug', 'Verbose']], ['All', undefined],
];

type Mode = '1' | '2' | '3';
type Window = { from: string; to: string };
type FetchWindow = (window: Window, onProgress: (rows: number) => void) => Promise<{ logs: LogEntry[]; aggregates?: ExportAggregates }>;
/** One search: where, what and how much. `organization` is the identifier (encryption key); meta holds its name. */
interface Search {
  prompt: Prompt;
  mode: Mode;
  organization: string;
  stream: string;
  from: string;
  to: string;
  limit: number;
  service?: string;
  levels?: LogLevel[];
  includeNoise: boolean;
  sql?: string;
  meta: SnapshotMeta;
}

export async function runOpenObserve(prompt: Prompt): Promise<void> {
  await chooseEnvironment(prompt);
  console.log(`Connecting to Observe ${config.openobserve.env?.toUpperCase()} (${config.openobserve.url}) as ${config.openobserve.email || 'configured identity'}...`);
  const organizations = await openObserveProvider.listOrganizations();
  if (!organizations.length) { console.log('This account has no accessible Organizations.'); return; }
  if (config.openobserve.env === 'dev' && organizations.every((o) => o.name === 'eagers_au')) {
    console.log(`\n[WARNING] You selected DEV, but the token in config/openobserve.dev.env connects as '${config.openobserve.email}', which only has access to PROD (${organizations.map((o) => o.name).join(', ')}).`);
    console.log(`Please update config/openobserve.dev.env with the token for agent-check-log-dev.\n`);
  }
  const organization = await choose(prompt, 'Accessible Organizations:', organizations, (org) => `${org.name} (${org.identifier})`, 'Choose Organization number: ', 'Invalid Organization selection');
  const streams = await openObserveProvider.listStreams(organization.identifier);
  if (!streams.length) { console.log('This Organization has no accessible log streams.'); return; }
  const stream = await choose(prompt, 'Log streams:', streams, (s) => s, 'Choose stream number: ', 'Invalid stream selection');
  const mode = (await prompt.ask('Search by: 1. Service & level  2. RCID  3. SQL\nChoose 1-3: ')).trim();
  if (mode !== '1' && mode !== '2' && mode !== '3') throw new Error('Choose 1, 2, or 3');
  const { from, to } = await askTimeRange(prompt, mode === '1' ? 2 : 1);
  const filter = mode === '1' ? await askServiceFilter(prompt, organization.identifier, stream, from, to) : {};
  if (!filter) return;
  const limit = Number((await prompt.ask('Maximum results [all]: ')).trim() || Infinity);
  if (limit !== Infinity && (!Number.isInteger(limit) || limit < 1)) throw new Error('Maximum results must be a positive integer');
  // Framework noise is only counted unless asked for: see docs/OPENOBSERVE_GUIDE.md "What an export keeps and what it skips".
  const includeNoise = mode === '1' && await confirm(prompt, 'Include framework noise rows (health checks, ASP.NET pipeline, EF Core SQL, HttpClient, Ocelot)? Much slower (y/N): ', true);
  const sql = mode === '3' ? (await prompt.ask(`SQL [SELECT * FROM "${stream}"]: `)).trim() || `SELECT * FROM "${stream.replace(/"/g, '""')}"` : undefined;
  const meta = { provider: 'openobserve', env: config.openobserve.env, organization: organization.name, stream, ...filter, from, to, limit, sql, includeNoise };
  const search: Search = { prompt, mode, organization: organization.identifier, stream, from, to, limit, includeNoise, sql, ...filter, meta };
  if (mode === '2') await exportRequest(search);
  else await exportSearch(search);
}

async function chooseEnvironment(prompt: Prompt): Promise<void> {
  const configured = OPENOBSERVE_ENVS.map((env) => {
    const acc = openObserveAccountFor(env);
    return { env, ok: Boolean(acc.url && acc.email && acc.token), url: acc.url };
  });
  console.log(`\nObserve environment:\n${OPENOBSERVE_ENVS.map((env, index) => {
    const info = configured[index]!;
    return `  ${index + 1}. ${env.toUpperCase()}${info.ok ? ` (${info.url})` : ' (not configured)'}`;
  }).join('\n')}`);
  const env = OPENOBSERVE_ENVS[Number((await prompt.ask(`Choose environment 1-${OPENOBSERVE_ENVS.length}: `)).trim()) - 1];
  if (!env) throw new Error('Invalid environment selection');
  useOpenObserveEnv(env);
  const status = openObserveProvider.getStatus();
  if (!status.configured) throw new Error(`Connect failed: ${openObserveEnvFile(env)} is missing or incomplete (${status.missingVariables?.join(', ')})`);
}

/** Service (0 = all) and levels; undefined when the stream logged nothing in the range. */
async function askServiceFilter(prompt: Prompt, organization: string, stream: string, from: string, to: string): Promise<{ service?: string; levels?: LogLevel[] } | undefined> {
  const { services } = await openObserveProvider.listServices({ organization, stream, from, to });
  if (!services.length) { console.log(`No services logged in ${stream} in this range.`); return undefined; }
  console.log(`\nServices in ${stream}:`);
  const width = Math.max(...services.map((s) => s.name.length));
  services.forEach((s, index) => {
    const issues = s.levels ? ` (${s.levels.Error ?? 0} Error, ${s.levels.Warning ?? 0} Warning${s.levels.Fatal ? `, ${s.levels.Fatal} Fatal` : ''})` : '';
    console.log(`  ${String(index + 1).padStart(2)}. ${s.name.padEnd(width)}  ${String(s.count).padStart(7)} logs${issues}`);
  });
  console.log('   0. All services');
  const choice = Number((await prompt.ask('Choose service: ')).trim());
  if (!Number.isInteger(choice) || choice < 0 || choice > services.length) throw new Error('Invalid service selection');
  console.log(`Log level: ${LEVEL_MENU.map(([label], index) => `${index + 1}. ${label}`).join('  ')}`);
  const picks = ((await prompt.ask('Choose level(s), e.g. 1 or 1,2 [1,2]: ')).trim() || '1,2').split(',').map((v) => LEVEL_MENU[Number(v.trim()) - 1]);
  if (picks.some((p) => !p)) throw new Error('Invalid level selection');
  const levels = picks.some((p) => !p![1]) ? undefined : picks.flatMap((p) => p![1]!);
  return { service: choice ? services[choice - 1]!.name : undefined, levels };
}

/** RCID: the whole request across services and levels (rcid / correlationid / trace_id): a folder with rcid/ and SUMMARY. */
async function exportRequest(s: Search): Promise<void> {
  const rcid = (await s.prompt.ask('RCID: ')).trim();
  if (!rcid) throw new Error('RCID is required');
  const flows = await openObserveProvider.fetchFlows({ organization: s.organization, stream: s.stream, ids: [{ field: 'rcid', value: rcid }], from: s.from, to: s.to });
  if (!flows.length) { console.log('No log carries this RCID in the range; widen it (e.g. Last 7 days).'); return; }
  const out = startExport({ ...s.meta, service: `rcid-${rcid}` }, { orgKey: s.organization });
  out.addFlows(flows);
  report(out.finish());
}

/**
 * Service & level or SQL: COUNTs size the fetch windows (24h / 6h / 1h / 15m) so each holds at most 250k downloaded
 * rows in memory. Custom SQL cannot be counted, so a range over 1h is fetched per hour. Every window lands in the same
 * export folder.
 */
async function exportSearch(s: Search): Promise<void> {
  const counts = s.mode === '1' ? await openObserveProvider.countServiceLogs(queryOf(s)) : undefined;
  const windowMs = counts === undefined ? 60 * 60_000 : fetchWindowMs(Math.min(counts.download, s.limit), s.from, s.to);
  const windows = timeWindows(s.from, s.to, windowMs);
  if (counts) printEstimate(counts, windows.length, windowMs, s.limit);
  if (windows.length > 1) await exportWindows(s, windows);
  else await previewThenExport(s, windows);
}

function printEstimate(counts: { total: number; noise: number; download: number }, windows: number, windowMs: number, limit: number): void {
  // ponytail: rough ETA from the measured ~6k rows/s with 5 parallel requests (the server's limit, not the client's).
  const minutes = Math.ceil(Math.min(counts.download, limit) / 6000 / 60);
  const size = windowMs >= 60 * 60_000 ? `${windowMs / (60 * 60_000)}h` : `${windowMs / 60_000}m`;
  console.log(`\n≈${counts.total.toLocaleString()} rows: ${counts.noise.toLocaleString()} framework noise (counted only), ${counts.download.toLocaleString()} to download in ${windows} window(s) of ${size} → one export folder, est. ~${minutes} min.`);
}

/** Provider parameters of a search. */
const queryOf = (s: Search) => ({
  organization: s.organization, stream: s.stream, service: s.service, levels: s.levels, includeNoise: s.includeNoise, from: s.from, to: s.to, limit: s.limit,
});

/** Rows of one window (framework noise skipped unless includeNoise) and, for service searches, the counts of what was skipped. */
const fetcher = (s: Search): FetchWindow => async (window, onProgress) => {
  const query = { ...queryOf(s), ...window };
  const [logs, aggregates] = s.mode === '1'
    ? await Promise.all([openObserveProvider.searchServiceLogs({ ...query, onProgress }), openObserveProvider.exportAggregates(query)])
    : [await openObserveProvider.searchLogs({ ...query, sql: s.sql!, onProgress }), undefined];
  clearLine();
  return { logs, aggregates };
};

async function exportWindows(s: Search, windows: Window[]): Promise<void> {
  const withFlows = await confirm(s.prompt, 'Fetch full request flows (rcid/trace_id) for errors? (Y/n): ');
  const tag = (index: number) => `[${index + 1}/${windows.length}] ${windows[index]!.from.slice(0, 16)} → ${windows[index]!.to.slice(11, 16)}: `;
  report(await runExport({
    meta: s.meta, orgKey: s.organization, windows, withFlows, fetchWindow: fetcher(s),
    onProgress: (index, rows) => progressLine(tag(index))(rows),
    onWindow: (index, _window, saved, duplicates) => console.log(`${tag(index)}${saved.toLocaleString()} logs${duplicates ? `, ${duplicates.toLocaleString()} duplicates skipped` : ''}`),
  }));
}

/** One window: preview the newest rows, then save them. */
async function previewThenExport(s: Search, windows: Window[]): Promise<void> {
  const first = await fetcher(s)({ from: s.from, to: s.to }, progressLine(''));
  console.log(`\nFound ${first.logs.length} logs${first.logs.length > SHOWN ? ` (showing newest ${SHOWN})` : ''}:`);
  for (const log of first.logs.slice(0, SHOWN)) console.log(`[${log.timestamp}] [${log.level}]${log.service ? ` [${log.service}]` : ''} ${log.message}`);
  if (first.logs.length > SHOWN) console.log(`... ${first.logs.length - SHOWN} more (save to ai-context to keep all)`);
  if (!first.logs.length || !await confirm(s.prompt, '\nSave to ai-context? (Y/n): ')) return;
  const withFlows = await confirm(s.prompt, 'Fetch full request flows (rcid/trace_id) for errors? (Y/n): ');
  report(await runExport({ meta: s.meta, orgKey: s.organization, windows, withFlows, fetchWindow: async () => first }));
}

function report(r: ExportResult): void {
  const duplicates = r.duplicates ? ` (${r.duplicates.toLocaleString()} already in earlier exports, skipped)` : '';
  console.log(`\nSaved ${r.rows.toLocaleString()} logs${duplicates}${r.flows ? `, ${r.flows} request flows` : ''}${r.truncated ? ' (a window hit the limit)' : ''} in one encrypted export folder:\n  ${r.dir}\nRead it with the read_ai_context MCP tool (snapshot: ${r.snapshot}).`);
}
