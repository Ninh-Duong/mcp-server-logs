# Architecture & Design Overview

## 1. System Topology

`mcp-server-logs` operates as a unified adapter layer bridging AI Agent interfaces and heterogeneous logging platforms.

```mermaid
flowchart TD
    subgraph Clients["Consumers"]
        CLI["Human via Terminal (npm run cli)"]
        AI["AI Agent (Claude / Antigravity / Cursor)"]
        MasterMCP["Parent / Master MCP Orchestrator"]
    end

    subgraph CoreHub["mcp-server-logs"]
        Router["CLI & MCP Transport Router\n(src/index.ts)"]
        Tools["MCP Tools and Prompt: search, schema, export, bug investigation\n(src/tools/)"]
        Service["LogsService\n(src/service.ts)"]
        Registry["Provider Registry\n(src/providers/index.ts)"]
        Preflight["Startup Preflight Diagnostics\n(src/utils/preflight.ts)"]
        Logger["Provider request lifecycle diagnostics\n(src/utils/logger.ts)"]
    end

    subgraph Providers["Log Backends"]
        SeqAPI["Seq REST API\n(/api/events)"]
        ObserveAPI["OpenObserve API / SQL\n(/api/{org}/_search)"]
        FutureAPI["Future Providers\n(Loki, Datadog, etc.)"]
    end

    subgraph Storage["Local Storage"]
        LogFile["logs/YYYY/MM/mcp-process-YYYY-MM-DD.log"]
    end

    CLI -->|Interactive Menu| Router
    AI -->|Stdio JSON-RPC| Router
    MasterMCP -->|Subprocess or Direct Import| Router

    Router --> Tools
    Tools --> Service
    Service --> Registry
    Registry --> SeqAPI
    Registry --> ObserveAPI
    Registry --> FutureAPI

    Router --> Preflight
    Router --> Logger
    Logger --> LogFile
```

On connect, the server sends instructions (`logsInstructions()` in `src/tools/index.ts`): agents in any repository learn to read ai-context only through `read_ai_context`, in which order, and to compare logs with their own source. The `analyze_ai_context` MCP Prompt packages that workflow for one question. The `investigate_api_bug` MCP Prompt guides the caller through inspecting source code, discovering Organization/stream/schema, running bounded SELECT searches, saving evidence in the caller's own `log-work/` directory, and citing log timestamps with source locations. Provider request logs record endpoint paths, status, duration, and result counts without credentials, query values, or returned application log contents.

---

## 2. Core Architectural Pillars

### Pillar A: Dual-Mode Operation (Standalone vs Embedded Child)
1. **Standalone MCP Server**:
   - Run directly via `node dist/index.js` or `npx mcp-server-logs`.
   - Communicates over standard input/output (`StdioServerTransport`).
2. **Embedded Child Feature Module**:
   - Master MCPs can import `registerLogsTools` and mount log querying capabilities directly into the master server without subprocess overhead.

### Pillar B: Stdio Transport Integrity
In the Model Context Protocol, any data written to standard output (`stdout`) that is not valid JSON-RPC breaks the client connection.
- **Rule**: `process.stdout` is exclusively reserved for `@modelcontextprotocol/sdk`.
- **Diagnostics & Errors**: Routed to `process.stderr` and appended to `logs/YYYY/MM/mcp-process-YYYY-MM-DD.log`.
- **Interactive UI**: Only rendered when explicitly started in CLI mode (`--cli`).

### Pillar C: Provider Adapter Pattern
Every log backend implements the common `LogProvider` interface:
```typescript
export interface LogProvider {
  readonly name: string;
  getStatus(): ProviderStatus;
  queryLogs(params: LogQuery): Promise<LogEntry[]>;
}
```
Each provider encapsulates its own authentication, endpoint URL structure, and native query format. OpenObserve also discovers accessible Organizations and log streams.

### Pillar D: Encrypted ai-context Exports
`src/export.ts` (`runExport`, shared by the CLI and the MCP tool) drives one export into one folder through `startExport` in `src/ai-context/export-folder.ts`:
- A range is fetched in windows of at most 250k downloaded rows. The provider pages each window with a time cursor and 5 parallel slices.
- Each window appends one encrypted frame to every `services/<service>/<level>.lhub` file it touches.
- After the last window, the flows of the export's failing requests go to `rcid/`, and SUMMARY / patterns / manifest cover the whole export.

Framework noise is filtered out in SQL and only counted by server-side GROUP BY (`exportAggregates`); request flows keep it. See OPENOBSERVE_GUIDE.md "ai-context exports" and "What an export keeps and what it skips". `src/ai-context/` is the only reader: `lhub.ts` (file format and crypto), `read.ts` (list, open, dedupe), `summary.ts` (SUMMARY text), `model.ts` (lines, patterns, names, windows).
```mermaid
flowchart LR
    Export["runExport (CLI / export_openobserve_logs)"] -->|"one window of rows"| Add["startExport().addWindow:\nappend frame per service/level"]
    Add --> Files[("ai-context/.../&lt;from&gt;_&lt;to&gt;_..._&lt;rows&gt;/\nservices/*/*.lhub, rcid/*.lhub, SUMMARY.lhub")]
    Export -->|"after last window"| Finish["addFlows + finish:\nrcid/, SUMMARY, rename folder"]
    Finish --> Files
    Files --> Read["read_ai_context (folder + file)"]
    Read -->|"file header: env + org name"| Key["OpenObserveProvider.organizationKey\n(account from config/openobserve.&lt;env&gt;.env)"]
    Key -->|"identifier, only if enabled"| Open["openSnapshot / readLhub\n(one file, in memory)"]
```
- Each `.lhub` file has a plaintext, authenticated header (env, Organization name, stream, kind) followed by frames. Each frame is Brotli + AES-256-GCM, with key = HKDF(identifier, the file's salt). Folder and file names are plaintext; log content is only inside frames.
- `organizationKey` lists the Organizations of the account saved for the export's env. It returns the identifier only when the Organization is listed, so connecting to the environment without access to that Organization is not enough.
- Organization identifiers are never written to disk; the process log masks them (`maskOrg`).

### Pillar E: Tests as the Safety Net
`npm test` builds, preloads `src/tests/env.ts` (temp `LOG_DIR` / `CONFIG_DIR` / `AI_CONTEXT_DIR`, no accounts) and runs every `src/tests/*.test.ts` with `node:test` and a coverage gate. Providers are tested against fake servers (`src/tests/helpers.ts`), MCP tools through a real client/server pair over `InMemoryTransport`, and the CLI and stdio server in child processes.

```mermaid
flowchart LR
    Change["code change"] --> Build["npm run build\n(clean dist, tsc strict)"]
    Build --> Tests["node --test + env.ts\n(temp folders, fake servers)"]
    Tests --> Gate{"all pass and\ncoverage ≥ 90/80/90?"}
    Gate -->|yes| Done["ready to commit"]
    Gate -->|no| Change
```

---

## 3. Environment Portability
- All file paths (logs, configurations, ai-context) are resolved from `PROJECT_ROOT` (`fileURLToPath(import.meta.url)` + `node:path.resolve`) and can be moved with `LOG_DIR`, `CONFIG_DIR` and `AI_CONTEXT_DIR`.
- No operating system-specific path separators or drive letters are hardcoded.
- Runs identically on Windows (PowerShell/CMD), Linux, macOS, and containerized Docker environments.
