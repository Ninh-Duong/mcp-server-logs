# AGENTS.md - Master Operating Manual for AI Agents

> **Primary Objective**: This repository (`mcp-server-logs`) is designed for **100% AI Vibe-Coding**. Any AI Agent (Claude, Gemini, GPT, Cursor, Copilot) reading this repository MUST follow the architectural invariants, standards, and rules described herein.

---

## 1. Core Engineering Philosophy: Ponytail & Minimalism

- **Stdlib First**: Always prefer Node.js standard libraries (`node:fs`, `node:path`, `node:readline`, `node:url`, native `fetch`) over adding npm packages.
- **Zero Supply-Chain Bloat**: Never install packages like `axios`, `winston`, `pino`, `inquirer`, `lodash`, or `dotenv`. The codebase already has lean, battle-tested native implementations for all these.
- **Stdio Integrity**: When operating in MCP mode, `process.stdout` is strictly reserved for JSON-RPC messages. **NEVER use `console.log()`** inside providers, services, or tools. Use `logger.info()`, `logger.warn()`, or `logger.error()`, which redirect to `logs/YYYY/MM/mcp-process-YYYY-MM-DD.log` and `process.stderr`.
- **Universal Portability**: Never hardcode absolute system paths (e.g. `C:\...` or `/home/...`). Always resolve directories relative to project root using `PROJECT_ROOT` from `src/config.ts`.
- **Small, single-purpose code**: one file per responsibility, short functions named for what they do. When a function grows past a screen, split it into steps. See the code map below.
- **Tests come with every change**: a new feature or bug fix lands with a test that fails without it (`src/tests/`). Bug fixes: write the failing test first. Run `npm test` before reporting completion; it fails on any failing test or below 90% lines / 80% branches / 90% functions coverage.

### Code map

| Path | Responsibility |
|---|---|
| `src/index.ts` | entry point (MCP stdio, `--cli`, `--preflight`) and the library exports |
| `src/config.ts` | folders, account files (`config/openobserve.<env>.env`, `config/seq.env`), accounts sent by mcp-hub (`CENTRAL_CONFIG_PATH`), placeholder detection |
| `src/service.ts` | `LogsService`: one provider or a broadcast to every configured provider |
| `src/providers/` | `base.ts` levels/time bounds · `seq.ts` · `openobserve.ts` (HTTP, paging, flows) · `openobserve-sql.ts` (pure SQL, noise filter, stream shape) · `index.ts` registry |
| `src/tools/` | MCP tools: `common.ts` (`run`, results, shared zod fields, annotations) · `query.ts` · `openobserve.ts` · `ai-context.ts` |
| `src/ai-context/` | encrypted exports: `lhub.ts` (file format) · `model.ts` (lines, patterns, names, windows) · `export-folder.ts` (writer) · `summary.ts` · `read.ts` |
| `src/export.ts` | `runExport`: the export loop shared by the CLI and the MCP tool |
| `src/cli/` | `menu.ts` loop · `io.ts` prompts · `time-range.ts` · `seq.ts` · `openobserve.ts` |
| `src/utils/` | `logger.ts` (process log, `maskOrg`) · `preflight.ts` |
| `src/tests/` | `env.ts` (preloaded: temp folders, no accounts) · `helpers.ts` (fake servers, fixtures) · `*.test.ts` |

### Testing rules
- `npm test` preloads `src/tests/env.ts`: every test process gets temp `LOG_DIR`, `CONFIG_DIR` and `AI_CONTEXT_DIR` and no provider variables. Never read or write the real `config/`, `logs/` or `ai-context/` from a test, and never call a real server.
- Fake servers live in `src/tests/helpers.ts` (`routed`, `setup`, `fakeSearch`, `useFakeAccount`); reuse them instead of writing new `fetch` mocks.
- MCP tools are tested through a real `McpServer` + `Client` over `InMemoryTransport` (`tools.test.ts`), so argument validation and defaults run as in production. The CLI is tested in a child process (`cli.test.ts` `runCli`).
- Code that runs at import time (`config.ts`) is tested in a child process (`runModule`).

---

## 2. Model-Specific Prompting & Execution Guidelines

### For Anthropic Claude (Sonnet / Opus)
- **Tool Calling**: When invoking `query_logs`, specify `provider` if the user refers to a specific system (e.g. "check Seq"), or omit it to broadcast across all configured backends.
- **Code Edits**: Keep changes surgical. When adding a provider, only create the provider file in `src/providers/<name>.ts` and register it in `src/providers/index.ts`. Do not re-architect existing modules.

