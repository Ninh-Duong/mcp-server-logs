/** ai-context tools: export logs to an encrypted folder, list folders, read one file through the access check. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { openObserveAccount } from '../config.js';
import { LhubHeader, SnapshotMeta, exportDir, fetchWindowMs, listSnapshots, openSnapshot, snapshotFiles, startExport, timeWindows } from '../ai-context/index.js';
import { runExport } from '../export.js';
import { openObserveProvider } from '../providers/index.js';
import { parseTimeBound, resolveLevels } from '../providers/base.js';
import { LogLevel } from '../types.js';
import { READ_LOCAL, ToolResult, env, json, level, organization, run, runIn, stream, text, to } from './common.js';

const EXPORT_DESCRIPTION = 'Fetch all logs (or max_rows) of a service/level in a time range and save them as ONE ai-context export folder (<from>_<to>_<service>_<levels>_<rows>, times in AI_CONTEXT_TIME_ZONE, default UTC) with encrypted, compressed files: SUMMARY.lhub (whole export), services/<service>/<level>.lhub, rcid/<field>-<id>.lhub. Framework noise (health checks, ASP.NET pipeline, EF Core SQL, HttpClient, Ocelot, gRPC, MassTransit, Elsa at Information or below) is counted in SUMMARY, not downloaded, unless include_noise; failing requests keep it in rcid/. Returns the folder: read it with {prefix}read_ai_context (SUMMARY first), then open only the log lines it points to. To list a service\'s bugs: level \'Error\' + service, then read the SUMMARY "Bugs" table (one row per bug, each with the full flow of every failing request). To diagnose one request: pass rcid (widen from, e.g. \'7d\', if nothing is found).';

const exportInput = {
  env, organization, stream,
  service: z.string().optional().describe('Service name from list_openobserve_services; omit for all services.'),
  level,
  from: z.string().default('1h').describe('Lower bound, ISO 8601 with timezone or relative duration (default 1h).'),
  to,
  max_rows: z.number().int().min(1).optional().describe('Rows to fetch per fetch window; omit for every row in the range. Newest first when truncated.'),
  include_flows: z.boolean().default(true).describe('Also fetch the full request flow (all services, all levels) of every distinct rcid/trace_id among the errors of the whole export (up to 200, most frequent bug first), one file each in rcid/. Start diagnosis there.'),
  rcid: z.string().min(1).optional().describe('Export only this one request: every log sharing this rcid/trace_id, across all services and levels. service/level are ignored.'),
  skip_duplicates: z.boolean().default(true).describe('Drop logs already saved by an earlier export of this stream (overlapping ranges), so only new rows are written. Ignored with rcid.'),
  include_noise: z.boolean().default(false).describe('Also download framework noise rows (health checks, ASP.NET hosting/routing/MVC/CORS, EF Core SQL, HttpClient, Ocelot, gRPC, MassTransit, Elsa at Information or below). Default: only counted in SUMMARY; they stay whole inside rcid/. Much slower.'),
};
type ExportArgs = { env?: string; organization: string; stream: string; service?: string; level?: LogLevel | LogLevel[]; from: string; to?: string; max_rows?: number;
  include_flows: boolean; rcid?: string; skip_duplicates: boolean; include_noise: boolean };

/** A ready-made request for an agent in any repository: answer a question from an export, through read_ai_context only. */
export function registerAnalyzePrompt(server: McpServer, prefix: string): void {
  server.registerPrompt(`${prefix}analyze_ai_context`, {
    title: 'Analyze an ai-context log export',
    description: 'Answer a question from an encrypted ai-context export, reading it only through read_ai_context, and compare it with the source code of the current workspace.',
    argsSchema: {
      question: z.string().default('Analyze the latest ai-context export and summarize any bugs or errors.').describe('What to find out, e.g. "Why do order saves fail?"'),
      snapshot: z.string().optional().describe('Export folder from list_ai_context_snapshots; omit to pick the newest matching one.'),
    },
  }, ({ question, snapshot }) => ({
    description: 'Read an ai-context export with the mcp-server-logs tools.',
    messages: [{ role: 'user', content: { type: 'text', text: `Answer this from the ai-context log export, then explain it with the source code of this workspace.

Question: ${question}
Export: ${snapshot ?? `not chosen: call ${prefix}list_ai_context_snapshots and pick the newest export that matches the question (env, stream, range).`}

Steps:
1. Call ${prefix}read_ai_context with the export as snapshot (SUMMARY.lhub by default). Read "What this export contains", the Bugs table and the top patterns.
2. For each relevant bug, open its example file:line with ${prefix}read_ai_context (file + offset), then its rcid/ flow file to see the whole failing request across services. Use grep to find an rcid or message in every file.
3. Find the code paths in this workspace that produced those logs and explain the cause. Cite log lines (file:line) and source files; separate confirmed facts from hypotheses.

Rules: read the export only through ${prefix}read_ai_context; never open .lhub files or anything under ai-context/ with file tools or scripts. If it answers "No access", tell the user which env account or organization is missing and stop.` } }],
  }));
}

