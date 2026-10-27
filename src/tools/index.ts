import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LogsService, defaultLogsService } from '../service.js';
import { registerAiContextTools, registerAnalyzePrompt } from './ai-context.js';
import { registerOpenObserveTools } from './openobserve.js';
import { registerBugPrompt, registerQueryTools } from './query.js';

export interface RegisterToolsOptions {
  /** Optional prefix for tool names (useful when mounted inside a Master MCP, e.g. "logs_") */
  prefix?: string;
  /** Custom LogsService instance */
  service?: LogsService;
}

/**
 * Registers the mcp-server-logs prompts and tools into any McpServer instance.
 * Enables both standalone operation and direct in-process embedding by a Master MCP.
 */
export function registerLogsTools(server: McpServer, options: RegisterToolsOptions = {}): void {
  const prefix = options.prefix || '';
  registerBugPrompt(server, prefix);
  registerAnalyzePrompt(server, prefix);
  registerQueryTools(server, prefix, options.service || defaultLogsService);
  registerOpenObserveTools(server, prefix);
  registerAiContextTools(server, prefix);
}

/**
 * Server instructions sent to the client on connect. Agents working in another repository never see this repo's
 * AGENTS.md, so this is where they learn to read ai-context only through the tools. A Master MCP mounting the tools
 * with a prefix can append logsInstructions(prefix) to its own instructions.
 */
export function logsInstructions(prefix = ''): string {
  return `mcp-server-logs: search Seq / OpenObserve logs and read encrypted ai-context log exports.
- One server serves every OpenObserve environment: live OpenObserve tools (and query_logs, export) take an optional env ('dev', 'stg', 'prod'). Use the environment the user names and keep it for the whole investigation; without env the server default is used. ${prefix}list_log_providers lists which environments have an account and where each comes from (env, hub, local, unset).
- AI-Context First Read-Through Cache: All log queries (query_logs, get_openobserve_service_logs, find_openobserve_logs_by_rcid) check local ai-context first. If cached, logs are read locally with zero remote latency. If missing, remote logs are fetched and automatically cloned to an encrypted local ai-context snapshot for subsequent analysis.
- ai-context exports are read ONLY through ${prefix}list_ai_context_snapshots and ${prefix}read_ai_context. Never open, copy, cat or decrypt .lhub files (or anything under ai-context/) with file tools or scripts: they are encrypted, and the access check runs inside read_ai_context. You do not need the folder's path.
- Reading order: ${prefix}list_ai_context_snapshots → ${prefix}read_ai_context(snapshot) for SUMMARY.lhub (Bugs table, top patterns with file:line) → read_ai_context(file, offset) at that line in services/<service>/<level>.lhub → the failing request in rcid/<field>-<id>.lhub, or grep an rcid across every file.
- services/ leaves out framework noise (health checks, ASP.NET pipeline, EF Core SQL, HttpClient, gRPC…); a request's rcid/ file has all of it.
- "No access" means the OpenObserve account for that env is missing or not enabled for the export's organization: tell the user, do not look for another way to read the data.
- To diagnose, compare what the logs show with the source code of the workspace you are working in; cite log lines and source files.
- New data: ${prefix}export_openobserve_logs writes a new export folder; live searches: ${prefix}search_openobserve_logs, ${prefix}get_openobserve_service_logs, ${prefix}find_openobserve_logs_by_rcid. Prompts: ${prefix}analyze_ai_context, ${prefix}investigate_api_bug.`;
}
