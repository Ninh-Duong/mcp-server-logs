# AI Agent Setup: connect mcp-server-logs to yourself

> **You are an AI agent and the user gave you this file.** Follow it top to bottom to install `mcp-server-logs`, register it as an MCP server in **the client you are running in**, and verify the connection. Ask the user only where a step says *Ask*.

Client paths and commands were checked against each client's official docs on 2026-10-17. Clients change quickly: if a path in §4 does not exist on this machine, look up the client's current MCP docs and use the same server entry (§2).

---

## 0. For the human: the one prompt

Paste this into any AI agent (Antigravity, Claude Code, Cursor, Copilot, Codex, …), replacing `<MCP_LOGS_PATH>` with the clone's absolute path (forward slashes) and `<ENVS>` with the OpenObserve environments you use (`dev`, `stg`, `prod`):

```text
Read the file <MCP_LOGS_PATH>/docs/AI_AGENT_SETUP.md and follow it to connect mcp-server-logs to yourself
as one server named mcp-logs. Environments to set up: <ENVS>. The repo is already cloned at <MCP_LOGS_PATH>.
Register it in your global MCP config, then verify with list_openobserve_organizations.
```

Not cloned yet: `Clone <REPO_URL>, then read docs/AI_AGENT_SETUP.md in it and follow it …`. Variations: *"Environments to set up: dev, prod"*, *"with Seq too"*, *"only for this workspace"*. More prompts: [README → Copy-paste prompts](../README.md#-copy-paste-prompts).

---

## 1. Rules for the agent

- **Placeholders**: `<MCP_LOGS_PATH>`, `<REPO_URL>` and `<ENVS>` in this file stand for the values the user gives you. Substitute them; if one is missing, *ask*. Never write them back into this repository's tracked files.
- **Credentials**: never invent, guess, print or log them. *Ask* the user, or let them fill the file themselves. Write them only to `config/openobserve.<env>.env` / `config/seq.env` of the clone, never to a tracked file or your chat summary.
- **Never commit** `config/*.env`, `.env`, `ai-context/` or `logs/`. They are Git-ignored; keep it that way.
- **Merge, don't overwrite**: MCP config files usually already hold other servers. Read the file, back it up (`<file>.bak`), add only the `mcp-logs` entry, keep valid JSON/TOML/YAML.
- **Ask before writing global/user config.** If the user wants it only in the current workspace, use the client's project scope.
- **Absolute paths, forward slashes** in JSON: `<MCP_LOGS_PATH>/start.mjs`. No `~`, `%USERPROFILE%` or `$HOME` inside `args` (most clients do not expand them). Quote the path in shell commands (it may contain spaces).
- **One entry for every environment**: name it `mcp-logs`. Its OpenObserve tools take an `env` argument (`dev`, `stg`, `prod`) per call, so never register one entry per environment. `OPENOBSERVE_ENV` in the entry only sets the default for calls without `env`.
- **Migration**: if the client already has entries from the old name (`log-hub`, `log-hub-dev`, `log-hub-prod`, …, pointing at `…/mcp-server-log-hub/start.mjs`), replace them all with the one `mcp-logs` entry.
- Do not add anything to the server that writes to stdout: in MCP mode stdout is JSON-RPC.

---

## 2. The server entry (every client maps to this)

| Field | Value |
|---|---|
| transport | stdio (local process) |
| command | `node` (or the absolute node path, see step 3) |
| args | `["<MCP_LOGS_PATH>/start.mjs"]` where `<MCP_LOGS_PATH>` is the clone's absolute path |
| env | optional: `OPENOBSERVE_ENV` = default environment for calls without `env` (else the `OPENOBSERVE_URL`/`EMAIL`/`TOKEN` variables, else `dev` if its file has a URL); `SEQ_SERVER_URL`, `SEQ_API_KEY` |

The client launches `node start.mjs`. The launcher needs npm on the client's PATH to install or repair dependencies and rebuild when `src/` changed. Run the first preflight in a terminal before connecting to avoid a startup timeout.

JSON form (most clients):

```json
{
  "mcpServers": {
    "mcp-logs": {
      "command": "node",
      "args": ["<MCP_LOGS_PATH>/start.mjs"],
      "env": { "OPENOBSERVE_ENV": "dev" }
    }
  }
}
```

TOML form (Codex): see §4.12.

---

## 3. Steps

Each step ends with **Done when**. Stop and tell the user if a step cannot be done.

### Step 1: Identify your client and OS
Know which client you are running in (your own system prompt or product name usually says it). If unsure, *ask* the user. Detect the OS (`win32`, `darwin`, `linux`) and the shell (PowerShell vs bash) so you use the right commands.
**Done when** you have picked one subsection of §4.

### Step 2: Find or clone the repository
1. If the user named a local clone, or `start.mjs` + `package.json` with `"name": "mcp-server-logs"` exist in a folder you know of, use it.
2. Otherwise *ask* where to put it (suggest a sibling of the current workspace) and clone:
   ```bash
   git clone <REPO_URL>
   ```
3. Record `<MCP_LOGS_PATH>`, the absolute path of the clone, with forward slashes.

**Done when** `<MCP_LOGS_PATH>/start.mjs` exists.

### Step 3: Check Node.js 22+
```bash
node -v
npm -v
```
If it is older than 22, or missing, stop: ask the user to install Node 22 LTS or newer (https://nodejs.org).
Also record the absolute path of node (`where node` on Windows, `which node` elsewhere). GUI apps (Claude Desktop, Cursor, JetBrains, …) started from the Start menu or Dock may not see a node that nvm/fnm/volta put on your shell PATH. Use the absolute path as `command` if the server fails to spawn (§6).
Check that npm is also available on the AI client's PATH; source installation, repair and builds invoke it even though the configured launch command is `node`.
**Done when** Node is 22 or newer and npm is available.

### Step 4: Install, build and create the account files
```bash
cd "<MCP_LOGS_PATH>"
node start.mjs --preflight
```
The first run takes a minute or two (`npm ci`, then `npm run build`). It creates `config/openobserve.dev.env`, `config/openobserve.stg.env`, `config/openobserve.prod.env` and `config/seq.env` from the examples when they are missing, then prints a table:

```text
[PASS] Node.js Runtime           : Node.js v22.x detected (>= 22 required).
[PASS] Logs Storage              : Write access confirmed for logs folder: …
[WARN] Seq Provider              : Unconfigured (…)
[WARN] OpenObserve Provider      : Unconfigured for DEV (…)
[WARN] OpenObserve DEV           : env 'dev' unavailable: fill in config/openobserve.dev.env
[WARN] OpenObserve STG           : env 'stg' unavailable: fill in config/openobserve.stg.env
[WARN] OpenObserve PROD          : env 'prod' unavailable: fill in config/openobserve.prod.env
```

Running this before registering also avoids a client timeout on the first start.
**Done when** the table prints and Node / Logs are `PASS`.

### Step 5: Fill in the account
1. *Ask* which environments (`dev`, `stg`, `prod`) and whether Seq is needed.
2. For each environment, open `<MCP_LOGS_PATH>/config/openobserve.<env>.env`. Values that are still example placeholders (starting `your_` or ending `@example.com`) count as empty. If it is not filled, *ask* the user for:
   - `OPENOBSERVE_URL`: the OpenObserve base URL (HTTPS)
   - `OPENOBSERVE_EMAIL`: the **service account** email
   - `OPENOBSERVE_TOKEN`: that account's token (a pasted `Basic …` credential also works; the browser session cookie does not)

   Write the file, or let the user write it if they prefer not to paste secrets into chat:
   ```text
   OPENOBSERVE_URL=https://observe.example.org
   OPENOBSERVE_EMAIL=logging-reader@company.com
   OPENOBSERVE_TOKEN=<token>
   ```
   How to create the token and enable the account for an organization: [OPENOBSERVE_GUIDE.md](OPENOBSERVE_GUIDE.md).
3. Seq (optional): `SEQ_SERVER_URL` and a read-only `SEQ_API_KEY` in `<MCP_LOGS_PATH>/config/seq.env`, or in the entry's `env`.
4. Re-run `node start.mjs --preflight`.

**Done when** each environment the user asked for shows `[PASS] OpenObserve <ENV> : env '<env>' available` (it only checks the values are present; step 7 checks the connection).

### Step 6: Register the server in your client
Go to your client's subsection in §4 and add the one `mcp-logs` entry (§2); remove old `log-hub*` entries (§1 Migration). Prefer the client's own CLI command when it has one; otherwise merge into its config file.
**Done when** the entry is saved and the file still parses.

### Step 7: Reload and verify
1. Reload as your client's subsection says. Some clients must be restarted by the user; if so, tell them exactly what to click, and continue after they confirm.
2. Call `list_log_providers`. Expect `openobserve_environments` to show `configured: true` for each environment set up (and `seq` if set up). This reads the config only.
3. For each environment, call `list_openobserve_organizations` with `env` (e.g. `{ "env": "prod" }`). This connects to OpenObserve. A list of organizations means that account works.
4. Report to the user: the server name `mcp-logs`, the environments that work, the config file you changed, and the result of step 3.

**Done when** `list_openobserve_organizations` returns organizations for every environment set up.

---

## 4. Client reference

Every subsection registers the one `mcp-logs` entry, with `<MCP_LOGS_PATH>` = the clone's absolute path. The `OPENOBSERVE_ENV=dev` in the examples is only the default environment; drop it or change it as the user prefers.

### 4.1 Google Antigravity (IDE and `agy` CLI)
- **Files**: global `~/.gemini/config/mcp_config.json` (Windows: `%USERPROFILE%\.gemini\config\mcp_config.json`); workspace `.agents/mcp_config.json`. Older builds used `~/.gemini/antigravity/mcp_config.json`; if that file exists and the new one does not, use it.
- **Shape**: `mcpServers` exactly as §2. Optional `cwd`, `disabled`.
- **IDE**: Agent panel → `…` → **MCP Servers** → **Manage MCP Servers** → **View raw config**, paste, save, then **Refresh**.
- **CLI**: `/mcp` opens the MCP Manager (status and reload).

### 4.2 Claude Code (CLI, VS Code and JetBrains extensions)
```bash
claude mcp add --transport stdio --scope user --env OPENOBSERVE_ENV=dev mcp-logs -- node "<MCP_LOGS_PATH>/start.mjs"
```
- Scopes: `local` (default, this project only, in `~/.claude.json`), `project` (writes `.mcp.json` at the repo root, shared via Git), `user` (all projects).
- Keep the name after the options; a name right after `--env` is parsed as `KEY=value`.
- Project file shape: `{"mcpServers":{"mcp-logs":{"type":"stdio","command":"node","args":["<MCP_LOGS_PATH>/start.mjs"],"env":{"OPENOBSERVE_ENV":"dev"}}}}`.
- **Verify**: `claude mcp list`, `claude mcp get mcp-logs`, or `/mcp` in a session. `.mcp.json` servers ask for approval in the next interactive session.

### 4.3 Claude Desktop
- **File**: Windows `%APPDATA%\Claude\claude_desktop_config.json`; macOS `~/Library/Application Support/Claude/claude_desktop_config.json`; Linux `~/.config/Claude/claude_desktop_config.json`. Opened by Settings → Developer → **Edit Config**.
- Windows Store (MSIX) builds read `%LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude\claude_desktop_config.json` instead; if your edit has no effect, check there.
- **Shape**: §2, no `type`. Use the absolute node path if spawning fails.
- **Reload**: quit Claude Desktop completely (tray icon → Quit) and reopen. Logs: `%APPDATA%\Claude\logs\mcp-server-mcp-logs.log` or `~/Library/Logs/Claude/`.

### 4.4 Cursor (editor and CLI)
- **Files**: global `~/.cursor/mcp.json`; project `.cursor/mcp.json`.
- **Shape**: §2 plus `"type": "stdio"`.
- **UI**: Settings → MCP, toggle per server. Logs: Output panel → **MCP Logs**. CLI: `agent mcp list`.

### 4.5 Devin Desktop (formerly Windsurf)
- **Files**: `~/.config/devin/mcp_config.json` (Windows `%APPDATA%\devin\mcp_config.json`); project `.devin/mcp_config.json`. Older Windsurf builds: `~/.codeium/windsurf/mcp_config.json`.
- **Shape**: §2, no `type`.
- **CLI**: `devin mcp add -s user mcp-logs -- node "<MCP_LOGS_PATH>/start.mjs"`, then add `env` in the file.
- **UI**: Cascade panel `…` → MCPs → refresh / toggle.

### 4.6 VS Code + GitHub Copilot
- **Files**: workspace `.vscode/mcp.json`; user profile `mcp.json` (Command Palette → **MCP: Open User Configuration**).
- **Shape**: top-level key is **`servers`**, not `mcpServers`:
  ```json
  {
    "servers": {
      "mcp-logs": {
        "type": "stdio",
        "command": "node",
        "args": ["<MCP_LOGS_PATH>/start.mjs"],
        "env": { "OPENOBSERVE_ENV": "dev" }
      }
    }
  }
  ```
- **Reload**: Command Palette → **MCP: List Servers** → `mcp-logs` → Start (or Restart). Accept the trust prompt. Use Copilot Chat in **Agent** mode.

### 4.7 GitHub Copilot CLI
```bash
copilot mcp add mcp-logs --env OPENOBSERVE_ENV=dev -- node "<MCP_LOGS_PATH>/start.mjs"
```
- **Files**: user `~/.copilot/mcp-config.json`; project `.mcp.json` or `.github/mcp.json`.
- **Shape**: `mcpServers` with `"type": "local"`, `command`, `args`, `env`, `"tools": ["*"]`.
- **Verify**: `/mcp list` or `copilot mcp list`. Project servers load after you trust the folder.

### 4.8 Cline
- **File**: `~/.cline/data/settings/cline_mcp_settings.json` (or `$CLINE_MCP_SETTINGS_PATH`). Older VS Code installs: `<VS Code user dir>/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`. Easiest: Cline pane → MCP Servers icon → **Configure MCP Servers** opens the right file.
- **Shape**: `mcpServers` with **`"type": "stdio"`** (without it, Cline assumes SSE), `command`, `args`, `env`, `"disabled": false`.
- **Reload**: restart button on the server in the MCP Servers view.

### 4.9 Roo Code
- **Files**: project `.roo/mcp.json` (wins on a name clash); global `mcp_settings.json` (Roo pane → MCP icon → **Edit Global MCP**).
- **Shape**: §2 (`type` defaults to stdio). Optional `timeout` in seconds.
- **Reload**: restart button / toggle per server in the MCP view.

### 4.10 Continue
- **File**: `.continue/mcpServers/mcp-logs.yaml` in the workspace:
  ```yaml
  name: mcp-server-logs
  version: 0.0.1
  schema: v1
  mcpServers:
    - name: mcp-logs
      type: stdio
      command: node
      args: ["<MCP_LOGS_PATH>/start.mjs"]
      env:
        OPENOBSERVE_ENV: dev
  ```
  Or the same `mcpServers` list in `~/.continue/config.yaml`.
- MCP tools work in **Agent** mode only. Saving the file reloads it.

### 4.11 Gemini CLI (being replaced by Antigravity CLI, §4.1)
```bash
gemini mcp add -s user -e OPENOBSERVE_ENV=dev mcp-logs node "<MCP_LOGS_PATH>/start.mjs"
```
- **Files**: `~/.gemini/settings.json` or project `.gemini/settings.json`, key `mcpServers` (§2).
- **Verify**: `gemini mcp list` or `/mcp`. Stdio servers connect only in trusted folders.

### 4.12 OpenAI Codex (CLI, IDE extension and desktop app share one config)
```bash
codex mcp add mcp-logs --env OPENOBSERVE_ENV=dev -- node "<MCP_LOGS_PATH>/start.mjs"
```
- **Files**: `~/.codex/config.toml`; project `.codex/config.toml` (trusted projects only).
- **Shape** (raise the startup timeout: the default 10 s can be too short for the first start):
  ```toml
  [mcp_servers.mcp-logs]
  command = "node"
  args = ['<MCP_LOGS_PATH>/start.mjs']
  startup_timeout_sec = 120

  [mcp_servers.mcp-logs.env]
  OPENOBSERVE_ENV = "dev"
  ```
  Use single-quoted TOML strings for Windows paths (no escaping).
- **Verify**: `codex mcp list` or `/mcp`. IDE: gear → Restart extension.

### 4.13 Zed
- **Files**: `~/.config/zed/settings.json` (Windows `%APPDATA%\Zed\settings.json`); project `.zed/settings.json`.
- **Shape**: key **`context_servers`**:
  ```json
  "context_servers": {
    "mcp-logs": {
      "command": "node",
      "args": ["<MCP_LOGS_PATH>/start.mjs"],
      "env": { "OPENOBSERVE_ENV": "dev" }
    }
  }
  ```
- **Verify**: Agent panel settings, the green dot "Server is active". Reloads automatically.

### 4.14 JetBrains AI Assistant and Junie
- **AI Assistant** (UI only): Settings → Tools → AI Assistant → **Model Context Protocol (MCP)** → Add → STDIO → paste the §2 JSON. Choose Global or Project level. Status column shows the connection; **Reconnect** reloads.
- **Junie**: files `~/.junie/mcp/mcp.json` (global) and `.junie/mcp/mcp.json` (project), key `mcpServers` (§2). IDE: Settings → Tools → Junie → MCP Settings. CLI: `/mcp`.

### 4.15 Kiro (IDE and `kiro-cli`, which replaced the Amazon Q Developer CLI)
- **Files**: user `~/.kiro/settings/mcp.json`; workspace `.kiro/settings/mcp.json`.
- **Shape**: §2. Optional `disabled`, `autoApprove`.
- **CLI**: `kiro-cli mcp add --name mcp-logs --command node --args "<MCP_LOGS_PATH>/start.mjs" --env OPENOBSERVE_ENV=dev` (check `kiro-cli mcp add --help` for the scope flag).
- **Reload**: saving the file reconnects. Status: Kiro panel → MCP servers. Logs: Output → **Kiro - MCP Logs**.

### 4.16 Amazon Q Developer (IDE plugin)
- **UI**: Q Chat → tools icon → `+` → scope Global (`~/.aws/amazonq/default.json`) or Local (`.amazonq/default.json`) → transport stdio, command `node`, argument `<MCP_LOGS_PATH>/start.mjs`, env `OPENOBSERVE_ENV=dev`.
- Legacy `~/.aws/amazonq/mcp.json` (key `mcpServers`, §2) is still read. For the CLI, use Kiro (§4.15).

### 4.17 OpenCode
- **Files**: global `~/.config/opencode/opencode.json`; project `opencode.json`.
- **Shape**: key `mcp`, `command` is one array, env key is `environment`:
  ```json
  {
    "$schema": "https://opencode.ai/config.json",
    "mcp": {
      "mcp-logs": {
        "type": "local",
        "command": ["node", "<MCP_LOGS_PATH>/start.mjs"],
        "environment": { "OPENOBSERVE_ENV": "dev" },
        "enabled": true,
        "timeout": 60000
      }
    }
  }
  ```
- **Verify**: `opencode mcp list`. Restart OpenCode after editing.

### 4.18 Goose
- **File**: `~/.config/goose/config.yaml` (Windows `%APPDATA%\Block\goose\config\config.yaml`):
  ```yaml
  extensions:
    mcp-logs:
      name: mcp-logs
      type: stdio
      cmd: node
      args: ["<MCP_LOGS_PATH>/start.mjs"]
      envs:
        OPENOBSERVE_ENV: dev
      enabled: true
      timeout: 300
  ```
- Or `goose configure` → Add Extension → Command-line Extension. Desktop: Extensions → Add custom extension → Standard IO. Applies to new sessions.

### 4.19 Any other MCP client
Find its "stdio" / "local" / "command" server config (*ask* the user if you cannot), and map §2 onto it: a name, the command `node`, one argument `<MCP_LOGS_PATH>/start.mjs`, one environment variable `OPENOBSERVE_ENV`. Watch for the three common variations: the top-level key (`mcpServers`, `servers`, `context_servers`, `mcp`, `extensions`), whether `type` is required (`stdio` or `local`), and whether command and args are one array.

---

## 5. Environments, and Seq

One `mcp-logs` server serves dev, stg and prod. Each OpenObserve tool (and `query_logs`, `export_openobserve_logs`) takes `env`:

```text
list_openobserve_organizations  { "env": "prod" }
get_openobserve_service_logs    { "env": "prod", "organization": "…", "stream": "…", "level": "Error", "from": "1h" }
```

- `env` picks `config/openobserve.<env>.env` for that call only. Without `env`, the default is used: `OPENOBSERVE_ENV` from the entry, else `OPENOBSERVE_URL` / `OPENOBSERVE_EMAIL` / `OPENOBSERVE_TOKEN` from the entry, else `config/openobserve.dev.env` if it has a URL, else no default (pass `env`).
- Under mcp-hub, the hub can send the accounts instead: `CENTRAL_CONFIG_PATH` in the entry's `env` names a JSON file whose `openobserve` / `seq` sections win over the `config/*.env` files; an empty hub value falls back to the file (see `../mcp-hub/docs/mcps/mcp-server-logs.md`). `list_log_providers` and `--preflight` show where each account comes from: `env`, `hub`, `local` or `unset`.
- `read_ai_context` needs no `env`: it uses the environment written in the export.
- An environment works once its file is filled in (step 5); no change to the client config is needed.
- Seq: `SEQ_SERVER_URL` / `SEQ_API_KEY` in the entry's `env` win over `config/seq.env`. Prefer the file, so the key is not in the client config:
  ```json
  { "mcpServers": { "mcp-logs": { "command": "node", "args": ["<MCP_LOGS_PATH>/start.mjs"],
    "env": { "SEQ_SERVER_URL": "https://seq.example.com", "SEQ_API_KEY": "<read-only key>" } } } }
  ```

---

## 6. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `[start] Node … is too old` | Install Node 22+; point `command` at the new `node` absolute path. |
| `'npm ci' failed` | Network / proxy / registry problem. Run `node start.mjs --preflight` in a terminal, fix the npm error shown, retry. |
| Server not listed in the client | Wrong file or key (§4), invalid JSON after the edit, backslashes not escaped, client not reloaded. Restore the `.bak` if needed. |
| `spawn node ENOENT` / server fails to start in a GUI app | The app does not see your shell PATH. Use the absolute node path from step 3 as `command`. |
| Timeout on first start | The first run installs and builds. Run step 4 first, or raise the client's startup timeout (Codex `startup_timeout_sec`, OpenCode `timeout`). |
| `configured: false` / `WARN … unavailable` / `Missing OPENOBSERVE_URL … (PROD)` | That environment's `config/openobserve.<env>.env` (or, under mcp-hub, its `openobserve.<env>` section) is missing or still has placeholders. |
| 401 / 403 from `list_openobserve_organizations` | Wrong email/token, or the service account is not enabled for the organization. See [OPENOBSERVE_GUIDE.md](OPENOBSERVE_GUIDE.md). |
| `OpenObserve URL must use HTTPS` | Use the `https://` URL (plain HTTP is accepted only for localhost). |
| Anything else | Server log: `<MCP_LOGS_PATH>/logs/YYYY/MM/mcp-process-YYYY-MM-DD.log`. Client log: see your §4 subsection. |

---

## 7. After connecting

- Start with the prompts (direct connection only; under mcp-hub see [README](../README.md#-running-under-mcp-hub)) `investigate_api_bug` (bug report → live log search) or `analyze_ai_context` (question → read an export → compare with source).
- ai-context exports are read **only** through `list_ai_context_snapshots` and `read_ai_context`: `SUMMARY.lhub` first, then the `file:line` it points to, then the request's `rcid/` file. Never open `.lhub` files or the `ai-context/` folder with file tools.
- The server sends these rules as MCP server instructions on connect (direct connection only; under mcp-hub the hub's contract `../mcp-hub/docs/mcps/mcp-server-logs.md` replaces them). Optional rule for the consuming repository: see [README](../README.md#using-it-from-another-repository-eg-antigravity-on-your-backend-repo).
- Full tool list: [AGENTS.md §4](../AGENTS.md#4-mcp-tools-reference).
