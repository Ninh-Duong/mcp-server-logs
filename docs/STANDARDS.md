# Coding & Engineering Standards

## 1. Language & Runtime Conventions
- **Runtime**: Node.js 22+ (`engines` in `package.json`, checked by `start.mjs` and preflight).
- **Language**: TypeScript 5.8+ targeting `ES2022`, `strict` plus `noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride` and `noFallthroughCasesInSwitch`. `npm run build` must pass with zero errors.
- **Module System**: ESM (`"type": "module"` with `NodeNext` resolution). All imports must include `.js` extension (e.g. `import ... from './types.js'`).
- **Strict Typing**: No `any` unless explicitly wrapping unknown external JSON shapes. Every provider output must strictly conform to `LogEntry`.
- **Dependencies**: stdlib first; no new runtime package without a written reason in [DEPENDENCIES.md](DEPENDENCIES.md).

---

## 2. Code Organization
- **One responsibility per file.** The code map is in [AGENTS.md](../AGENTS.md#code-map). Pure logic (SQL building, summaries, formats) lives apart from I/O (HTTP, files, terminal) so it can be tested directly.
- **Short functions.** A function should do one step and read top to bottom. When one grows past a screen, split it into named steps (see `startExport` → `addWindow` / `countEntry` / `writeFlow` / `finish` in `src/ai-context/export-folder.ts`). There is no hard line limit.
- **No dead code.** Remove unused functions, exports and files in the same change that makes them unused; `noUnusedLocals` catches local leftovers, review catches unused exports. Export only what another module or a test uses.
- **Comments say why**, not what: units, measured limits (`ponytail:` notes name a known ceiling and its upgrade path), and security reasons.

---

## 3. MCP Tools
- Register with `server.registerTool(name, { title, description, inputSchema, annotations }, handler)`; `server.tool` is deprecated in the SDK.
- Wrap each handler body in `run(toolName, …)` (`src/tools/common.ts`): errors become `isError` results with their message, and the process log keeps only the error type.
- Annotations: `readOnlyHint: true` unless the tool writes (only `export_openobserve_logs`, with `destructiveHint: false`); `openWorldHint: true` when it calls OpenObserve or Seq.
- Reuse the shared zod fields (`organization`, `stream`, `level`, `to`, `limit`) so the same argument reads the same in every tool.

---

## 4. Standardized Log Schema

Regardless of whether logs originate from Seq, OpenObserve, or future providers, they MUST normalize into the unified `LogEntry` interface:

```typescript
export interface LogEntry {
  timestamp: string;                      // ISO 8601 UTC (e.g. 2026-09-28T05:00:00.000Z)
  level: LogLevel | string;               // Normalized severity level
  message: string;                        // Rendered, human-readable log message
  provider: string;                       // Backend name ('seq', 'openobserve')
  service?: string;                       // Emitting service, when the provider can tell
  metadata?: Record<string, unknown>;     // Optional key-value context attributes
}
```

### Severity Normalization Rules (`normalizeLogLevel`, `src/providers/base.ts`):
| Raw Provider Level (case-insensitive) | Normalized `LogLevel` |
| :--- | :--- |
| `fatal`, `critical`, `crit`, `emerg`, `FTL`, `CRT` | `Fatal` |
| `error`, `err`, `ERR` | `Error` |
| `warning`, `warn`, `WRN` | `Warning` |
| `information`, `info`, `INF`, anything unknown | `Information` |
| `debug`, `DBG` | `Debug` |
| `verbose`, `trace`, `VRB`, `TRC` | `Verbose` |

---

## 5. Time Filtering Conventions

All tools and providers must accept both ISO 8601 timestamps and human-friendly relative duration strings:
- `'15m'` -> 15 minutes before now
- `'1h'` -> 1 hour before now
- `'24h'` or `'1d'` -> 24 hours before now
- `'7d'` or `'1w'` -> 7 days before now
- Standard ISO strings: `2026-09-28T00:00:00Z`; a date and time without zone (`2026-10-07 09:00`) is local time.
- OpenObserve searches count relative bounds and the default end (now) from the start of the current minute (`searchWindow`), so their granularity is one minute: repeated searches within a minute share one window and one ai-context cache entry, and rows from the last < 1 minute appear from the next minute on. ISO bounds are used as given.

---

## 6. Error Handling & Resilience Contract

1. **One provider per query**: `query_logs` queries the named provider, else OpenObserve when its account for the call's `env` is configured, else Seq; it never fans out. A provider error is returned to the caller as a tool error (and logged to `logs/YYYY/MM/mcp-process-YYYY-MM-DD.log` without its message); a provider that is not configured never stops the server from serving the others.
2. **Timeouts**: Every external HTTP call sets `AbortSignal.timeout(...)`: 15 s by default, 60 s for an OpenObserve `_search` page (5,000 rows take 2-8 s on a busy server). Never leave an HTTP connection open indefinitely.
3. **Retries**: OpenObserve network errors, timeouts, 429 and 502-504 are retried after 1 s, 3 s and 9 s; other HTTP errors fail at once.
4. **Graceful Unconfigured State**: If environment variables for a provider are missing (or still hold the example placeholders), the server must mark that provider as `unconfigured` during preflight and continue running for other providers.
5. **No secrets in logs**: never log credentials, SQL/RCID values, log contents, or full OpenObserve organization identifiers (use `maskOrg`).

---

## 7. Testing

- Every feature and bug fix comes with a test that fails without it. `npm test` builds, runs every test with Node's built-in runner, and fails below 90% lines / 80% branches / 90% functions coverage.
- Tests run isolated (`src/tests/env.ts`): temp folders, no accounts, no real servers. Use the fakes in `src/tests/helpers.ts`.
- See [AGENTS.md](../AGENTS.md#testing-rules) for how tools, the CLI and import-time code are tested.
