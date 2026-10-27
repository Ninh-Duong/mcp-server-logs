import { openObserveAccount, openObserveAccountFor } from '../config.js';
import { cloneLogsToAiContext, cloneRcidToAiContext, findCachedLogs, findCachedRcid } from '../ai-context/index.js';
import { ExportAggregates, LogEntry, LogLevel, LogProvider, LogQuery, ProviderStatus, RequestFlow } from '../types.js';
import { FLOW_ID_FIELDS, LEVEL_ALIASES, normalizeLogLevel, parseTimeBound, resolveLevels } from './base.js';
import {
  LEVEL_WORDS, OpenObserveField, deploymentName, detectShape, levelFromText, noiseWhere, quoteIdentifier, quoteString, selectColumns, serviceOf, stripAnsi,
} from './openobserve-sql.js';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { logger, maskOrg } from '../utils/logger.js';

export interface OpenObserveOrganization { name: string; identifier: string }
export interface OpenObserveService { name: string; count: number; levels?: Partial<Record<LogLevel, number>> }
export interface OpenObserveServiceQuery {
  organization: string;
  stream: string;
  /** Omit for all services in the stream */
  service?: string;
  /** Exact levels to return; omit for all */
  levels?: LogLevel[];
  from?: string;
  to?: string;
  limit?: number;
  /** Also download framework noise rows (NOISE_CATEGORIES) instead of only counting them */
  includeNoise?: boolean;
  /** Called after every page with the rows fetched so far */
  onProgress?: (rows: number) => void;
}

/** Rows per _search request; searchLogs pages until the data or `limit` runs out. MAX_ROWS caps each request flow. */
const PAGE_SIZE = 5000;
const MAX_ROWS = 5000;
/** Deep offsets get slower every page; past OFFSET_RESET rows the time cursor moves end_time back instead. */
const OFFSET_RESET = 20_000;
/** Time slices fetched in parallel by an unlimited search. Measured: 5 parallel pages use ~10-20% of one client core. */
// ponytail: fixed 5 parallel requests; the OpenObserve server saturates around 6-8; raise only if it has headroom.
const SEARCH_CONCURRENCY = 5;

const RETRY_MS = [1000, 3000, 9000];
const RETRY_STATUS = new Set([429, 502, 503, 504]);
/** Results already sorted newest first, so a time cursor can page them without deep offsets. */
const NEWEST_FIRST = /ORDER\s+BY\s+_timestamp\s+DESC\s*$/i;
/** Raw fields copied into LogEntry.message; not kept twice in metadata. */
const MESSAGE_FIELDS = new Set(['message', 'body', 'log', 'msg']);
const FLOW_CONCURRENCY = 5;
const FLOW_BATCH = 50;
const FLOW_PAD_MS = 15 * 60_000;

export { levelFromText, type OpenObserveField };

interface Account { url: string; email: string; token: string }
/** One _search page as lean LogEntry objects. Times in microseconds. */
type Page = (startUs: number, endUs: number, offset: number, size: number) => Promise<LogEntry[]>;

const maskPath = (path: string) => path.replace(/^\/api\/(?!organizations$)([^/]+)/, (_, id: string) => `/api/${maskOrg(decodeURIComponent(id))}`);

export interface OpenObserveSearch {
  organization: string;
  sql: string;
  from?: string;
  to?: string;
  limit?: number;
  operationId?: string;
  /** Called after every page with the rows fetched so far */
  onProgress?: (rows: number) => void;
}

export class OpenObserveProvider implements LogProvider {
  public readonly name = 'openobserve';

  public getStatus(): ProviderStatus {
    const account = openObserveAccount();
    const missing = [
      !account.url && 'OPENOBSERVE_URL',
      !account.email && 'OPENOBSERVE_EMAIL',
      !account.token && 'OPENOBSERVE_TOKEN',
    ].filter((value): value is string => Boolean(value));
    const env = account.env ? ` (${account.env.toUpperCase()})` : '';
    return {
      name: this.name,
      configured: missing.length === 0,
      endpoint: account.url || undefined,
      missingVariables: missing.length ? missing : undefined,
      details: missing.length ? `Missing ${missing.join(', ')}${env}` : `Credentials configured${env}; connection not yet verified`,
    };
  }