export function registerAiContextTools(server: McpServer, prefix: string): void {
  server.registerTool(`${prefix}export_openobserve_logs`, {
    title: 'Export logs to ai-context',
    description: EXPORT_DESCRIPTION.replace('{prefix}', prefix),
    inputSchema: exportInput,
    // Writes a new local folder; never changes or deletes earlier exports.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, (args) => runIn('export_openobserve_logs', args.env, () => exportLogs(args, prefix)));

  server.registerTool(`${prefix}list_ai_context_snapshots`, {
    title: 'List ai-context exports',
    description: 'List saved ai-context export folders, newest first: env, organization, stream, service, time range, rows and file count. Lists without access checks (names only, no log content); reading needs read_ai_context. A folder ending in _partial is an export that did not finish.',
    inputSchema: {
      env: z.string().optional().describe("Only this environment, e.g. 'prod'."),
      stream: z.string().optional().describe('Only this log stream.'),
    },
    annotations: READ_LOCAL,
  }, (args) => run('list_ai_context_snapshots', async () => listExports(args)));

  server.registerTool(`${prefix}read_ai_context`, {
    title: 'Read an ai-context export',
    description: 'Read an encrypted ai-context export folder. Start with SUMMARY.lhub (default), then open the file:line it points to (services/<service>/<level>.lhub, rcid/<field>-<id>.lhub), or grep every file for an rcid / message. Only the file asked for is decrypted. Access requires a working OpenObserve account for the export env (config/openobserve.<env>.env) that is enabled for its organization.',
    inputSchema: {
      snapshot: z.string().min(1).describe('Export folder relative to ai-context/, from list_ai_context_snapshots or export_openobserve_logs.'),
      file: z.string().optional().describe('File inside the folder (default SUMMARY.lhub), e.g. services/Shop.Email/error.lhub or rcid/rcid-0HN7ABC.lhub.'),
      offset: z.number().int().min(1).default(1).describe('First line to return (1-based).'),
      limit: z.number().int().min(1).max(1000).default(200).describe('Lines (or grep matches) to return.'),
      grep: z.string().min(1).optional().describe('Case-insensitive text to find; returns file:line matches in `file`, or in every file (one at a time) when `file` is omitted.'),
    },
    // Reads local files, but checks access against OpenObserve first.
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, (args) => run('read_ai_context', () => (args.grep ? grepExport({ ...args, grep: args.grep }) : readLines(args))));
}

async function exportLogs(args: ExportArgs, prefix: string): Promise<ToolResult> {
  const from = parseTimeBound(args.from);
  const to = args.to ? parseTimeBound(args.to) : new Date().toISOString();
  if (!from || !to) throw new Error('Invalid time range');
  // The organization name goes into the folder path and file headers; its identifier is the encryption key and is never written.
  const organization = (await openObserveProvider.listOrganizations()).find((org) => org.identifier === args.organization);
  if (!organization) throw new Error(`Organization '${args.organization}' is not accessible to this account`);
  const levels = args.rcid ? undefined : resolveLevels(args.level);
  const meta: SnapshotMeta = {
    provider: 'openobserve', env: openObserveAccount().env, organization: organization.name, stream: args.stream, service: args.service,
    levels, from, to, limit: args.max_rows ?? Infinity, includeNoise: args.include_noise,
  };
  return args.rcid ? exportRequest(meta, args.organization, args.rcid, prefix) : exportRange(meta, args, prefix);
}

/** One request: an export folder holding only rcid/ and its SUMMARY. */
async function exportRequest(meta: SnapshotMeta, orgKey: string, rcid: string, prefix: string): Promise<ToolResult> {
  const out = startExport({ ...meta, service: `rcid-${rcid}` }, { orgKey });
  out.addFlows(await openObserveProvider.fetchFlows({ organization: orgKey, stream: meta.stream, ids: [{ field: 'rcid', value: rcid }], from: meta.from, to: meta.to }));
  const result = out.finish();
  return json({ ...result, dir: undefined, next: `Read it with ${prefix}read_ai_context (SUMMARY first).` });
}

/** Every row of the range, fetched in windows sized by a COUNT so each holds at most 250k rows in memory. */
async function exportRange(meta: SnapshotMeta, args: ExportArgs, prefix: string): Promise<ToolResult> {
  const query = { organization: args.organization, stream: args.stream, service: args.service, levels: meta.levels, includeNoise: args.include_noise };
  const counts = await openObserveProvider.countServiceLogs({ ...query, from: meta.from, to: meta.to });
  const windowMs = fetchWindowMs(Math.min(counts.download, meta.limit), meta.from, meta.to);
  const result = await runExport({
    meta, orgKey: args.organization, windows: timeWindows(meta.from, meta.to, windowMs), withFlows: args.include_flows, skipDuplicates: args.skip_duplicates,
    // Rows (noise skipped) and the server-side counts of what was skipped, fetched together.
    fetchWindow: async (window) => {
      const [logs, aggregates] = await Promise.all([
        openObserveProvider.searchServiceLogs({ ...query, ...window, limit: meta.limit }),
        openObserveProvider.exportAggregates({ ...query, ...window }),
      ]);
      return { logs, aggregates };
    },
  });
  return json({
    totalRows: counts.total, noiseRowsCounted: counts.noise, ...result, dir: undefined, fetchWindowMinutes: windowMs / 60_000,
    next: `Read it with ${prefix}read_ai_context: snapshot = "${result.snapshot}", SUMMARY first.`,
  });
}

function listExports(args: { env?: string; stream?: string }): ToolResult {
  const snapshots = listSnapshots()
    .filter(({ snapshot, header }) => (!args.env || (header?.env ?? snapshot.split('/')[1]) === args.env.toLowerCase())
      && (!args.stream || (header?.stream ?? snapshot.split('/')[3]) === args.stream))
    .slice(0, 100)
    .map(({ snapshot, header, partial, files }) => ({
      snapshot, partial, files,
      ...(header ? { env: header.env, organization: header.organization, stream: header.stream, service: header.service, from: header.from, to: header.to, rows: header.rows, createdAt: header.createdAt } : {}),
    }));
  return json({ total: snapshots.length, snapshots });
}

/** The access check: the account saved for the export's env must be enabled for its organization. */
const keyFor = (header: LhubHeader) => openObserveProvider.organizationKey(header.env, header.organization);

async function readLines(args: { snapshot: string; file?: string; offset: number; limit: number }): Promise<ToolResult> {
  const lines = (await openSnapshot(args.snapshot, args.file, keyFor)).text.split('\n');
  const shown = lines.slice(args.offset - 1, args.offset - 1 + args.limit).map((line, i) => `${args.offset + i}: ${line}`);
  const next = args.offset - 1 + args.limit < lines.length ? `\n… ${lines.length} lines in total; continue with offset ${args.offset + args.limit}.` : '';
  return text(shown.join('\n') + next);
}

/** file:line matches in `file`, or in every file of the export; only one file is decrypted in memory at a time. */
async function grepExport(args: { snapshot: string; file?: string; limit: number; grep: string }): Promise<ToolResult> {
  const needle = args.grep.toLowerCase();
  const matches: string[] = [];
  const names = args.file ? [args.file] : snapshotFiles(exportDir(args.snapshot));
  for (const name of names) {
    if (matches.length >= args.limit) break;
    const { text: body, file } = await openSnapshot(args.snapshot, name, keyFor);
    body.split('\n').forEach((line, i) => { if (matches.length < args.limit && line.toLowerCase().includes(needle)) matches.push(`${file}:${i + 1}: ${line}`); });
  }
  return text(matches.length ? matches.join('\n') : `No match for '${args.grep}'.`);
}