### For Google Gemini (Flash / Pro)
- **Type Safety**: Respect strict TypeScript typings in `src/types.ts`. All provider outputs must be normalized into `LogEntry`.
- **Time Bounds**: Use standard ISO strings or supported relative formats: `'15m'`, `'1h'`, `'24h'`, `'7d'`.

### For OpenAI GPT-4o / Reasoning Models
- **Preflight Diagnostics**: Always run `npm run build` after making modifications to verify zero type regressions before reporting completion.

---

## 3. How to Add a New Log Provider in 3 Steps

When instructed to add support for a new log provider (e.g., Loki, Datadog, Elasticsearch, CloudWatch):

### Step 1: Define Environment Variables in a provider account example
Add connection variables in `config/<provider>.env.example`, load `config/<provider>.env` in `src/config.ts` (`loadEnvFile`), and add the example to `ensureEnvFiles` if users should get a file to fill in.

### Step 2: Implement the Provider Class in `src/providers/<provider>.ts`
Implement the `LogProvider` interface:
```typescript
import { LogProvider, ProviderStatus, LogQuery, LogEntry } from '../types.js';
import { normalizeLogLevel, parseTimeBound } from './base.js';

export class NewProvider implements LogProvider {
  public readonly name = 'newprovider';

  public getStatus(): ProviderStatus {
    // Check required env variables
    return { name: this.name, configured: true };
  }

  public async queryLogs(params: LogQuery): Promise<LogEntry[]> {
    // Use native fetch() to call provider API
    // Normalize into LogEntry[]
    return [];
  }
}
```

### Step 3: Register in `src/providers/index.ts`
Add an instance to the array the provider map is built from:
```typescript
const providers = new Map<string, LogProvider>([new SeqProvider(), openObserveProvider, new NewProvider()].map((p) => [p.name, p]));
```
Then add tests with a fake server (see `src/tests/seq.test.ts`).

---

## 4. MCP Tools Reference