  private async request(path: string, init: RequestInit = {}, operationId: string = randomUUID(), account: Account = openObserveAccount()): Promise<unknown> {
    if (account === openObserveAccount() && !this.getStatus().configured) throw new Error(this.getStatus().details);
    if (!account.url || !account.email || !account.token) throw new Error('OpenObserve account is missing or incomplete');
    const base = new URL(account.url);
    if (base.protocol !== 'https:' && base.hostname !== 'localhost' && base.hostname !== '127.0.0.1') {
      throw new Error('OpenObserve URL must use HTTPS');
    }
    const url = new URL(path, `${base.toString().replace(/\/+$/, '')}/`);
    const log = { operationId, method: init.method || 'GET', endpoint: maskPath(url.pathname) };
    const send = () => fetch(url, {
      ...init,
      headers: { Authorization: `Basic ${Buffer.from(`${account.email}:${account.token}`).toString('base64')}`, Accept: 'application/json', ...init.headers },
      // A 5000-row search page takes 2-8s on a busy server; other calls are small.
      signal: AbortSignal.timeout(path.endsWith('/_search') ? 60_000 : 15_000),
    });
    // A long export makes thousands of requests: network errors, timeouts, 429 and 502-504 are retried after RETRY_MS.
    for (let attempt = 0; ; attempt++) {
      const result = await this.attempt(send, log);
      if ('json' in result) return result.json;
      if (!result.retryable || attempt >= RETRY_MS.length) {
        logger.error('openobserve.request_failed', { ...log, ...result.details });
        throw result.error;
      }
      logger.warn('openobserve.request_retry', { ...log, attempt: attempt + 1, ...result.details });
      await sleep(RETRY_MS[attempt]);
    }
  }

  /** One HTTP attempt: the JSON body, or the error, whether it is worth retrying, and what to log (status, timing). */
  private async attempt(send: () => Promise<Response>, log: Record<string, unknown>): Promise<{ json: unknown } | { error: Error; retryable: boolean; details: Record<string, unknown> }> {
    const started = Date.now();
    logger.info('openobserve.request_started', log);
    let response: Response;
    try {
      response = await send();
    } catch (err) {
      return { error: err as Error, retryable: true, details: { durationMs: Date.now() - started, errorType: err instanceof Error ? err.name : 'UnknownError' } };
    }
    const details = { status: response.status, durationMs: Date.now() - started };
    if (!response.ok) {
      const body = await response.text();
      return { error: new Error(`OpenObserve HTTP ${response.status}: ${body.slice(0, 300)}`), retryable: RETRY_STATUS.has(response.status), details };
    }
    logger.info('openobserve.request_succeeded', { ...log, ...details });
    return { json: await response.json() };
  }

  // ponytail: 60s TTL, so a revoked organization stays usable for up to 60s; drop the TTL if that is unacceptable.
  private orgCache = new Map<string, { at: number; organizations: OpenObserveOrganization[] }>();

  public async listOrganizations(operationId: string = randomUUID(), account: Account = openObserveAccount()): Promise<OpenObserveOrganization[]> {
    const key = `${account.url}|${account.email}|${account.token}`;
    const cached = this.orgCache.get(key);
    if (cached && Date.now() - cached.at < 60_000) return cached.organizations;
    const result = await this.request('api/organizations', {}, operationId, account) as { data?: Array<Record<string, unknown>> };
    if (!Array.isArray(result.data)) throw new Error('Unexpected OpenObserve organizations response');
    const organizations = result.data.map((org) => ({ name: String(org.name || ''), identifier: String(org.identifier || '') }))
      .filter((org) => org.name && org.identifier);
    logger.info('openobserve.organizations_loaded', { count: organizations.length });
    this.orgCache.set(key, { at: Date.now(), organizations });
    return organizations;
  }

