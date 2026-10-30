# OpenObserve log access

This repository connects to **OpenObserve**. The Organizations in the top-bar dropdown are the environments you can choose. Each Organization has log streams; searches run against one Organization at a time. The old Observe by Snowflake configuration is no longer used.

## 1. Create a logging account and token

In OpenObserve Enterprise, ask an administrator to create a dedicated service account in **IAM → Service Accounts → Add Service Account**. Save its email and the token shown at creation. The token is shown only once. Assign the service account a read-only role (Viewer or an equivalent custom role) in each Organization it should search. Its Organization list is based on its own permissions, so it can differ from your personal browser account. An ingestion token cannot search logs. See the [OpenObserve service account guide](https://openobserve.ai/docs/user-guide/account-administration/identity-and-access-management/service-accounts/) and [RBAC guide](https://openobserve.ai/docs/user-guide/account-administration/identity-and-access-management/role-based-access-control/).

If your deployment does not provide service accounts, ask its administrator for an API-capable read-only logging identity. Do not copy the browser `session` cookie into this repository. If a session cookie was exposed, sign out to invalidate it.

## 2. Configure separate accounts

The first start creates `config/openobserve.dev.env`, `config/openobserve.stg.env` and `config/openobserve.prod.env` from `config/openobserve.env.example`. Fill in the ones you use with that environment's URL, service-account email and token (a Basic credential in `OPENOBSERVE_TOKEN` is split into email and token automatically). The example placeholders (`your_…`, `…@example.com`) count as empty, so an untouched file reports what is missing instead of trying to connect.

Then run `npm run cli`, choose **2. Observe** and pick **DEV**, **STG** or **PROD**; the CLI connects with that file and never prompts for or saves an Observe account. MCP mode serves every environment from one server: OpenObserve tools take `env` (`dev`, `stg`, `prod`) and use that file for the call. Calls without `env` use the account named by `OPENOBSERVE_ENV` (e.g. `"OPENOBSERVE_ENV": "dev"` in the MCP client `env`); without it, it uses `OPENOBSERVE_URL` / `OPENOBSERVE_EMAIL` / `OPENOBSERVE_TOKEN` variables, else the DEV file when it has a URL. Choose **1. Seq** to enter its own URL and API key, saved separately in `config/seq.env` (`SEQ_*` variables win over it). The real account files are ignored by Git. Optional settings (`LOG_DIR`, `AI_CONTEXT_DIR`, `OPENOBSERVE_ENV`, `AI_CONTEXT_TIME_ZONE`) can go in a root `.env`, see `.env.example`.

Restart the CLI or MCP process after editing an account file. Never paste tokens, cookies, or full authenticated curl commands into tickets or chat.

## 3. Use the CLI

Run `npm run build`, then `npm run cli`. Choose **2. Observe**. The CLI verifies credentials by fetching accessible Organizations, asks you to select one, then lists its log streams. Select a stream and choose either:

- **Service & level:** lists the services that logged in the stream since `From` (default `1h`) with their log counts — plus Error/Warning counts for structured streams. Pick a service (or `0` for all), then one or more levels (`1` Error+Fatal/Critical, `2` Warning, `3` Information, `4` Debug/Verbose, `5` All; e.g. `1,2`). Structured streams use `service_name` (or `applicationname`) and `severity`. Kubernetes streams use the deployment name from `kubernetes_pod_name` (pod hash removed) and read the level from the log text, so results may be fewer than the limit.
- **RCID:** enter the value. Every log whose `rcid`, `correlationid`, `trace_id` or `traceid` equals it (exact match, all services and levels) is saved as one export folder; see [One RCID](#ai-context-exports).
- **SQL:** enter OpenObserve SQL for the selected Organization. For example, `SELECT * FROM "shop_prod" ORDER BY _timestamp DESC`.

The CLI fetches every row in the range unless you type a maximum; Service & level defaults to the last hour, RCID and SQL to the last 15 minutes. Time inputs support local `YYYY-MM-DD HH:mm`, ISO timestamps, relative values such as `15m`, `1h`, `24h`, `7d`, or a day + hours (see [CLI guide](CLI_GUIDE.md)). The MCP search tools default to 50 results and allow at most 500.

## 4. Use from an AI Agent

Run `npm start` as an MCP stdio server or mount `registerLogsTools()` in a parent MCP. Start an investigation with the `investigate_api_bug` MCP Prompt. It guides the agent to inspect the source first, discover accessible Organizations and streams, inspect stream schema, write bounded SQL, retrieve evidence, and correlate the result with source code. The calling agent saves case evidence under `log-work/<case-id>/` in its own repository and keeps raw evidence Git-ignored; mcp-server-logs does not write files into that repository.

The agent tools are `list_openobserve_organizations`, `list_openobserve_streams`, `list_openobserve_stream_schema`, `list_openobserve_services`, `get_openobserve_service_logs`, `export_openobserve_logs`, `list_ai_context_snapshots`, `read_ai_context`, `find_openobserve_logs_by_rcid`, and `search_openobserve_logs`. Use `list_openobserve_services` and `get_openobserve_service_logs` to filter a service by level without writing SQL; Kubernetes streams have no level field. Schema discovery returns field names and types, so the agent can use actual fields rather than guessing. SQL search accepts one SELECT statement, applies explicit `from`/`to` API bounds, and caps results at 500. Start with a narrow time range and limit of 100 or less. Each successful search returns the executed SQL, bounds, and log rows for the agent's evidence file. Each search takes an explicit Organization identifier; it does not inherit a CLI selection. The schema tool uses OpenObserve's [`GET /api/{organization}/streams/{stream}/schema?type=logs`](https://openobserve.ai/docs/reference/api/stream/schema/) endpoint.

Repeated searches are answered locally. `search_openobserve_logs` and `query_logs` with SQL first look for an ai-context copy of the same search: same environment, same SQL apart from whitespace outside quotes, same organization and same absolute window (the copy is encrypted with the organization identifier and found by an HMAC of these, never by the SQL text). A hit returns the saved rows in their original order without a search request (`search_openobserve_logs` answers `cached: true` and shows the `window` it used); a miss searches OpenObserve and saves non-empty results. `get_openobserve_service_logs` and `query_logs` with only a stream reuse an export that covers the window, and `find_openobserve_logs_by_rcid` a saved request with that RCID. Relative bounds (`15m`) and the default end count from the start of the current minute, so a repeat within the minute is a hit and logs from the last < 1 minute appear from the next minute on; pass ISO bounds for an exact window. Stream lists and schemas are kept in memory for 5 minutes, so a new stream or field can take that long to appear. `query_logs` without `provider` queries OpenObserve when the environment's account is configured, else Seq; it never queries both. Seq results are never cached.

The process log at `logs/YYYY/MM/mcp-process-YYYY-MM-DD.log` records provider request start, endpoint path, HTTP status, duration, result counts, and failures. It omits authorization headers, SQL/RCID values, and returned log contents, and shows only the first 4 characters of Organization identifiers, because an identifier decrypts that Organization's ai-context snapshots. The old `provider: "observe"` spelling remains an alias, but now calls OpenObserve rather than Observe by Snowflake.

Grant the logging account only the Organizations and streams the agent may read. The OpenObserve API uses HTTP Basic authentication with `email:token`, and the repository sends it over HTTPS. It calls `GET /api/organizations`, `GET /api/{organization}/streams?type=logs`, and `POST /api/{organization}/_search`. See the [OpenObserve API reference](https://openobserve.ai/docs/reference/api/), [stream API](https://openobserve.ai/docs/reference/api/stream/list/), and [search API](https://openobserve.ai/docs/reference/api/search/search/).

The OpenObserve UI may call `_search_stream` for streaming results. This MCP currently uses the documented `_search` JSON API, which is simpler for CLI and agent calls.

## ai-context exports

Saving from the CLI (or the `export_openobserve_logs` MCP tool) writes a Git-ignored **export folder** under `ai-context/` (override with `AI_CONTEXT_DIR`). One export, however long its range, is one folder. Folder and file names are plain text; **the content of every file is encrypted and compressed** (`.lhub`). The layout lets an AI agent read one summary first and open only the logs it needs:

```
ai-context/
  INDEX.md                                   one line per export, newest first (metadata only, no log content)
  openobserve/<env>/<org name>/<stream>/
    <from>_<to>_<service|all-services>_<levels|all-levels>_<rows>/      e.g. 20261015-0935_20261016-0935_all-services_all-levels_1541998
      ├─ SUMMARY.lhub     read first, covers the whole export: source, range, rows, counts by service x level,
      │                   top patterns with an example file:line, Bugs → request flows, framework noise, HTTP requests
      ├─ patterns.lhub    every pattern; ids, numbers, timestamps and quoted values are normalized so repeats group,
      │                   and an exception message is appended to show the root cause behind generic messages
      ├─ manifest.lhub    query parameters, server-side counts, every flow with its bug #
      ├─ services/
      │    ├─ Shop.Email/    error.lhub  warning.lhub  information.lhub  debug.lhub
      │    └─ Shop.Gateway/  error.lhub  information.lhub …      one log per line, oldest first: ts, level, service, message, ids, attrs
      └─ rcid/            (include_flows) one file per failing request: rcid-0HN7ABC.lhub, trace_id-4bf92f….lhub
                          every row of that request, all services and levels, oldest first
```

- **Folder name.** `<from>_<to>` is the export range in `AI_CONTEXT_TIME_ZONE` (default `UTC`; any IANA zone such as `Europe/Berlin`). Timestamps inside the logs stay UTC, and SUMMARY shows both. `<rows>` is the number of rows downloaded. An RCID export is named `…_rcid-<value>_all-levels_<rows>` and holds only `rcid/` and the summary files.
- **`_partial`.** A folder ending in `_partial` is an export that is still running or was interrupted. It is renamed with its row count when it finishes.
- **Visible without access:** the time range, service names, levels, row count and rcid values, because they are folder and file names. Everything inside the files is encrypted.

### Encrypted files and access

```
EXPORT (someone with access)
  each fetch window (≤ 250k rows, oldest first):
      rows ──► services/<service>/<level>.lhub   (one encrypted frame appended per window; memory holds one window)
  then: request flows of the export's failing requests ──► rcid/<field>-<id>.lhub
  then: SUMMARY.lhub / patterns.lhub / manifest.lhub for the whole export ──► folder renamed ..._<rows> + one INDEX.md line

  .lhub = "LHUB3\n" + header line (plaintext: env, organization name, stream, kind, salt)
        + frames [bytes][fromMs][toMs][iv][AES-256-GCM(Brotli(lines))][tag]
        key = HKDF(organization identifier, the file's salt); each frame is bound to the header, its position and time range

READ (anyone who received the ai-context/ folder)
  read_ai_context(snapshot = folder, file) ──► that file's plaintext header says env=prod, organization=acme
      ──► log in with THEIR config/openobserve.prod.env ──► GET /api/organizations
      ──► is "acme" listed? ── no ──► "No access: … not enabled for organization 'acme'"
            │ yes
            ▼
          its identifier ──► HKDF ──► AES-GCM decrypt only that file (wrong key, edited or reordered frame = rejected)
      ──► in memory only (never written to disk) ──► lines / grep matches
```

- **Size.** Log text compresses very well, about 40× (6.5 MB of plain JSON lines → 0.15 MB). Measured on DEV `shop_dev`, 24h, all services, all levels:
  - 375k rows downloaded into one folder: 45 service folders, 106 log files, 200 `rcid/` files, 16 MB in total.
  - The export took 212 s; peak RAM was 1.75 GB.
  - Opening SUMMARY took 3 ms, and the largest file (76k lines) took 0.9 s.
- **Who can read.** Each person uses their own OpenObserve account; no shared token or password is needed. A snapshot of PROD organization `acme` opens only for an account that connects with `config/openobserve.prod.env` **and** sees `acme` in its Organization list. Connecting to PROD without access to that Organization is refused. The key is the Organization **identifier** (for example `org-key-123`), which OpenObserve returns only to accounts enabled for it. The identifier is never written into `ai-context/` or the process log (only its first 4 characters).
- **Sharing.** Copy the whole `ai-context/` folder to a colleague. They run the MCP with their own `config/openobserve.<env>.env`, call `list_ai_context_snapshots`, then `read_ai_context`. Do not send `config/` or `logs/`.
- **Reading.** `read_ai_context` takes `snapshot`: the export folder relative to `ai-context/`, as returned by the export or the list tool.
  - Use `file` with `offset`/`limit` to page through one file, for example `services/Shop.Email/error.lhub` or `rcid/rcid-0HN7ABC.lhub`. The default is `SUMMARY.lhub`, and the extension may be omitted.
  - Use `grep` to find text such as an rcid in one `file`, or in every file one at a time.
  - Only the requested file is decrypted. Every call checks access again; the access check is cached for 60s.
- **Limits.**
  - The identifier is the secret. Anyone who has ever seen it can decrypt snapshots made with it, even after their access is removed. This includes former members of the Organization, and anyone shown OpenObserve UI URLs that contain `org_identifier=`.
  - Treat exports as sensitive real log data either way.
  - Dropping the last frames of a file is not detected; any other change to a file is.
  - Earlier formats (plain folders, single-file `.lhub` snapshots) are no longer read or used for duplicate detection. Delete them.

### What an export keeps and what it skips

A service/level export (CLI mode `1. Service & level`, MCP `export_openobserve_logs`) does **not** download every row. Measured over 24h:
- **DEV:** 80–88% of rows were framework noise (health checks, ASP.NET pipeline, EF Core SQL, HttpClient), not application logs.
- **PROD `shop_prod`:** library Debug logs (gRPC, MassTransit, Elsa) were another large share.
- **Speed:** the OpenObserve server returns about 2-6k rows/s however the client asks, so downloading noise is what made exports slow.

So an export downloads what is needed to find an issue, and only **counts** the rest on the server (GROUP BY takes under a second).

**Skipped: counted in SUMMARY, not downloaded row by row.** A row is skipped only when its level is Information, Debug, Verbose or Trace **and** it matches one of these groups. Warning, Error and Critical rows of the same groups are always downloaded.

| # | Group | Matched by (`instrumentation_library_name` or field) | Typical message |
|---|---|---|---|
| 1 | Health checks | `endpointname = 'Health checks'` or `path LIKE '/health-checks/%'` | `/health-checks/readyz`, `/livez` |
| 2 | ASP.NET hosting | `Microsoft.AspNetCore.Hosting.%` | Request starting / Request finished |
| 3 | ASP.NET routing | `Microsoft.AspNetCore.Routing.%` | Executing / Executed endpoint |
| 4 | ASP.NET MVC pipeline | `Microsoft.AspNetCore.Mvc.Infrastructure.%` | Executing action / ObjectResult |
| 5 | CORS | `Microsoft.AspNetCore.Cors.%` | CORS policy execution |
| 6 | EF Core SQL | `Microsoft.EntityFrameworkCore.Database.Command` | Executed DbCommand (12ms) SELECT … |
| 7 | HttpClient handlers | `System.Net.Http.HttpClient.%` (includes the OTLP exporter) | Start / End processing HTTP request |
| 8 | Ocelot gateway | `Ocelot.%` | rate-limit / auth / requester middleware steps |
| 9 | gRPC | `Grpc.%` | GrpcCall, RetryCall, ServerCallHandler internals |
| 10 | MassTransit | `MassTransit.%` | message send / receive (`MassTransit.Messages`) |
| 11 | Elsa workflow engine | `Elsa.%` | LogWorkflowExecution, DistributedLockProvider, BookmarkIndexer |

The list is `NOISE_CATEGORIES` in `src/providers/openobserve-sql.ts`; edit it there and in this table together. It applies only to streams with an `instrumentation_library_name` field. Kubernetes text streams (e.g. `ape_k8s`) are never filtered.

**Skipped columns.** Every export also leaves out fields that are constant per stream or SDK metadata: `telemetry_sdk_version`, `telemetry_sdk_name`, `telemetry_sdk_language`, `dropped_attributes_count`, `environment`, `deployment_environment`, `aspnetcore_namespace`, `processname`, `processid`, `threadid`, `newline`, `commandtype`, `commandtimeout`, `protocol`, `scheme`, `service_version`, `application`. The list is `DROP_FIELDS` in the same file. Every other column is kept, including app-specific fields such as `entitytype` or `username`.

**Kept.**

| What | How |
|---|---|
| Every **Warning / Error / Critical / Fatal** row, of any logger, framework included | downloaded row by row (`services/`) |
| Every Information/Debug row of **application** loggers (`(none)`/Serilog app logs, `Shop.*`, `Quartz`, `Rebus`, workers…) | downloaded row by row (`services/`) |
| **Request flows** of failing requests: every row with the same rcid / correlationid / trace_id, **skipped groups included** (SQL, request in/out, outgoing HTTP, gRPC), ±15 minutes | downloaded row by row (`rcid/`) |
| Skipped rows: count per service × level × logger × hour, plus the most frequent messages | server-side counts (SUMMARY "Framework noise" table, `manifest.lhub` → `aggregates`) |
| HTTP requests: path × method × status → count, average and max `elapsedmilliseconds`, noise included | server-side counts (SUMMARY "HTTP requests" table) |

Every SUMMARY starts with **"What this export contains"**, which states the above with that export's numbers, so an agent never mistakes skipped noise for missing data. To see the skipped rows of one request, grep its id in `rcid/` or call `find_openobserve_logs_by_rcid`. To download everything, pass `include_noise: true` (CLI: answer `y` to `Include framework noise rows?`). This is several times slower.

| 24h, all services, all levels | Total rows | Downloaded | Time |
|---|---:|---:|---|
| DEV `shop_dev` (measured end to end) | 1.86M | 376k | 3.5 min, one folder of 16 MB; client 26% of one core, peak RAM 1.75 GB |
| PROD `shop_prod` (counted) | 7.3M | 1.54M | about 5-14 min (server speed 2-6k rows/s) |

### Large exports

```
export ──► COUNT total / noise / to download ──► fetch window: 24h / 6h / 1h / 15m, the largest with ≤ 250k downloaded rows each
   ▼  each fetch window, oldest first (in parallel: rows + server-side counts):
   5 time slices in parallel, 5,000 rows a page, newest first with a time cursor:
       offset at most 20,000, then end_time moves back to the oldest row taken (no deep offsets)
       network error / timeout / 429 / 502-504 → retried 3 times (1s, 3s, 9s)
   ──► lean rows (empty fields dropped) ──► duplicates dropped ──► one frame appended to each services/<service>/<level>.lhub
   ▼  after the last window:
   up to 200 failing requests of the whole export (most frequent bug first) ──► 50 ids per query near their errors ──► rcid/
   ──► SUMMARY / patterns / manifest for the whole export ──► folder renamed with its row count
```

- **Speed.** The server, not the client, is the limit: about 1.3k rows/s per request and 2-6k rows/s with parallel requests, depending on its load. Five parallel requests use 10-20% of one client core. The CLI prints the counts and an estimate first, then one live progress line per window.
- **Memory.** Only one fetch window (≤ 250k downloaded rows) is in memory at a time; its rows are appended to the files and dropped before the next window. The launcher (`start.mjs`) allows Node up to half the machine's RAM (at most 8 GB) for this.
- `max_rows` (CLI: Maximum results) applies per fetch window; leave it empty to keep every row.
- Custom SQL (CLI mode 3) is not filtered or counted in advance, so a range over 1h is fetched per hour (still one folder). Only SQL ending in `ORDER BY _timestamp DESC` uses the time cursor; other SQL pages by offset.
- A shorter "last 24h" than a few minutes on a busy PROD stream needs incremental sync (download only rows newer than the last sync); not built yet.

**Request flows.** The CLI asks `Fetch full request flows (rcid/trace_id) for errors? (Y/n)`; the MCP export tool does this by default (`include_flows`).
- **Which requests.** Across the whole export, it takes every distinct correlation id of the Error/Fatal logs (`rcid`, then `correlationid`, `trace_id`, `traceid`). It keeps at most 200, most frequent bug first.
- **How they are fetched.** Ids are sorted by time and queried 50 at a time (`IN (...)`, 5 queries in parallel). Each query covers 15 minutes before that group's first error to 15 minutes after its last. It returns every log in the stream carrying those ids on any of those fields.
- **What a flow contains.** Flows are never noise-filtered. The same id logged as `rcid` by one sink and `trace_id` by another is one flow. Flows over 500 lines keep 400 lines before the first error and 100 from it.
- **Where to find them.** SUMMARY has a **Bugs** table: one row per error pattern, with its request count, the first failing step (service and message of the first error in the newest flow, often upstream of the logged error) and its `rcid/` files. `manifest.lhub` → `flows` lists every flow with its bug #, service path, rows and duration.
- Errors without any correlation id (for example background jobs) have no flow.

**One RCID.** `export_openobserve_logs` with `rcid` (or CLI search mode `2. RCID`) saves just that request as a folder `…_rcid-<value>_all-levels_<rows>` with `rcid/` and its summary, so an agent can read the timeline and see which step failed. Widen `from` (e.g. `7d`) if nothing is found.

**Bug list for a service.** `export_openobserve_logs` with `service` and `level: 'Error'` for the day, then read the SUMMARY Bugs table.

**Overlapping scans.** Scanning 14h→18h and then 16h→20h saves the 16h→18h logs only once.
- Rows already in an earlier export of the same stream are skipped (`skip_duplicates`, default true). Only the frames that overlap the window are decrypted, and only line hashes are kept in memory.
- The skipped count is printed by the CLI, returned as `duplicates`, and shown in SUMMARY and INDEX.md.
- To pick a fixed window in the CLI, choose `Day + hours (24h)`: day `1` (yesterday), from `14`, to `18`. Over MCP, pass ISO `from`/`to`.

`ids` holds correlation fields (rcid, correlationId, traceId, requestId); `attrs` holds the remaining non-empty fields. Exports contain real log data, possibly personal data, and are never committed; delete old export folders by hand.