### Tool: `list_log_providers`
- **Purpose**: Lists all known log backends, whether their credentials are configured, and endpoint URLs, plus `openobserve_environments` (which of dev/stg/prod have an account). The Seq provider and each environment carry `source`: `env` (client variables), `hub` (mcp-hub's file), `local` (`config/*.env`) or `unset`; `--preflight` shows the same.
- **Parameters**: None.

### Tool: `query_logs`
- **Purpose**: Retrieves logs with filtering, time range bounding, and level filtering.
- **Parameters**:
  - `provider` *(optional string)*: `'seq'`, `'openobserve'`, or omit for compatible configured backends.
  - `organization` *(optional string)*: OpenObserve Organization identifier; required for OpenObserve queries.
  - `stream` *(optional string)*: OpenObserve log stream when `query` is omitted.
  - `query` *(optional string)*: Seq filter expression, or exactly one read-only OpenObserve `SELECT` statement.
  - `from` *(optional string)*: ISO timestamp or `'15m'`, `'1h'`, `'24h'`, `'7d'`.
  - `to` *(optional string)*: ISO timestamp or `'15m'`, `'1h'`, `'24h'`, `'7d'` (that long ago); default now.
  - `limit` *(optional number, 1-500, default 50)*: Maximum records to return.
  - `level` *(optional string or string[])*: `'Verbose' | 'Debug' | 'Information' | 'Warning' | 'Error' | 'Fatal'`. One level = minimum severity (`'Warning'` → Warning, Error, Fatal); an array = exactly those levels.
  - `env` *(optional `'dev' | 'stg' | 'prod'`)*: OpenObserve account for this call (`config/openobserve.<env>.env`); omit for the server default.

**One server, every environment**: every OpenObserve tool (and `query_logs`, `export_openobserve_logs`) takes the same optional `env`. `withOpenObserveEnv` / `openObserveAccount()` (`src/config.ts`) scope the account to one call; never read `config.openobserve` directly in a provider or tool. Under mcp-hub, `CENTRAL_CONFIG_PATH` names the hub's JSON file whose `openobserve` (`default_env`, `dev`/`stg`/`prod` = `{url, email, token}`) and `seq` (`server_url`, `api_key`) sections rank between variables already set and the `config/*.env` files (an empty account falls back to its file). `read_ai_context` takes no `env`: it uses the export's own.

OpenObserve also exposes `list_openobserve_organizations`, `list_openobserve_streams`, `list_openobserve_stream_schema`, `list_openobserve_services`, `get_openobserve_service_logs`, `export_openobserve_logs` (writes ONE `ai-context/` export folder per call, `<from>_<to>_<service>_<levels>_<rows>` in `AI_CONTEXT_TIME_ZONE` (default UTC), with encrypted files `SUMMARY.lhub`, `services/<service>/<level>.lhub`, `rcid/<field>-<id>.lhub`; framework noise only counted unless `include_noise`; `skip_duplicates`, default true, drops rows already saved by an overlapping export), `list_ai_context_snapshots` (export folders), `read_ai_context` (decrypts one file of a folder in memory: `SUMMARY.lhub` first, then `file`/`offset` or `grep`), `find_openobserve_logs_by_rcid`, and `search_openobserve_logs`. See `docs/OPENOBSERVE_GUIDE.md`.

**Tool rule**: register tools with `server.registerTool(name, { title, description, inputSchema, annotations }, handler)` (not the deprecated `server.tool`), wrap the body in `run(toolName, …)` (or `runIn(toolName, env, …)` for OpenObserve tools) from `src/tools/common.ts`, and set `readOnlyHint` (false only for tools that write, like `export_openobserve_logs`) and `openWorldHint` (true when it calls OpenObserve or Seq).

**Prompts and server instructions**: prompts `investigate_api_bug` (bug report → live SQL search) and `analyze_ai_context` (question → read an export through `read_ai_context` → compare with the caller's source). On connect the server sends `logsInstructions()` (`src/tools/index.ts`) as MCP server instructions. It is the only guidance an agent in another repository gets over a direct connection, because that agent never sees this file (under mcp-hub, agents get the hub's contract instead: `../mcp-hub/docs/mcps/mcp-server-logs.md`). When a tool or rule changes, update those instructions in the same change.

**ai-context rule**: the `.lhub` extension, the `LHUB3` magic and the HKDF info `'mcp-log-hub/ai-context/v1'` (`src/ai-context/lhub.ts`) are frozen file-format constants from the project's earlier name: never rename them, or every existing export becomes unreadable. `.lhub` files are encrypted with the OpenObserve organization identifier. Never open them with file tools or write code that decrypts them outside `src/ai-context/`; read them only through `read_ai_context`, which first checks that the account in `config/openobserve.<env>.env` connects and is enabled for the export's organization. Reading order: `SUMMARY.lhub` (whole export, Bugs table) → the `services/<service>/<level>.lhub` line it points to → that request's `rcid/` file. Folder and file names are plaintext (range, services, levels, row count, rcid values); never put log content or an organization identifier in a name. Never write an organization identifier to disk (`ai-context/`, `logs/`, file headers); use the organization name.

**Export content rule**: a service/level export downloads every Warning/Error/Critical row and every application log row, but only **counts** framework noise at Information level or below (health checks, ASP.NET pipeline, EF Core SQL, HttpClient, Ocelot, gRPC, MassTransit, Elsa; list in `NOISE_CATEGORIES`, `src/providers/openobserve-sql.ts`) and never selects constant SDK fields (`DROP_FIELDS`). Each SUMMARY says so under "What this export contains". When reading an export, never conclude that a request had no SQL / HTTP / gRPC activity from `services/` alone: those rows are in that request's `rcid/` file, or fetch them with `find_openobserve_logs_by_rcid`. When changing either list, update the tables in `docs/OPENOBSERVE_GUIDE.md` "What an export keeps and what it skips" in the same change.

---

## 5. Master / Parent MCP Orchestration Rule

This repository is designed to be consumed as a feature by a Master MCP.
- If integrating inside a parent server in the same Node process, use:
  ```typescript
  import { registerLogsTools } from 'mcp-server-logs';
  registerLogsTools(parentServer, { prefix: 'logs__' });
  ```
- If running as a child subprocess, spawn `node start.mjs` (auto-installs and builds) using `StdioClientTransport`.

Refer to `docs/PARENT_MCP_GUIDE.md` for comprehensive integration examples.

To connect this server to an AI client (Antigravity, Claude Code, Cursor, Copilot, Codex, …), follow `docs/AI_AGENT_SETUP.md`. When the launch command, env variables or tool names change, update that file in the same change, plus the mcp-hub contract `../mcp-hub/docs/mcps/mcp-server-logs.md` and its allowlist template `../mcp-hub/config/hub.example.json`.