  /**
   * The key of an ai-context snapshot: the identifier of `organization` (by name), as returned to the account saved
   * for `env`. Only an account that connects to that environment and is enabled for the organization gets it.
   */
  public async organizationKey(env: string | undefined, organization: string): Promise<string> {
    const account = env && env !== 'default' ? openObserveAccountFor(env) : openObserveAccount();
    const label = (env || 'default').toUpperCase();
    if (!account.url || !account.email || !account.token) {
      throw new Error(`No access: the OpenObserve ${label} account is not configured${env && env !== 'default' ? ` (config/openobserve.${env.toLowerCase()}.env or the hub's openobserve.${env.toLowerCase()})` : ''}`);
    }
    let organizations: OpenObserveOrganization[];
    try {
      organizations = await this.listOrganizations(undefined, account);
    } catch (err) {
      throw new Error(`No access: cannot connect to OpenObserve ${label}: ${(err as Error).message}`);
    }
    const match = organizations.find((org) => org.name === organization);
    if (!match) throw new Error(`No access: the OpenObserve ${label} account is not enabled for organization '${organization}'`);
    return match.identifier;
  }

  private async requireOrganization(organization: string, operationId: string): Promise<void> {
    const organizations = await this.listOrganizations(operationId);
    if (!organizations.some((org) => org.identifier === organization)) {
      throw new Error(`Organization '${organization}' is not accessible to this account`);
    }
  }

  public async listStreams(organization: string, operationId: string = randomUUID()): Promise<string[]> {
    await this.requireOrganization(organization, operationId);
    const result = await this.request(`api/${encodeURIComponent(organization)}/streams?type=logs`, {}, operationId) as { list?: Array<Record<string, unknown>> };
    if (!Array.isArray(result.list)) throw new Error('Unexpected OpenObserve streams response');
    const streams = result.list.map((stream) => String(stream.name || '')).filter(Boolean);
    logger.info('openobserve.streams_loaded', { organization: maskOrg(organization), count: streams.length });
    return streams;
  }

  public async getStreamSchema(organization: string, stream: string): Promise<OpenObserveField[]> {
    const operationId = randomUUID();
    if (!(await this.listStreams(organization, operationId)).includes(stream)) {
      throw new Error(`Log stream '${stream}' is not accessible`);
    }
    const result = await this.request(`api/${encodeURIComponent(organization)}/streams/${encodeURIComponent(stream)}/schema?type=logs`, {}, operationId) as {
      schema?: Array<Record<string, unknown>>;
    };
    if (!Array.isArray(result.schema)) throw new Error('Unexpected OpenObserve stream schema response');
    const fields = result.schema.map((field) => ({ name: String(field.name || ''), type: String(field.type || '') }))
      .filter((field) => field.name && field.type);
    logger.info('openobserve.schema_loaded', { organization: maskOrg(organization), stream, count: fields.length });
    return fields;
  }

  public async searchLogs(params: OpenObserveSearch): Promise<LogEntry[]> {
    if (!params.sql.trim()) throw new Error('SQL query is required');
    if (!/^SELECT\b/i.test(params.sql.trim()) || /;\s*\S/.test(params.sql)) throw new Error('Only a single SELECT query is allowed');
    const operationId = params.operationId || randomUUID();
    await this.requireOrganization(params.organization, operationId);
    const from = parseTimeBound(params.from || '15m');
    const to = params.to ? parseTimeBound(params.to) : new Date().toISOString();
    if (!from || !to || Date.parse(from) >= Date.parse(to)) throw new Error('Invalid time range');
    // ponytail: limit may be Infinity = every row held in memory (5000-row pages, 5 time slices in parallel); stream to disk if a range reaches millions of rows.
    const limit = Math.max(params.limit || 50, 1);
    const [start, end] = [Date.parse(from) * 1000, Date.parse(to) * 1000];
    const page = this.searchPage(params, operationId);
    // Unknown order (aggregates, custom SQL): plain offset paging. Newest first: time cursor, in slices when unlimited.
    const logs = NEWEST_FIRST.test(params.sql.trim()) ? await this.pageBySlices(page, start, end, limit) : await this.pageByOffset(page, start, end, limit);
    logger.info('openobserve.search_results', { operationId, organization: maskOrg(params.organization), from, to, limit, count: logs.length });
    return logs;
  }

  /** Fetches one page, already turned into lean LogEntry objects so the raw rows can be freed; reports rows so far. */
  private searchPage(params: OpenObserveSearch, operationId: string): Page {
    let fetched = 0;
    return async (startUs, endUs, offset, size) => {
      const result = await this.request(`api/${encodeURIComponent(params.organization)}/_search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: { sql: params.sql, start_time: startUs, end_time: endUs, from: offset, size } }),
      }, operationId) as { hits?: Array<Record<string, unknown>> };
      if (!Array.isArray(result.hits)) throw new Error('Unexpected OpenObserve search response');
      fetched += result.hits.length;
      params.onProgress?.(fetched);
      return result.hits.map((row) => this.toEntry(row));
    };
  }

  private async pageByOffset(page: Page, startUs: number, endUs: number, limit: number): Promise<LogEntry[]> {
    const logs: LogEntry[] = [];
    while (logs.length < limit) {
      const size = Math.min(PAGE_SIZE, limit - logs.length);
      const rows = await page(startUs, endUs, logs.length, size);
      logs.push(...rows);
      if (rows.length < size) break;
    }
    return logs;
  }

  /**
   * Unlimited: SEARCH_CONCURRENCY time slices in parallel, newest slice first in the result. Each slice asks 1µs before
   * its start (in case start_time is exclusive) and keeps only [lo, hi), so a row on a slice boundary is taken exactly once.
   */
  private async pageBySlices(page: Page, startUs: number, endUs: number, limit: number): Promise<LogEntry[]> {
    const slices = limit === Infinity ? SEARCH_CONCURRENCY : 1;
    const step = Math.ceil((endUs - startUs) / slices);
    const parts = await Promise.all(Array.from({ length: slices }, (_, i) => {
      const lo = startUs + i * step;
      const hi = i === slices - 1 ? Infinity : Math.min(endUs, lo + step);
      return this.pageByTime(page, i ? lo - 1 : lo, Math.min(endUs, hi), limit, (ts) => (!i || ts >= lo) && ts < hi);
    }));
    return parts.reverse().flat();
  }

  /**
   * Newest-first paging that walks end_time back instead of using deep offsets: after OFFSET_RESET rows the window ends
   * at the oldest timestamp taken so far. Rows on that edge (taken before, returned again) are skipped by content.
   */
  private async pageByTime(page: Page,
    startUs: number, endUs: number, limit: number, keep: (ts: number) => boolean): Promise<LogEntry[]> {
    const out: LogEntry[] = [];
    const rowKey = (row: LogEntry) => `${row.message}\u0000${JSON.stringify(row.metadata)}`;
    let to = endUs;
    let offset = 0;
    let edge = { maxTs: -Infinity, seen: new Set<string>() };
    while (out.length < limit) {
      const size = Math.min(PAGE_SIZE, limit - out.length);
      const rows = await page(startUs, to, offset, size);
      for (const row of rows) {
        const ts = Number(row.metadata?._timestamp);
        // Rows without _timestamp (custom column list) cannot be placed on the time line; keep them as returned.
        if (!Number.isNaN(ts) && (!keep(ts) || (ts <= edge.maxTs && edge.seen.has(rowKey(row))))) continue;
        out.push(row);
      }
      if (rows.length < size) break;
      offset += size;
      const oldest = Number(rows[rows.length - 1]!.metadata?._timestamp);
      if (offset >= OFFSET_RESET && Number.isFinite(oldest)) {
        // end_time may be inclusive or exclusive: ask up to oldest + 1µs, and remember every row taken at or after oldest.
        const seen = new Set<string>();
        for (let i = out.length - 1; i >= 0 && Number(out[i]!.metadata?._timestamp) <= oldest + 1; i--) seen.add(rowKey(out[i]!));
        edge = { maxTs: oldest + 1, seen };
        to = oldest + 1;
        offset = 0;
      }
    }
    return out.slice(0, limit);
  }

  /** Normalized entry; metadata keeps non-empty fields only, without second copies of the message text. */
  private toEntry(row: Record<string, unknown>): LogEntry {
    const metadata: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) if (value !== null && value !== undefined && value !== '' && !MESSAGE_FIELDS.has(key)) metadata[key] = value;
    return {
      timestamp: typeof row._timestamp === 'number' ? new Date(row._timestamp / 1000).toISOString() : new Date().toISOString(),
      level: row.level || row.severity ? normalizeLogLevel(String(row.level || row.severity)) : levelFromText(row.log),
      message: stripAnsi(String(row.message || row.body || row.log || row.msg || JSON.stringify(row))).trim(),
      provider: this.name,
      service: serviceOf(row),
      metadata,
    };
  }

  public async findByRcid(params: Omit<OpenObserveSearch, 'sql'> & { stream: string; field: string; rcid: string }): Promise<LogEntry[]> {
    if (!params.rcid.trim()) throw new Error('RCID is required');
    const cached = findCachedRcid(params.stream, params.rcid, params.organization);
    if (cached !== undefined) {
      logger.info('ai_context.cache_hit', { stream: params.stream, rcid: params.rcid, count: cached.length });
      return cached.slice(0, params.limit || 50);
    }
    const operationId = params.operationId || randomUUID();
    const streams = await this.listStreams(params.organization, operationId);
    if (!streams.includes(params.stream)) throw new Error(`Log stream '${params.stream}' is not accessible`);
    const sql = `SELECT * FROM ${quoteIdentifier(params.stream)} WHERE ${quoteIdentifier(params.field)} = ${quoteString(params.rcid)} ORDER BY _timestamp DESC`;
    const logs = await this.searchLogs({ ...params, sql, operationId });
    if (logs.length > 0) {
      const from = parseTimeBound(params.from || '15m') || new Date(Date.now() - 15 * 60_000).toISOString();
      const to = (params.to ? parseTimeBound(params.to) : undefined) || new Date().toISOString();
      const org = (await this.listOrganizations(operationId)).find((o) => o.identifier === params.organization);
      cloneRcidToAiContext({
        provider: this.name, env: openObserveAccount().env, organization: org?.name || 'default', stream: params.stream,
        from, to, limit: params.limit || 50,
      }, params.organization, params.rcid, params.field, logs);
    }
    return logs;
  }

  /** Services in a stream with log counts (and per-level counts when the stream has a level field). */
  public async listServices(params: Omit<OpenObserveServiceQuery, 'service' | 'levels' | 'limit'>): Promise<{ field: string; services: OpenObserveService[] }> {
    const shape = detectShape(await this.getStreamSchema(params.organization, params.stream));
    if (!shape.serviceField) return { field: '', services: [] };
    const svc = quoteIdentifier(shape.serviceField);
    const lvl = shape.levelField && !shape.k8s ? quoteIdentifier(shape.levelField) : undefined;
    const groupBy = lvl ? `${svc}, ${lvl}` : svc;
    const rows = await this.searchLogs({
      organization: params.organization, from: params.from || '1h', to: params.to, limit: Infinity,
      sql: `SELECT ${svc} AS service${lvl ? ', ' + lvl + ' AS lvl' : ''}, COUNT(*) AS n FROM ${quoteIdentifier(params.stream)} WHERE ${svc} IS NOT NULL GROUP BY ${groupBy}`,
    });
    const services = new Map<string, OpenObserveService>();
    for (const { metadata: row = {} } of rows) {
      const name = shape.k8s ? deploymentName(String(row.service)) : String(row.service);
      const entry = services.get(name) ?? { name, count: 0, ...(lvl ? { levels: {} } : {}) };
      const n = Number(row.n) || 0;
      entry.count += n;
      if (entry.levels) {
        const level = normalizeLogLevel(String(row.lvl ?? ''));
        entry.levels[level] = (entry.levels[level] ?? 0) + n;
      }
      services.set(name, entry);
    }
    return { field: shape.serviceField, services: [...services.values()].sort((a, b) => b.count - a.count) };
  }

  /**
   * What a service/level query selects in a stream: `where` (service and levels), `noise` (framework noise rows, when
   * the stream has logger categories), `columns` (schema without DROP_FIELDS). Shared by the search, its count and its aggregates.
   */
  private async serviceQuery(params: OpenObserveServiceQuery): Promise<{ where: string; noise?: string; columns: string; names: Set<string> }> {
    const schema = await this.getStreamSchema(params.organization, params.stream);
    const shape = detectShape(schema);
    const names = new Set(schema.map((f) => f.name));
    const where: string[] = [];
    if (shape.serviceField) {
      const svc = quoteIdentifier(shape.serviceField);
      where.push(`${svc} IS NOT NULL`);
      if (params.service) where.push(shape.k8s ? `${svc} LIKE ${quoteString(params.service + '-%')}` : `${svc} = ${quoteString(params.service)}`);
    } else {
      where.push('1=1');
    }
    if (params.levels?.length) {
      if (shape.levelField && !shape.k8s) {
        const values = [...new Set(params.levels.flatMap((l) => LEVEL_ALIASES[l]).flatMap((a) => [a, a.toLowerCase()]))];
        where.push(`${quoteIdentifier(shape.levelField)} IN (${values.map(quoteString).join(', ')})`);
      } else {
        // Coarse prefilter on the raw text; exact level is checked after fetch.
        where.push(`(${params.levels.flatMap((l) => LEVEL_WORDS[l]).map((w) => `str_match_ignore_case(log, ${quoteString(w)})`).join(' OR ')})`);
      }
    }
    return { where: where.join(' AND '), noise: shape.k8s ? undefined : noiseWhere(names, shape.levelField), columns: selectColumns(schema.map((f) => f.name)), names };
  }

  /** Rows searchServiceLogs would download (before the Kubernetes level refinement), to size snapshots before fetching. */
  public async countServiceLogs(params: OpenObserveServiceQuery): Promise<{ total: number; noise: number; download: number }> {
    const q = await this.serviceQuery(params);
    const count = async (where: string) => Number((await this.searchLogs({
      organization: params.organization, from: params.from, to: params.to, limit: 1,
      sql: `SELECT COUNT(*) AS n FROM ${quoteIdentifier(params.stream)} WHERE ${where}`,
    }))[0]?.metadata?.n) || 0;
    const [total, noise] = await Promise.all([count(q.where), q.noise && !params.includeNoise ? count(`${q.where} AND ${q.noise}`) : 0]);
    return { total, noise, download: total - noise };
  }

  /**
   * Server-side counts of what searchServiceLogs skips (framework noise by service/level/category/hour, top noise
   * messages) and HTTP request totals (all rows with a status code). GROUP BY over a day takes well under a second.
   */
  public async exportAggregates(params: OpenObserveServiceQuery): Promise<ExportAggregates> {
    const q = await this.serviceQuery(params);
    const stream = quoteIdentifier(params.stream);
    const has = (name: string) => q.names.has(name);
    const rows = async (sql: string, limit = Infinity) => (await this.searchLogs({ organization: params.organization, from: params.from, to: params.to, limit, sql }))
      .map((row) => row.metadata ?? {});
    const text = (value: unknown) => (value === null || value === undefined ? '' : String(value));
    const iso = (us: unknown) => new Date(Number(us) / 1000).toISOString();
    const levelField = has('severity') ? '"severity"' : '"level"';
    const serviceField = has('service_name') ? '"service_name"' : '"applicationname"';
    const message = has('message_template_text') && has('body') ? `COALESCE("message_template_text", SUBSTR("body", 1, 160))`
      : has('body') ? `SUBSTR("body", 1, 160)` : undefined;
    const paths = ['requestpath', 'path'].filter(has).map(quoteIdentifier);
    const pathExpr = paths.length > 1 ? `COALESCE(${paths.join(', ')})` : paths[0];
    // HTTP totals ignore the level filter: "Request finished" rows are Information.
    const httpWhere = (await this.serviceQuery({ ...params, levels: undefined })).where;
    const [noise, templates, http] = await Promise.all([
      q.noise && !params.includeNoise ? rows(`SELECT ${serviceField} AS service, ${levelField} AS lvl, "instrumentation_library_name" AS category, histogram(_timestamp, '1 hour') AS hour, COUNT(*) AS n FROM ${stream} WHERE ${q.where} AND ${q.noise} GROUP BY service, lvl, category, hour`) : [],
      q.noise && !params.includeNoise && message ? rows(`SELECT "instrumentation_library_name" AS category, ${message} AS template, COUNT(*) AS n, MIN(_timestamp) AS first_ts, MAX(_timestamp) AS last_ts FROM ${stream} WHERE ${q.where} AND ${q.noise} GROUP BY category, template ORDER BY n DESC`, 30) : [],
      // GROUP BY the expressions, not the aliases: an alias named like a column ("path") would group by the column.
      has('statuscode') && pathExpr ? rows(`SELECT ${pathExpr} AS path, ${has('method') ? '"method"' : "''"} AS method, "statuscode" AS status, COUNT(*) AS n${has('elapsedmilliseconds') ? ', AVG(CAST("elapsedmilliseconds" AS DOUBLE)) AS avg_ms, MAX(CAST("elapsedmilliseconds" AS DOUBLE)) AS max_ms' : ''} FROM ${stream} WHERE ${httpWhere} AND "statuscode" IS NOT NULL GROUP BY ${[pathExpr, ...(has('method') ? ['"method"'] : []), '"statuscode"'].join(', ')} ORDER BY n DESC`, 100) : [],
    ]);
    return {
      noise: noise.map((r) => ({ service: text(r.service), level: normalizeLogLevel(text(r.lvl)), category: text(r.category), hour: `${text(r.hour).slice(0, 13)}:00:00Z`, n: Number(r.n) || 0 })),
      templates: templates.map((r) => ({ category: text(r.category), template: text(r.template), n: Number(r.n) || 0, firstSeen: iso(r.first_ts), lastSeen: iso(r.last_ts) })),
      http: http.map((r) => ({ path: text(r.path) || '(none)', method: text(r.method), status: text(r.status), n: Number(r.n) || 0, avgMs: Math.round(Number(r.avg_ms) || 0), maxMs: Math.round(Number(r.max_ms) || 0) })),
    };
  }

  /**
   * Logs of one service (or all) filtered to exact levels, newest first. Framework noise rows are skipped unless
   * includeNoise (count them with exportAggregates), and DROP_FIELDS columns are never selected.
   */
  public async searchServiceLogs(params: OpenObserveServiceQuery): Promise<LogEntry[]> {
    const from = parseTimeBound(params.from || '1h');
    const to = params.to ? parseTimeBound(params.to) : new Date().toISOString();
    if (from && to) {
      const cached = findCachedLogs({ stream: params.stream, service: params.service, levels: params.levels, from, to }, params.organization);
      if (cached !== undefined) {
        logger.info('ai_context.cache_hit', { stream: params.stream, service: params.service, count: cached.length });
        return cached.slice(0, params.limit || 50);
      }
    }
    const q = await this.serviceQuery(params);
    const where = q.noise && !params.includeNoise ? `${q.where} AND NOT ${q.noise}` : q.where;
    const logs = await this.searchLogs({
      organization: params.organization, from: params.from, to: params.to, limit: params.limit, onProgress: params.onProgress,
      sql: `SELECT ${q.columns} FROM ${quoteIdentifier(params.stream)} WHERE ${where} ORDER BY _timestamp DESC`,
    });
    // ponytail: Kubernetes level and service are refined after fetch (level comes from log text), so results may under-fill `limit`.
    const filtered = logs.filter((log) => (!params.service || log.service === params.service) && (!params.levels?.length || params.levels.includes(log.level as LogLevel)));
    if (from && to && filtered.length > 0) {
      const org = (await this.listOrganizations()).find((o) => o.identifier === params.organization);
      cloneLogsToAiContext({
        provider: this.name, env: openObserveAccount().env, organization: org?.name || 'default', stream: params.stream,
        service: params.service, levels: params.levels, from, to, limit: params.limit || Infinity,
      }, params.organization, filtered);
    }
    return filtered;
  }

  /**
   * Full request flows: every log in the stream sharing each correlation id, across services and levels.
   * Ids are fetched FLOW_BATCH per SELECT (`IN (...)`, FLOW_CONCURRENCY batches at a time): one query per id cost
   * ~0.25s of server time each, a minute for 200 flows. Each flow keeps its newest MAX_ROWS rows.
   * Ids with a `ts` (when their error was seen) are batched in time order and each batch searches only around its
   * own errors; others search [from, to]. Either window is widened by FLOW_PAD_MS so a request stays whole.
   */
  public async fetchFlows(params: { organization: string; stream: string; ids: Array<{ field: string; value: string; ts?: string }>; from: string; to: string }): Promise<RequestFlow[]> {
    // Match each id value on every correlation field the stream has: one request may log it as rcid in one sink and trace_id in another.
    const names = (await this.getStreamSchema(params.organization, params.stream)).map((f) => f.name);
    const schema = new Set(names);
    const fields = FLOW_ID_FIELDS.filter((field) => schema.has(field));
    // Flows keep framework noise (SQL, request in/out, outgoing HTTP): it shows what one failing request did.
    const columns = selectColumns(names);
    const flows = new Map(params.ids.map(({ field, value }) => [value, { field, value, entries: [] as LogEntry[] }]));
    const ids = [...params.ids].sort((a, b) => (a.ts ?? '').localeCompare(b.ts ?? ''));
    const batches: Array<typeof ids> = [];
    for (let i = 0; fields.length && i < ids.length; i += FLOW_BATCH) batches.push(ids.slice(i, i + FLOW_BATCH));
    for (let i = 0; i < batches.length; i += FLOW_CONCURRENCY) {
      await Promise.all(batches.slice(i, i + FLOW_CONCURRENCY).map(async (batch) => {
        const list = batch.map((id) => quoteString(id.value)).join(', ');
        const from = new Date(Date.parse(batch[0]!.ts ?? params.from) - FLOW_PAD_MS).toISOString();
        const to = new Date(Math.min(Date.now(), Date.parse(batch[batch.length - 1]!.ts ?? params.to) + FLOW_PAD_MS)).toISOString();
        // Finite limit: one cursor per batch, so FLOW_CONCURRENCY batches stay FLOW_CONCURRENCY requests (no time slices).
        const rows = await this.searchLogs({ organization: params.organization, from, to, limit: FLOW_BATCH * MAX_ROWS,
          sql: `SELECT ${columns} FROM ${quoteIdentifier(params.stream)} WHERE ${fields.map((f) => `${quoteIdentifier(f)} IN (${list})`).join(' OR ')} ORDER BY _timestamp DESC` });
        // A row can carry two picked ids (rcid of one, trace_id of another): it belongs to both flows.
        for (const row of rows) {
          for (const value of new Set(fields.map((f) => row.metadata?.[f]).filter((v) => v !== undefined).map(String))) {
            const flow = flows.get(value);
            if (flow && flow.entries.length < MAX_ROWS) flow.entries.push(row);
          }
        }
      }));
    }
    const loaded = [...flows.values()].filter((flow) => flow.entries.length);
    logger.info('openobserve.flows_loaded', { stream: params.stream, flows: loaded.length, rows: loaded.reduce((n, f) => n + f.entries.length, 0) });
    return loaded;
  }

  // ponytail: level is filtered after fetch (level field name varies per stream), so `limit` may under-fill; add a `levelField` param to push it into SQL if that matters.
  public async queryLogs(params: LogQuery): Promise<LogEntry[]> {
    if (!params.organization) throw new Error('OpenObserve organization is required');
    if (!params.query && !params.stream) throw new Error('OpenObserve SQL query or stream is required');
    if (params.stream && !params.query) {
      const from = parseTimeBound(params.from || '15m');
      const to = params.to ? parseTimeBound(params.to) : new Date().toISOString();
      const levels = resolveLevels(params.level);
      if (from && to) {
        const cached = findCachedLogs({ stream: params.stream, levels, from, to }, params.organization);
        if (cached !== undefined) {
          logger.info('ai_context.cache_hit', { stream: params.stream, count: cached.length });
          return cached.slice(0, params.limit || 50);
        }
      }
    }
    const sql = params.query || `SELECT * FROM "${params.stream!.replace(/"/g, '""')}" ORDER BY _timestamp DESC`;
    const stream = params.stream || sql.match(/FROM\s+["']?([^"'\s,;)]+)["']?/i)?.[1];
    const logs = await this.searchLogs({ organization: params.organization, sql, from: params.from, to: params.to, limit: params.limit });
    if (stream && logs.length > 0) {
      const from = parseTimeBound(params.from || '15m') || new Date(Date.now() - 15 * 60_000).toISOString();
      const to = (params.to ? parseTimeBound(params.to) : undefined) || new Date().toISOString();
      const org = (await this.listOrganizations()).find((o) => o.identifier === params.organization);
      cloneLogsToAiContext({
        provider: this.name, env: openObserveAccount().env, organization: org?.name || 'default', stream,
        from, to, limit: params.limit || 50,
      }, params.organization, logs);
    }
    return logs;
  }
}
