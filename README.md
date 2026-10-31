# mcp-server-logs

> **Model Context Protocol (MCP) server for Seq and OpenObserve log search.**

Built for **100% AI Vibe-Coding**, maximum portability, zero supply-chain bloat, and seamless integration as either a **standalone MCP server** or a **child feature inside a Master MCP Orchestrator**.

---

## 🌟 Key Highlights

- **Multi-Provider Hub**: Query logs from **Seq** and **OpenObserve** through a unified interface.
- **Dual-Mode Architecture**:
  - **Standalone Mode**: Runs over stdio JSON-RPC or interactive terminal CLI.
  - **Parent MCP Integration**: Can be mounted in-process into a Master MCP orchestrator via `registerLogsTools()` with custom namespaces.
- **Strict Stdio Safety**: `stdout` is 100% reserved for JSON-RPC; diagnostics and errors are isolated to `process.stderr` and `logs/YYYY/MM/mcp-process-YYYY-MM-DD.log`.
- **Zero-Bloat Engineering (Ponytail)**: Only 2 dependencies (`@modelcontextprotocol/sdk` and `zod`). Uses native `fetch`, native `node:readline`, and stdlib file streaming.
- **Preflight Diagnostics**: Automated startup health scanner checking Node version, directory write permissions, and provider credentials.
- **Universal Portability**: Strictly uses relative path resolution. Deploy anywhere (Windows, macOS, Linux, Docker).

---

## 🚀 Quick Start

