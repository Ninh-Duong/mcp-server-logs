# Master / Parent MCP Orchestration Guide

This document describes how a **Master MCP Server** or **Router MCP** can orchestrate and consume `mcp-server-logs` as a child feature.

---

## Pattern 1: Direct In-Process Module Mounting (Recommended)

When both the Master MCP and `mcp-server-logs` are part of the same Node.js project or monorepo, you can mount the tools directly into the Master MCP server instance.

### Advantages:
- Zero IPC (Inter-Process Communication) latency.
- No child process management or subprocess crashing.
- Shares the same process memory and execution context.

### Code Example:
```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerLogsTools, LogsService } from 'mcp-server-logs';

// 1. Initialize your Master MCP Server
const masterServer = new McpServer({
  name: 'my-master-orchestrator',
  version: '2.0.0',
});

// 2. Mount mcp-server-logs tools with an optional namespace prefix
registerLogsTools(masterServer, {
  prefix: 'logs__', // e.g. 'logs__query_logs', 'logs__export_openobserve_logs' (the mcp-hub alias prefix)
});

// 3. Mount your other child features (e.g. database tools, metrics, deployment)
// registerDatabaseTools(masterServer);
// registerDeploymentTools(masterServer);

// 4. Connect Master Server
const transport = new StdioServerTransport();
await masterServer.connect(transport);
```

`registerLogsTools` registers 12 tools and 2 prompts (`investigate_api_bug`, `analyze_ai_context`), all with the prefix (see the list in [AGENTS.md](../AGENTS.md#4-mcp-tools-reference)). Every tool has a `title` and annotations: all are read-only except `export_openobserve_logs`, which writes a new folder under `ai-context/`. Agents can start with a prompt and follow its tool workflow. In-process, the mcp-server-logs reads its accounts from its own `config/` folder and environment variables, as in standalone mode.

One child serves every OpenObserve environment: its OpenObserve tools take an optional `env` (`dev`, `stg`, `prod`) per call, so mount it once (e.g. `logs__get_openobserve_service_logs({ env: 'prod', … })`), not once per environment.

Server instructions are set when a server is created, so mounting tools does not add them. The standalone server sends `logsInstructions()`, which tells agents to read ai-context only through `read_ai_context` and in which order. Append it to your own instructions, with the same prefix:

```typescript
import { logsInstructions, registerLogsTools } from 'mcp-server-logs';

const masterServer = new McpServer(
  { name: 'my-master-orchestrator', version: '2.0.0' },
  { instructions: `My orchestrator tools …\n\n${logsInstructions('logs__')}` },
);
registerLogsTools(masterServer, { prefix: 'logs__' });
```

---

## Pattern 2: Subprocess MCP Router (Process Isolation)

When the Master MCP runs as a separate process or is implemented in another language (Python, Go, Rust), you can spawn `mcp-server-logs` as a child subprocess over stdio.

### Advantages:
- Language-agnostic.
- Complete process isolation: a crash in the child does not crash the Master.

### Code Example (TypeScript / Node.js):
```typescript
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// 1. Create client connection pointing to mcp-server-logs
//    (mcp-hub instead expects a sibling layout: cwd ../mcp-server-logs, see ../mcp-hub/docs/mcps/mcp-server-logs.md)
const transport = new StdioClientTransport({
  command: 'node',
  args: ['./sub-mcps/mcp-server-logs/start.mjs'],
  env: {
    ...process.env,
    OPENOBSERVE_ENV: 'dev', // default env for calls without `env`: ./sub-mcps/mcp-server-logs/config/openobserve.dev.env
    SEQ_SERVER_URL: 'https://seq.example.com',
    SEQ_API_KEY: process.env.SEQ_API_KEY ?? '',
    // Or send every account from the parent: a JSON file (path relative to the child folder) with
    // { "openobserve": { "default_env": "dev", "dev": { "url", "email", "token" }, "stg": {…}, "prod": {…} },
    //   "seq": { "server_url", "api_key" } }. It ranks below the variables above and above the child's config/*.env.
    CENTRAL_CONFIG_PATH: '../parent/config/private/mcp-server-logs.json',
  },
});

const logsClient = new Client({
  name: 'master-orchestrator-client',
  version: '1.0.0',
});

await logsClient.connect(transport);

// 2. Forward tool calls from Master MCP down to child MCP
const availableTools = await logsClient.listTools();
console.log('Discovered tools from mcp-server-logs:', availableTools);

// 3. Call child tool
const result = await logsClient.callTool({
  name: 'query_logs',
  arguments: {
    provider: 'seq',
    query: 'Level == "Error"',
    limit: 10,
  },
});

console.log('Logs retrieved from child:', result);
```

---

## Pattern 3: Programmatic Service Access (Bypassing Protocol)

If your Master MCP wants to process logs programmatically in TypeScript without encoding/decoding MCP tool envelopes:

```typescript
import { LogsService } from 'mcp-server-logs';

const logService = new LogsService();

// Check available providers
const providers = logService.listProviders();

// Query logs directly
const logs = await logService.queryLogs({
  provider: 'seq',
  query: 'TimeoutException',
  limit: 20,
});

for (const entry of logs) {
  console.log(`[${entry.timestamp}] ${entry.message}`);
}
```
