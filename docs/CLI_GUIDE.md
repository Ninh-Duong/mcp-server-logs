# CLI guide

Run `npm run cli` (it installs dependencies and builds on first run). The first menu asks which log platform you want:

```text
1. Seq
2. Observe
3. Exit
```

Select **Seq** to enter its server URL and read-only API key, then run a log query (`Maximum results [10]`, 1-500). The Seq key is hidden while you type and saved in `config/seq.env`; on a later run you can reuse it or enter a replacement. The URL must use HTTPS unless it is `localhost`. Select **Observe**, then choose the environment (**DEV**, **STG** or **PROD**). The CLI does not ask for an Observe account: it reads `config/openobserve.<dev|stg|prod>.env` and connects to list accessible Organizations and log streams. If that file is missing or still holds the example placeholders, it reports `Connect failed` with the file path and missing variables.

At the Seq API key prompt, paste with **Ctrl+Shift+V** or **Shift+Insert**, then press **Enter**. Asterisks confirm input was received; Backspace edits the value. The display stops at 32 asterisks, but the full key is accepted.

After choosing an OpenObserve stream, choose **Service & level**, **RCID**, or **SQL**, then a time range:
- Last 15 minutes / 1 hour / 6 hours / 24 hours / 7 days (Service & level defaults to 1 hour, the others to 15 minutes);
- **Day + hours (24h)**: a day (`YYYY-MM-DD`, or `0` today, `1` yesterday, `2` two days ago) and From/To hours such as `14` → `18` (`24` = end of day);
- **Custom**: From/To as local time (`2026-10-07 09:00`), ISO 8601, or a relative value (`30m`).

A range ending later than now stops at now. At `Maximum results [all]`, press Enter to fetch every row in the range (paged 5,000 at a time), or type a number to cap it per fetch window.

Service & level then asks `Include framework noise rows (...)? Much slower (y/N)`. The default `N` downloads every Warning/Error/Critical row and every application log row. Framework noise is only counted: health checks, ASP.NET pipeline, EF Core SQL, HttpClient, Ocelot, gRPC, MassTransit and Elsa rows at Information or below. See [what an export keeps and what it skips](OPENOBSERVE_GUIDE.md#what-an-export-keeps-and-what-it-skips).

The CLI then counts the rows and prints, for example, `≈7,296,220 rows: 5,754,222 framework noise (counted only), 1,541,998 to download in 24 window(s) of 1h → one export folder, est. ~5 min`. Each fetch window holds at most 250k downloaded rows in memory.

Whatever the range, the result is **one export folder**, for example `ai-context/openobserve/prod/acme/shop_prod/20261015-0935_20261016-0935_all-services_all-levels_1541998/`. Times in the name are in `AI_CONTEXT_TIME_ZONE` (default UTC). Inside are encrypted files: `SUMMARY.lhub`, one folder per service under `services/` with one file per level, and `rcid/` with one file per failing request. See [ai-context exports](OPENOBSERVE_GUIDE.md#ai-context-exports).

With one window, the terminal shows the newest 50 rows. Answer `Save to ai-context? (Y/n)` to save them, then whether to fetch request flows. The CLI prints the folder path; AI agents read it with the `read_ai_context` MCP tool.

A larger export skips the preview. It asks once whether to fetch request flows. For each window it shows a live `fetched N rows…` line, then one result line. While it runs, the folder name ends in `_partial`.

The terminal shows only that progress plus warnings and errors; per-request details stay in `logs/YYYY/MM/mcp-process-YYYY-MM-DD.log`. See [large exports](OPENOBSERVE_GUIDE.md#large-exports).

- **Service & level** lists the services that logged in the range with log counts, then lets you pick a service (`0` = all) and levels (default `1,2` = Error and Warning; `5` = All).
- **RCID** asks only for the value. It finds every log of that request whose `rcid`, `correlationid`, `trace_id` or `traceid` equals it, across all services and levels, and saves it as an export folder (`…_rcid-<value>_all-levels_<rows>`). If nothing matches, widen the range (e.g. Last 7 days).
- **SQL** defaults to `SELECT * FROM "<stream>"`; it previews the newest 50 rows and asks whether to save.

Invalid input (an unknown menu number, a From in the future, From after To) prints `Error: …` and returns to the main menu.

The first start creates `config/openobserve.<dev|stg|prod>.env` and `config/seq.env` from the examples for you to fill in. The credential files and the entire `logs/`, `log-work/` and `ai-context/` directories are ignored by Git. `logs/YYYY/MM/mcp-process-YYYY-MM-DD.log` records provider endpoint, status, duration, result count, and failures without credentials, query values, or returned log contents. `npm run preflight` checks local configuration; selecting Observe in the CLI checks the real API connection. Start the MCP stdio server separately with `npm start`.

See [OpenObserve log access](OPENOBSERVE_GUIDE.md) for account-token creation and Organization permissions.