### 1. Installation
Requires Node.js 22+ and npm on PATH (including in the AI client's environment). Pick one:

```bash
# From source (any OS): start.mjs checks Node, runs `npm ci` when node_modules is missing,
# incomplete or older than npm-shrinkwrap.json, rebuilds when src/ changed, then starts the server.
git clone <REPO_URL>
cd mcp-server-logs
node start.mjs            # same as `npm start`; add --cli or --preflight

# As a package: build a tarball and install it anywhere
npm ci
npm pack                  # -> mcp-server-logs-1.0.0.tgz (CLI, dist, lock and config examples)
npm i -g ./mcp-server-logs-1.0.0.tgz
mcp-server-logs --preflight
```

Which OpenObserve account MCP mode uses:
- One server serves every environment: OpenObserve tools take `env` (`dev`, `stg` or `prod`) and use `config/openobserve.<env>.env` for that call. Register the server once (`mcp-logs`), never once per environment.
- Calls without `env` use the default: `OPENOBSERVE_ENV` picks `config/openobserve.<env>.env` (its values win over `OPENOBSERVE_*` variables); without it, `OPENOBSERVE_URL` / `OPENOBSERVE_EMAIL` / `OPENOBSERVE_TOKEN` from the MCP client `env` block, else `config/openobserve.dev.env` when it has a URL.
- Seq: `SEQ_SERVER_URL` / `SEQ_API_KEY` variables win over `config/seq.env`.

Optional settings (`LOG_DIR`, `CONFIG_DIR`, `AI_CONTEXT_DIR`, `OPENOBSERVE_ENV`, `AI_CONTEXT_TIME_ZONE`) can go in a root `.env`; see `.env.example`.

### 2. Configure Credentials
Keep a separate logging account for each provider. For Seq, run `npm run cli`, choose **1. Seq** and enter the connection details; they are saved in the Git-ignored `config/seq.env`. For OpenObserve, the first start creates `config/openobserve.dev.env`, `config/openobserve.stg.env` and `config/openobserve.prod.env` from `config/openobserve.env.example`; fill in that environment's URL, service-account email and token (a Basic credential in `OPENOBSERVE_TOKEN` is split into email and token automatically). Example placeholders (`your_…`, `…@example.com`) count as empty. The CLI only reads these files: choosing **2. Observe** → **DEV / STG / PROD** connects with that file, or reports `Connect failed: … missing or incomplete (…)` listing what to fill in. OpenObserve uses a service-account email and token, not the browser session cookie. See [the OpenObserve guide](docs/OPENOBSERVE_GUIDE.md) for token creation, Organization permissions, CLI use, and MCP tools.

### 3. Verify Health & Test Interactively
Run the interactive CLI menu:
```bash
npm run cli
```
Or run the non-interactive preflight check:
```bash
npm run preflight
```

---

## 🔀 Running under mcp-hub

If you use [mcp-hub](../mcp-hub/README.md), the hub starts this server for you; skip the direct-connection steps below.

- Clone this repo next to `mcp-hub`, in the same parent folder: the hub template runs `node start.mjs` with `cwd: ../mcp-server-logs`.
- Setup steps: `../mcp-hub/README.md` (Default setup). Tool contract: `../mcp-hub/docs/mcps/mcp-server-logs.md`.
- Fill `config/openobserve.<env>.env` for dev, stg and prod (the hub smoke check calls each), then run `node start.mjs --preflight` once before first use.
- Do not also register a direct `mcp-logs` server in the same client; every tool would appear twice.
- The hub exposes the tools as `logs__<tool>` (e.g. `logs__query_logs`). It does not forward this server's MCP instructions or prompts (`investigate_api_bug`, `analyze_ai_context`); agents get the hub's contract instead.

---

## 📋 Copy-paste prompts

Copy a block, replace the `<…>` values, paste it into your AI agent (Antigravity, Claude Code, Claude Desktop, Cursor, VS Code Copilot, Codex, Kiro, Zed, …). Nothing else to edit by hand.

| Placeholder | Replace with | Example |
|---|---|---|
| `<MCP_LOGS_PATH>` | absolute path of your clone of this repo, **forward slashes** | `C:/tools/mcp-server-logs`, `/Users/me/mcp-server-logs` |
| `<ENVS>` | OpenObserve environments to set up (prompt 1) | `dev, prod` |
| `<ENV>` | OpenObserve environment of one question: `dev`, `stg` or `prod` | `prod` |
| `<stream>`, `<service>` | OpenObserve stream / service name (optional: the agent lists them if you leave them out) | `shop_prod`, `Shop.Api` |

### 1. Connect mcp-server-logs (once per machine and client)
Run it in the workspace where you want to use the logs (e.g. your backend repo). The agent installs and builds, asks you for the OpenObserve account of each environment whose `config/openobserve.<env>.env` is not filled in yet, registers one `mcp-logs` server in its own MCP config and checks the connection ([what it does](docs/AI_AGENT_SETUP.md)).

```text
Read the file <MCP_LOGS_PATH>/docs/AI_AGENT_SETUP.md and follow it to connect mcp-server-logs to yourself
as one server named mcp-logs. Environments to set up: <ENVS>. The repo is already cloned at <MCP_LOGS_PATH>.
Register it in your global MCP config, then verify with list_openobserve_organizations.
```

Variations: `with Seq too` · `only for this workspace` (instead of global). Some clients must be reloaded by you after this step (Antigravity: Agent panel → `…` → MCP Servers → Manage MCP Servers → Refresh; Claude Desktop: quit and reopen; VS Code: *MCP: List Servers* → Start); the agent tells you which, then reply `done`.

### 2. Investigate a bug (live logs + this workspace's source)
```text
Use mcp-logs on <ENV>: <describe the bug, e.g. "saving an order returns 500 since this morning">.
Search the last 24h of <stream> (service <service>) for related errors, follow the failing
request by its rcid across services, then find the cause in this repository's source.
Cite the log lines and the source files.
```

### 3. Analyse the newest ai-context export
```text
Use mcp-logs: read the newest ai-context export of <stream> with read_ai_context
(SUMMARY first, then the file:line it points to, then the rcid/ flow).
Find the most frequent bug, explain its cause using this repository's source, and propose a fix.
```

### 4. Export logs to ai-context (to analyse later or share)
```text
Use mcp-logs on <ENV>: export the Warning and Error logs of service <service> in stream <stream>
for the last 24h to ai-context with export_openobserve_logs, then summarise the export.
```

### 5. Optional rule for the workspace (so you never repeat the reading order)
Add it as a rule of the repository where you use the logs (Antigravity: Customizations → Rules; Cursor: `.cursor/rules`; Claude Code: `CLAUDE.md`; Copilot: `.github/copilot-instructions.md`):

```text
Logs: use the mcp-logs MCP tools; pass env (dev, stg, prod) to OpenObserve tools when I name an environment. Read ai-context exports only with list_ai_context_snapshots and
read_ai_context (SUMMARY first, then the file:line it points to, then rcid/). Never open .lhub
files or the ai-context/ folder directly. Compare the logs with this repository's source and cite both.
```

---

## 🤖 Connecting to AI Clients (Claude Code / Claude Desktop / Antigravity / Cursor)

The easiest way is prompt 1 above; [docs/AI_AGENT_SETUP.md](docs/AI_AGENT_SETUP.md) lists every client's config file. To do it by hand:

Claude Code:

```bash
claude mcp add --scope user mcp-logs -- node "<MCP_LOGS_PATH>/start.mjs"
```

Other clients: add `mcp-server-logs` to `claude_desktop_config.json`, `.cursor/mcp.json` or the Antigravity MCP settings. Use the absolute path of your clone (quotes are not needed in JSON, even with spaces). `env` is optional: `OPENOBSERVE_ENV` only sets the default environment, and Seq can come from `config/seq.env` instead:

```json
{
  "mcpServers": {
    "mcp-logs": {
      "command": "node",
      "args": ["<MCP_LOGS_PATH>/start.mjs"],
      "env": {
        "OPENOBSERVE_ENV": "dev",
        "SEQ_SERVER_URL": "https://seq.example.com",
        "SEQ_API_KEY": "<read-only Seq API key>"
      }
    }
  }
}
```

### Using the encrypted ai-context exports

Exports (`export_openobserve_logs`, or **Save to ai-context** in the CLI) are encrypted folders under `ai-context/`. Live searches are saved there too, so the same search repeated (same SQL, environment and window; relative bounds such as `15m` count from the start of the current minute) is answered locally without calling OpenObserve; see [Use from an AI Agent](docs/OPENOBSERVE_GUIDE.md#4-use-from-an-ai-agent). You never open the `.lhub` files yourself: ask your AI agent, which reads them through the MCP tools.

```
You: "List the ai-context exports" / "Read the SUMMARY of <folder>: which error happens most?" / "Open the flow of rcid X and compare it with the Shop.Email source"
  └─► list_ai_context_snapshots            folder names only, no access needed
  └─► read_ai_context(snapshot)            SUMMARY.lhub: Bugs table, top patterns with file:line
        checks: config/openobserve.<env>.env connects AND is enabled for the export's organization
  └─► read_ai_context(file, offset)        services/<service>/<level>.lhub at that line
  └─► read_ai_context(file = rcid/…)       the failing request end to end; or grep = "<rcid>"
```

To share exports, send the `ai-context/` folder (never `config/` or `logs/`). The colleague clones this repository, fills in `config/openobserve.<env>.env` with their own account and connects the MCP server; their account must be enabled for the export's organization. See [ai-context exports](docs/OPENOBSERVE_GUIDE.md#ai-context-exports).

### Using it from another repository (e.g. Antigravity on your backend repo)

The agent working in your backend repo starts this repository as an MCP server and reads ai-context **only through `read_ai_context`**. It never needs, and should never get, the path of `ai-context/`.

```
Backend repo open in Antigravity
  AI agent ──► client starts: node <this repo>/start.mjs   (installs/builds if needed; one server for dev/stg/prod)
           ◄── on connect, server instructions: "read ai-context only through read_ai_context, never open .lhub files"
                (direct connection only; under mcp-hub the agent gets the hub's contract)
  AI agent ──► list_ai_context_snapshots ─► read_ai_context (SUMMARY → file:line → rcid/)
                                               └─ each call: account for that env ↔ organization → decrypt in memory
  AI agent ──► compares the logs with the backend source in its own workspace
```

1. **Register the server** in Antigravity: Agent panel → `…` → **MCP Servers** → **Manage MCP Servers** → **View raw config** (`mcp_config.json`). Add one block (it serves every environment), then refresh:
   ```json
   {
     "mcpServers": {
       "mcp-logs": {
         "command": "node",
         "args": ["<MCP_LOGS_PATH>/start.mjs"]
       }
     }
   }
   ```
   Cursor (`.cursor/mcp.json`) and Claude Code (`claude mcp add --scope user mcp-logs -- node "<MCP_LOGS_PATH>/start.mjs"`) work the same way.
2. **Ask.** Use the `analyze_ai_context` prompt (question, optional export folder), or [copy-paste prompt 3](#3-analyse-the-newest-ai-context-export).
3. **Optional rule in the backend repo**, so you do not have to repeat it: [copy-paste prompt 5](#5-optional-rule-for-the-workspace-so-you-never-repeat-the-reading-order).

The server already sends the same rules as MCP *server instructions* when the agent connects, so most agents follow them without the extra rule (direct connection only; under mcp-hub see [Running under mcp-hub](#-running-under-mcp-hub)).

**Lifecycle and resources.** The client starts the server once (when it opens, or when you enable the server) and keeps it for the whole session; it is not started per call. It exits when the client closes it (closing the app, disabling or refreshing the server). Measured on Windows:

| State | RAM | CPU |
|---|---|---|
| Idle | ~120 MB (launcher `start.mjs` ~50 MB + server ~70 MB) | ~0 |
| Reading a file | + the size of that decrypted file, released after 5 idle minutes | a few hundred ms per call |
| Exporting 24h (DEV, 375k rows) | up to ~1.75 GB, only during the export | ~26% of one core |

The one `mcp-logs` entry is one process for every environment; a second entry pointing at the same clone would only start a second process.

---

## 🧪 Development

```bash
npm test    # build, then every test with a fake OpenObserve/Seq in a temp folder; fails below 90% line coverage
npm run check:package  # pack, install in a temp folder and run preflight without credentials or upstream calls
```

Tests never touch the real `config/`, `logs/` or `ai-context/` and never call a real server. See [AGENTS.md](AGENTS.md) for the code layout and rules.

---

## 🧩 Master MCP / Router Orchestrator Integration

To consume this repository inside a Master MCP without subprocess overhead:

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerLogsTools } from 'mcp-server-logs';

const masterMcp = new McpServer({ name: 'master-orchestrator', version: '1.0.0' });

// Mount mcp-server-logs tools with an optional namespace prefix
registerLogsTools(masterMcp, { prefix: 'logs__' });
```

See [docs/PARENT_MCP_GUIDE.md](docs/PARENT_MCP_GUIDE.md) for full instructions and examples.

---

## 📚 Documentation Index

- [AGENTS.md](AGENTS.md) - Master manual and prompt guidelines for AI Agents (Vibe-Coding).
- [docs/AI_AGENT_SETUP.md](docs/AI_AGENT_SETUP.md) - Runbook an AI agent follows to connect this server to its own client (Antigravity, Claude, Cursor, Copilot, Codex, …).
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) - High-level system design, provider pattern, and stdio data flow.
- [docs/PARENT_MCP_GUIDE.md](docs/PARENT_MCP_GUIDE.md) - Integration guide for Master / Orchestrator MCPs.
- [docs/STANDARDS.md](docs/STANDARDS.md) - Coding standards, type normalization, and error handling.
- [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md) - Complete package catalog and architectural justification.
- [docs/CLI_GUIDE.md](docs/CLI_GUIDE.md) - CLI menu walkthrough and preflight troubleshooting.
- [docs/OPENOBSERVE_GUIDE.md](docs/OPENOBSERVE_GUIDE.md) - OpenObserve account, token, Organization, stream, and search setup.

---

## 📄 License
MIT
