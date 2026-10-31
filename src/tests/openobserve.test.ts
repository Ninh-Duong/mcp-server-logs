import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { OpenObserveProvider, levelFromText } from '../providers/openobserve.js';
import { getProvider } from '../providers/index.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { ORG as org, SCHEMA, fakeSearch, routed, setup, us } from './helpers.js';

const oldFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = oldFetch; });

test('lists only organizations returned for the configured account', async () => {
  const { provider, calls } = setup([{ data: [{ name: 'acme', identifier: 'org-id' }] }]);
  assert.deepEqual(await provider.listOrganizations(), [{ name: 'acme', identifier: 'org-id' }]);
  assert.equal(calls[0]?.url, 'https://logs.example.test:10443/api/organizations');
  assert.equal(new Headers(calls[0]?.init?.headers).get('authorization'), 'Basic ' + Buffer.from('reader@example.test:test-token').toString('base64'));
});

test('lists log streams for a selected organization', async () => {
  const { provider, calls } = setup([{ data: [{ name: 'acme', identifier: 'org-id' }] }, { list: [{ name: 'shop_prod', stream_type: 'logs' }] }]);
  assert.deepEqual(await provider.listStreams('org-id'), ['shop_prod']);
  assert.equal(calls[1]?.url, 'https://logs.example.test:10443/api/org-id/streams?type=logs');
});

test('returns stream field names and types for agent SQL planning', async () => {
  const { provider, calls } = setup([
    { data: [{ name: 'acme', identifier: 'org-id' }] },
    { list: [{ name: 'shop_prod', stream_type: 'logs' }] },
    { name: 'shop_prod', schema: [{ name: '_timestamp', type: 'Int64' }, { name: 'rcid', type: 'Utf8' }] },
  ]);
  assert.deepEqual(await provider.getStreamSchema('org-id', 'shop_prod'), [
    { name: '_timestamp', type: 'Int64' }, { name: 'rcid', type: 'Utf8' },
  ]);
  assert.equal(calls[2]?.url, 'https://logs.example.test:10443/api/org-id/streams/shop_prod/schema?type=logs');
});

test('writes redacted OpenObserve HTTP failure details to the process log', async () => {
  const { provider } = setup([]);
  globalThis.fetch = async () => new Response('Unauthorized Access', { status: 401 });
  await assert.rejects(provider.listOrganizations(), /HTTP 401/);
  const recent = logger.getRecentLogs(10).join('\n');
  assert.match(recent, /openobserve\.request_failed/);
  assert.match(recent, /401/);
  assert.doesNotMatch(recent, /test-token|Authorization|reader@example\.test/);
});

test('gives the ai-context key only to an account enabled for the organization', async () => {
  const { provider } = setup([{ data: [{ name: 'acme', identifier: 'org-key-123' }] }]);
  assert.equal(await provider.organizationKey(undefined, 'acme'), 'org-key-123');
  await assert.rejects(provider.organizationKey(undefined, 'other_au'), /No access: .*not enabled for organization 'other_au'/);
  globalThis.fetch = async () => new Response('Unauthorized', { status: 401 });
  await assert.rejects(new OpenObserveProvider().organizationKey(undefined, 'acme'), /No access: cannot connect/);
  await assert.rejects(provider.organizationKey('qa', 'acme'), /Unknown OpenObserve environment/);
});

test('keeps organization identifiers out of the process log', async () => {
  const { provider } = setup([{ data: [{ name: 'acme', identifier: 'org-key-123' }] }, { list: [{ name: 's' }] }]);
  await provider.listStreams('org-key-123');
  assert.doesNotMatch(logger.getRecentLogs(20).join('\n'), /org-key-123/);
});

for (const inclusiveEnd of [true, false]) {
  test(`pages newest first with a time cursor, no deep offsets and no duplicates (end_time ${inclusiveEnd ? 'inclusive' : 'exclusive'})`, async () => {
    const start = Date.parse('2026-10-15T00:00:00Z') * 1000;
    // 3 rows per timestamp, every 0.18s across the hour: cursor edges and the 12-minute slice boundaries both cut through
    // rows that share a timestamp, and the first rows sit exactly on the range start.
    const rows = Array.from({ length: 60_000 }, (_, i) => ({ _timestamp: start + Math.floor(i / 3) * 180_000, message: `m${i}` }));
    const sql = 'SELECT * FROM "s" ORDER BY _timestamp DESC';
    const range = { organization: 'org-id', sql, from: '2026-10-15T00:00:00Z', to: '2026-10-15T01:00:00Z' };

    const { provider, queries } = fakeSearch(rows, inclusiveEnd);
    const logs = await provider.searchLogs({ ...range, limit: 55_000 });
    assert.equal(logs.length, 55_000);
    assert.equal(new Set(logs.map((l) => l.message)).size, 55_000, 'no duplicates');
    assert.deepEqual(logs.slice(0, 3).map((l) => l.message).sort(), ['m59997', 'm59998', 'm59999'], 'newest timestamp first');
    assert.ok(Math.max(...queries.map((q) => q.from)) < 20_000, 'offset never goes deep');
    assert.ok(queries.every((q) => q.size <= 5000));

    const all = fakeSearch(rows, inclusiveEnd);
    let progress = 0;
    const every = await all.provider.searchLogs({ ...range, limit: Infinity, onProgress: (n) => { progress = n; } });
    assert.equal(new Set(every.map((l) => l.message)).size, 60_000, 'parallel slices return every row once');
    assert.equal(every.length, 60_000);
    assert.ok(progress >= 60_000);
    assert.ok(new Set(all.queries.map((q) => q.start_time)).size >= 5, 'unlimited search runs 5 time slices');
    assert.ok(every.every((l, i) => !i || l.timestamp <= every[i - 1]!.timestamp), 'merged newest first');
  });
}

test('retries transient OpenObserve failures, not auth errors', async () => {
  const { provider } = setup([]);
  let calls = 0;
  globalThis.fetch = async () => (++calls === 1
    ? new Response('busy', { status: 503 })
    : new Response(JSON.stringify({ data: [{ name: 'acme', identifier: 'org-id' }] }), { status: 200 }));
  assert.equal((await provider.listOrganizations()).length, 1);
  assert.equal(calls, 2);
  calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('no', { status: 401 }); };
  await assert.rejects(new OpenObserveProvider().listOrganizations(), /HTTP 401/);
  assert.equal(calls, 1);
});

test('counts service logs with the same filter as the search', async () => {
  const { provider, calls } = setup([
    { data: [{ name: 'acme', identifier: 'org-id' }] }, { list: [{ name: 's' }] },
    { schema: [{ name: 'service_name', type: 'Utf8' }, { name: 'severity', type: 'Utf8' }] }, { hits: [{ n: 9_400_000 }] },
  ]);
  assert.deepEqual(await provider.countServiceLogs({ organization: 'org-id', stream: 's', service: 'api', levels: ['Error'], from: '24h' }), { total: 9_400_000, noise: 0, download: 9_400_000 });
  assert.match(JSON.parse(String(calls[3]?.init?.body)).query.sql, /^SELECT COUNT\(\*\) AS n FROM "s" WHERE "service_name" IS NOT NULL AND "service_name" = 'api' AND "severity" IN \(/);
});

test('skips framework noise and constant fields when downloading; flows keep the noise', async () => {
  const { provider, sqls } = routed(SCHEMA, (sql) => (sql.startsWith('SELECT COUNT') ? [{ n: sql.includes('COALESCE("instrumentation_library_name"') ? 80 : 100 }] : []));
  assert.deepEqual(await provider.countServiceLogs({ organization: 'org-id', stream: 's', from: '24h' }), { total: 100, noise: 80, download: 20 });

  await provider.searchServiceLogs({ organization: 'org-id', stream: 's', from: '24h', limit: 10 });
  const search = sqls.at(-1)!;
  assert.match(search, /^SELECT "_timestamp", "service_name", "severity", "instrumentation_library_name", "endpointname", "path", "body", "rcid" FROM "s" WHERE "service_name" IS NOT NULL AND NOT \(COALESCE\("severity", ''\) IN \('Information', 'information'/);
  assert.match(search, /COALESCE\("path", ''\) LIKE '\/health-checks\/%' OR COALESCE\("endpointname", ''\) = 'Health checks' OR COALESCE\("instrumentation_library_name", ''\) LIKE 'Microsoft\.AspNetCore\.Hosting\.%'/);
  assert.match(search, /COALESCE\("instrumentation_library_name", ''\) = 'Microsoft\.EntityFrameworkCore\.Database\.Command'/);
  assert.doesNotMatch(search, /telemetry_sdk_version|environment|'Warning'|'Error'/, 'constant fields dropped; warnings and errors never count as noise');

  await provider.searchServiceLogs({ organization: 'org-id', stream: 's', from: '24h', limit: 10, includeNoise: true });
  assert.doesNotMatch(sqls.at(-1)!, /NOT \(/, 'include_noise downloads everything');
  assert.deepEqual(await provider.countServiceLogs({ organization: 'org-id', stream: 's', from: '24h', includeNoise: true }), { total: 100, noise: 0, download: 100 });

  await provider.fetchFlows({ organization: 'org-id', stream: 's', ids: [{ field: 'rcid', value: 'r1' }], from: '2026-10-15T00:00:00Z', to: '2026-10-15T01:00:00Z' });
  assert.match(sqls.at(-1)!, /^SELECT "_timestamp", .*"rcid" FROM "s" WHERE "rcid" IN \('r1'\) ORDER BY _timestamp DESC$/, 'flows keep framework noise');
});

test('counts skipped noise and HTTP requests on the server', async () => {
  const { provider, sqls } = routed([...SCHEMA, 'statuscode', 'method', 'requestpath', 'elapsedmilliseconds', 'message_template_text'], (sql) =>
    sql.includes('histogram(') ? [{ service: 'api', lvl: 'Information', category: 'Microsoft.AspNetCore.Hosting.Diagnostics', hour: '2026-10-15T04:00:00', n: 7 }]
      : sql.includes('AS template') ? [{ category: 'Microsoft.AspNetCore.Hosting.Diagnostics', template: 'Request starting {Path}', n: 7, first_ts: 1792039755586000, last_ts: 1792039755586000 }]
        : [{ path: '/orders', method: 'POST', status: '500', n: 3, avg_ms: 120.4, max_ms: 300 }]);
  const aggregates = await provider.exportAggregates({ organization: 'org-id', stream: 's', from: '24h', levels: ['Information', 'Error'] });
  assert.deepEqual(aggregates.noise, [{ service: 'api', level: 'Information', category: 'Microsoft.AspNetCore.Hosting.Diagnostics', hour: '2026-10-15T04:00:00Z', n: 7 }]);
  assert.deepEqual(aggregates.templates.map((t) => [t.template, t.n]), [['Request starting {Path}', 7]]);
  assert.deepEqual(aggregates.http, [{ path: '/orders', method: 'POST', status: '500', n: 3, avgMs: 120, maxMs: 300 }]);
  const http = sqls.find((s) => s.includes('"statuscode" IS NOT NULL'))!;
  assert.match(http, /COALESCE\("requestpath", "path"\) AS path/);
  assert.match(http, /GROUP BY COALESCE\("requestpath", "path"\), "method", "statuscode"/, 'groups by expressions, not by aliases that shadow columns');
  assert.doesNotMatch(http, /"severity" IN/, 'HTTP totals ignore the level filter');
  assert.deepEqual(await routed(SCHEMA, () => []).provider.exportAggregates({ organization: 'org-id', stream: 's', from: '24h', includeNoise: true }), { noise: [], templates: [], http: [] });
});

test('search sends bounded SQL and normalizes hits', async () => {
  const { provider, calls } = setup([{ data: [{ name: 'acme', identifier: 'org-id' }] }, { hits: [{ _timestamp: 1790577000000000, level: 'error', message: 'broken', rcid: 'abc' }] }]);
  const logs = await provider.searchLogs({ organization: 'org-id', sql: 'SELECT * FROM "shop_prod"', from: '2026-09-28T05:00:00Z', to: '2026-09-28T05:15:00Z', limit: 20 });
  assert.equal(logs[0]?.message, 'broken');
  assert.equal(logs[0]?.level, 'Error');
  assert.equal(logs[0]?.metadata?.rcid, 'abc');
  assert.equal(calls[1]?.url, 'https://logs.example.test:10443/api/org-id/_search');
  const body = JSON.parse(String(calls[1]?.init?.body));
  assert.deepEqual(body.query, { sql: 'SELECT * FROM "shop_prod"', start_time: 1790571600000000, end_time: 1790572500000000, from: 0, size: 20 });
});

test('rejects non-SELECT OpenObserve queries before making a request', async () => {
  const { provider, calls } = setup([]);
  await assert.rejects(provider.searchLogs({ organization: 'org-id', sql: 'DELETE FROM "logs"' }), /Only a single SELECT query is allowed/);
  assert.equal(calls.length, 0);
});

test('RCID search quotes data and stream names', async () => {
  const { provider, calls } = setup([{ data: [{ name: 'acme', identifier: 'org-id' }] }, { list: [{ name: 'log"one', stream_type: 'logs' }] }, { hits: [] }]);
  await provider.findByRcid({ organization: 'org-id', stream: 'log"one', field: 'rcid', rcid: "x' OR 1=1", from: '15m', limit: 10 });
  const body = JSON.parse(String(calls[2]?.init?.body));
  assert.equal(body.query.sql, `SELECT * FROM "log""one" WHERE "rcid" = 'x'' OR 1=1' ORDER BY _timestamp DESC`);
});

test('rejects an organization outside the account list', async () => {
  const { provider, calls } = setup([{ data: [{ name: 'allowed', identifier: 'good' }] }]);
  await assert.rejects(provider.listStreams('bad'), /not accessible/);
  assert.equal(calls.length, 1);
});

test('rejects an invalid end time instead of silently searching until now', async () => {
  const { provider, calls } = setup([{ data: [{ name: 'acme', identifier: 'org-id' }] }]);
  await assert.rejects(provider.searchLogs({ organization: 'org-id', sql: 'SELECT * FROM "logs"', from: '15m', to: 'not-a-date' }), /Invalid time range/);
  assert.equal(calls.length, 1);
});

test('reuses the organization list across calls within the cache window', async () => {
  const { provider, calls } = setup([{ data: [{ name: 'acme', identifier: 'org-id' }] }, { list: [{ name: 's1' }] }, { list: [{ name: 's1' }] }]);
  await provider.listStreams('org-id');
  await provider.listStreams('org-id');
  assert.equal(calls.filter((c) => c.url.endsWith('/api/organizations')).length, 1);
});

test('keeps the old observe provider name as an alias for OpenObserve', () => {
  assert.equal(getProvider('observe')?.name, 'openobserve');
});

const k8sSchema = { schema: ['_timestamp', 'kubernetes_host', 'kubernetes_namespace_name', 'kubernetes_pod_name', 'log'].map((name) => ({ name, type: 'Utf8' })) };

test('lists structured services with per-level counts', async () => {
  const { provider, calls } = setup([org, { list: [{ name: 'shop' }] }, { schema: [{ name: 'service_name', type: 'Utf8' }, { name: 'severity', type: 'Utf8' }] }, { hits: [
    { service: 'Shop.Gateway', lvl: 'Information', n: 90 }, { service: 'Shop.Gateway', lvl: 'Error', n: 7 },
    { service: 'Shop.Gateway', lvl: 'Critical', n: 1 }, { service: 'Shop.Report', lvl: 'Warning', n: 200 },
  ] }]);
  const result = await provider.listServices({ organization: 'org-id', stream: 'shop', from: '1h' });
  assert.equal(result.field, 'service_name');
  assert.deepEqual(result.services, [
    { name: 'Shop.Report', count: 200, levels: { Warning: 200 } },
    { name: 'Shop.Gateway', count: 98, levels: { Information: 90, Error: 7, Fatal: 1 } },
  ]);
  assert.match(JSON.parse(String(calls[3]?.init?.body)).query.sql, /GROUP BY "service_name", "severity"/);
});

test('groups Kubernetes pods into deployments', async () => {
  const { provider } = setup([org, { list: [{ name: 'k8s' }] }, k8sSchema, { hits: [
    { service: 'shop-api-5c67fbd785-lcm4v', n: 300 }, { service: 'shop-api-6fc69d88bc-grj24', n: 7 }, { service: 'shop-worker-598fbd4ccd-rdskk', n: 59 },
  ] }]);
  const { services } = await provider.listServices({ organization: 'org-id', stream: 'k8s' });
  assert.deepEqual(services.map((s) => [s.name, s.count]), [['shop-api', 307], ['shop-worker', 59]]);
});

test('structured service search escapes the service and expands level aliases', async () => {
  const { provider, calls } = setup([org, { list: [{ name: 'shop' }] }, { schema: [{ name: 'service_name', type: 'Utf8' }, { name: 'severity', type: 'Utf8' }] }, { hits: [] }]);
  await provider.searchServiceLogs({ organization: 'org-id', stream: 'shop', service: "x' OR 1=1", levels: ['Error', 'Fatal'], from: '1h' });
  const sql = JSON.parse(String(calls[3]?.init?.body)).query.sql;
  assert.match(sql, /"service_name" = 'x'' OR 1=1'/);
  assert.match(sql, /"severity" IN \('Error', 'error', 'ERR', 'err', 'Fatal', 'fatal', 'Critical', 'critical'/);
});

test('Kubernetes service search takes level and service from pod name and log text', async () => {
  const { provider } = setup([org, { list: [{ name: 'k8s' }] }, k8sSchema, { hits: [
    { _timestamp: 1, kubernetes_pod_name: 'api-5c67fbd785-lcm4v', log: '[NestWinston] 1  10/7/2026 \x1b[33mWARN\x1b[39M [Guard] disabled\n' },
    { _timestamp: 2, kubernetes_pod_name: 'api-5c67fbd785-lcm4v', log: '[NestWinston] 1  10/7/2026 \x1b[32MINFO\x1b[39M [Job] warning count: 0\n' },
    { _timestamp: 3, kubernetes_pod_name: 'api-v2-5c67fbd785-lcm4v', log: '[NestWinston] \x1b[31merror\x1b[39m boom' },
  ] }]);
  const logs = await provider.searchServiceLogs({ organization: 'org-id', stream: 'k8s', service: 'api', levels: ['Warning'], from: '1h' });
  assert.deepEqual(logs.map((l) => [l.service, l.level, l.message]), [['api', 'Warning', '[NestWinston] 1  10/7/2026 WARN [Guard] disabled']]);
});

test('reads levels from colored log text', () => {
  assert.equal(levelFromText('[NestWinston] 1  10/7/2026, 7:00:00 PM \x1b[32MINFO\x1b[39M [Mail] sent'), 'Information');
  assert.equal(levelFromText('[NestWinston] \x1b[33m\x1b[36mverbose\x1b[33m\x1b[39m\t10/7/2026'), 'Verbose');
  assert.equal(levelFromText('plain line without level'), 'Information');
});

test('search pages 5000 rows at a time until the data runs out', async () => {
  const page = (n: number) => ({ hits: Array.from({ length: n }, (_, i) => ({ _timestamp: i, message: `m${i}` })) });
  const { provider, calls } = setup([org, page(5000), page(120)]);
  const logs = await provider.searchLogs({ organization: 'org-id', sql: 'SELECT * FROM "s"', from: '1h', limit: Infinity });
  assert.equal(logs.length, 5120);
  const bodies = calls.slice(1).map((c) => JSON.parse(String(c.init?.body)).query);
  assert.deepEqual(bodies.map((q) => [q.from, q.size]), [[0, 5000], [5000, 5000]]);
});

test('search stops paging at the requested limit', async () => {
  const page = (n: number) => ({ hits: Array.from({ length: n }, (_, i) => ({ _timestamp: i, message: 'm' })) });
  const { provider, calls } = setup([org, page(5000), page(2000)]);
  const logs = await provider.searchLogs({ organization: 'org-id', sql: 'SELECT * FROM "s"', from: '1h', limit: 7000 });
  assert.equal(logs.length, 7000);
  assert.deepEqual(JSON.parse(String(calls[2]?.init?.body)).query.size, 2000);
});

test('fetches request flows in batched queries on every id field and drops empty flows', async () => {
  const rows = [
    { _timestamp: 3, trace_id: "t'2", message: 'c' },
    { _timestamp: 2, rcid: 'r1', message: 'b' },
    { _timestamp: 1, rcid: 'r1', trace_id: "t'2", message: 'a' },
  ];
  const { provider, sqls } = routed(['_timestamp', 'rcid', 'trace_id'], () => rows);
  const queries: Array<{ start_time: number }> = [];
  const fetchRouted = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/_search')) queries.push(JSON.parse(String(init?.body)).query);
    return fetchRouted(url, init);
  };
  const ids = [{ field: 'rcid', value: 'r1' }, { field: 'trace_id', value: "t'2" }, { field: 'missing_field', value: 'x' }];
  const flows = await provider.fetchFlows({ organization: 'org-id', stream: 's', from: '2026-10-07T09:00:00Z', to: '2026-10-07T10:00:00Z', ids });
  assert.deepEqual(flows.map((f) => [f.field, f.value, f.entries.map((e) => e.message).join('')]), [['rcid', 'r1', 'ba'], ['trace_id', "t'2", 'ca']],
    'a row carrying two picked ids belongs to both flows');
  // One query for all ids (sent once per parallel time slice).
  assert.deepEqual([...new Set(sqls)], [`SELECT * FROM "s" WHERE "rcid" IN ('r1', 't''2', 'x') OR "trace_id" IN ('r1', 't''2', 'x') ORDER BY _timestamp DESC`]);
  assert.equal(queries[0]!.start_time, Date.parse('2026-10-07T08:45:00Z') * 1000, 'window padded by 15 minutes');

  const many = routed(['_timestamp', 'rcid'], () => []);
  await many.provider.fetchFlows({ organization: 'org-id', stream: 's', from: '2026-10-07T09:00:00Z', to: '2026-10-07T10:00:00Z',
    ids: Array.from({ length: 120 }, (_, i) => ({ field: 'rcid', value: `r${i}` })) });
  assert.equal(new Set(many.sqls).size, 3, '50 ids per query');
});

test('listServices handles empty stream schema without throwing', async () => {
  const { provider } = setup([
    org,
    { list: [{ name: 'empty_stream' }] },
    { name: 'empty_stream', schema: [] },
  ]);
  const res = await provider.listServices({ organization: 'org-id', stream: 'empty_stream' });
  assert.deepEqual(res, { field: '', services: [] });
});

test('findByRcid caches results in ai-context and returns from cache on subsequent calls', async () => {
  const rows = [{ _timestamp: Date.parse('2026-10-07T09:10:00Z') * 1000, rcid: 'rcid-test-1', message: 'req failed' }];
  const { provider, calls } = setup([
    org,
    { list: [{ name: 's' }] },
    { hits: rows },
    org,
  ]);
  // 1st call: cache miss -> queries remote & clones to ai-context
  const logs1 = await provider.findByRcid({ organization: 'org-id', stream: 's', field: 'rcid', rcid: 'rcid-test-1', from: '2026-10-07T09:00:00Z', to: '2026-10-07T10:00:00Z' });
  assert.equal(logs1.length, 1);
  assert.equal(logs1[0]?.message, 'req failed');

  // 2nd call: cache hit -> reads from ai-context, NO new remote query!
  const callCountBefore = calls.length;
  const logs2 = await provider.findByRcid({ organization: 'org-id', stream: 's', field: 'rcid', rcid: 'rcid-test-1', from: '2026-10-07T09:00:00Z', to: '2026-10-07T10:00:00Z' });
  assert.equal(logs2.length, 1);
  assert.equal(logs2[0]?.message, 'req failed');
  assert.equal(calls.length, callCountBefore, 'no additional remote call made on cache hit');
});

test('searchServiceLogs caches results in ai-context and returns from cache on subsequent calls', async () => {
  const rows = [
    { _timestamp: Date.parse('2026-10-07T09:15:00Z') * 1000, service_name: 'Shop.Api', level: 'Error', message: 'err msg' },
  ];
  const { provider, calls } = setup([
    org,
    { list: [{ name: 's' }] },
    { name: 's', schema: SCHEMA.map((n) => ({ name: n, type: 'Utf8' })) },
    { hits: rows },
    org,
  ]);
  const query = { organization: 'org-id', stream: 's', service: 'Shop.Api', from: '2026-10-07T09:00:00Z', to: '2026-10-07T10:00:00Z' };
  // 1st call: cache miss -> queries remote & clones
  const logs1 = await provider.searchServiceLogs(query);
  assert.equal(logs1.length, 1);

  // 2nd call: cache hit -> reads from ai-context
  const callCountBefore = calls.length;
  const logs2 = await provider.searchServiceLogs(query);
  assert.equal(logs2.length, 1);
  assert.equal(logs2[0]?.message, 'err msg');
  assert.equal(calls.length, callCountBefore, 'no additional remote call made on cache hit');
});

/** A provider with a settable clock, over `routed` (which counts every request by URL). */
function clocked(start: string, answer: (sql: string) => unknown[] = () => [], schema = ['_timestamp', 'body']) {
  const fake = routed(schema, answer);
  const urls: string[] = [];
  const answerRouted = globalThis.fetch;
  globalThis.fetch = (url, init) => { urls.push(String(url)); return answerRouted(url, init); };
  const clock = { now: Date.parse(start) };
  const provider = new OpenObserveProvider(() => clock.now);
  const count = (part: string) => urls.filter((u) => u.includes(part)).length;
  return { ...fake, provider, clock, count };
}

test('SQL search is cache first: a repeat (whitespace aside) is answered from ai-context in the same order', async () => {
  const rows = [3, 1, 2].map((m) => ({ _timestamp: us(`2026-10-07T09:0${m}:00Z`), body: `row ${m}` }));
  const { provider, sqls } = clocked('2026-10-07T12:00:00Z', () => rows);
  const search = { organization: 'org-id', sql: 'SELECT * FROM "s" WHERE "body" LIKE \'row%\'', from: '2026-10-07T09:00:00Z', to: '2026-10-07T10:00:00Z', limit: 10 };
  const first = await provider.searchCached(search);
  assert.deepEqual([first.cached, first.logs.map((l) => l.message)], [false, ['row 3', 'row 1', 'row 2']]);
  const again = await provider.searchCached({ ...search, sql: '  SELECT *\n  FROM "s"   WHERE "body" LIKE \'row%\' ' });
  assert.equal(again.cached, true);
  assert.deepEqual(again.logs, JSON.parse(JSON.stringify(first.logs)), 'same rows, same order, same JSON');
  assert.equal(sqls.length, 1, 'OpenObserve searched once');
  assert.deepEqual((await provider.searchCached({ ...search, limit: 2 })).logs.map((l) => l.message), ['row 3', 'row 1'], 'a smaller limit is cut from the cache');
  assert.equal((await provider.searchCached({ ...search, limit: 50 })).cached, true, 'a larger limit hits when the cache held every row');
  assert.equal(sqls.length, 1);

  const before = sqls.length;
  const searchQueries = await provider.queryLogs({ organization: 'org-id', query: search.sql, from: search.from, to: search.to, limit: 10 });
  assert.deepEqual(searchQueries.map((l) => l.message), ['row 3', 'row 1', 'row 2']);
  assert.equal(sqls.length, before, 'query_logs with the same SQL hits the same cache');
});

test('SQL cache misses on other SQL, quoted whitespace, window, env and a larger limit than a full cache held', async () => {
  const rows = [{ _timestamp: us('2026-10-07T09:05:00Z'), body: 'x' }, { _timestamp: us('2026-10-07T09:06:00Z'), body: 'y' }];
  const { provider, sqls } = clocked('2026-10-07T12:00:00Z', () => rows);
  const search = { organization: 'org-id', sql: 'SELECT * FROM "s" WHERE "body" = \'a  b\'', from: '2026-10-07T09:00:00Z', to: '2026-10-07T10:00:00Z', limit: 2 };
  await provider.searchCached(search);
  const misses = [
    { ...search, sql: 'SELECT * FROM "s" WHERE "body" = \'a b\'' },
    { ...search, to: '2026-10-07T10:30:00Z' },
    { ...search, limit: 3 },
  ];
  for (const miss of misses) assert.equal((await provider.searchCached(miss)).cached, false, JSON.stringify(miss));
  config.openobserve = { ...config.openobserve, env: 'stg' };
  assert.equal((await provider.searchCached(search)).cached, false, 'another env');
  assert.equal(sqls.length, 5);
});

test('empty SQL results are not cached', async () => {
  const { provider, sqls } = clocked('2026-10-07T12:00:00Z');
  const search = { organization: 'org-id', sql: 'SELECT * FROM "s" WHERE 0=1', from: '2026-10-07T09:00:00Z', to: '2026-10-07T10:00:00Z' };
  await provider.searchCached(search);
  assert.equal((await provider.searchCached(search)).cached, false);
  assert.equal(sqls.length, 2);
});

test('relative windows count from the minute start: two searches in one minute share one upstream request', async () => {
  const rows = [{ _timestamp: us('2026-10-07T11:50:00Z'), body: 'recent' }];
  const { provider, clock, queries } = clocked('2026-10-07T12:00:10.500Z', () => rows);
  const search = { organization: 'org-id', sql: 'SELECT * FROM "s" WHERE "body" = \'recent\'', from: '15m' };
  const first = await provider.searchCached(search);
  assert.deepEqual([first.from, first.to], ['2026-10-07T11:45:00.000Z', '2026-10-07T12:00:00.000Z']);
  assert.deepEqual([queries[0]!.start_time, queries[0]!.end_time], [us('2026-10-07T11:45:00Z'), us('2026-10-07T12:00:00Z')], 'the rounded window is what OpenObserve searches');
  clock.now = Date.parse('2026-10-07T12:00:59.900Z');
  assert.equal((await provider.searchCached(search)).cached, true);
  assert.equal(queries.length, 1);
  clock.now = Date.parse('2026-10-07T12:01:00.000Z');
  assert.equal((await provider.searchCached(search)).cached, false, 'the next minute searches again');
  assert.equal(queries.length, 2);
});

test('stream lists and schemas are fetched once per 5 minutes, then again', async () => {
  const { provider, clock, count } = clocked('2026-10-07T12:00:00Z', () => [], [...SCHEMA, 'statuscode', 'path']);
  for (let i = 0; i < 3; i++) await provider.getStreamSchema('org-id', 's');
  await provider.listStreams('org-id');
  await provider.exportAggregates({ organization: 'org-id', stream: 's', from: '1h' });
  await provider.listServices({ organization: 'org-id', stream: 's' });
  assert.deepEqual([count('/streams?type=logs'), count('/schema')], [1, 1]);
  clock.now += 5 * 60_000 - 1;
  await provider.getStreamSchema('org-id', 's');
  assert.deepEqual([count('/streams?type=logs'), count('/schema')], [1, 1], 'still inside 5 minutes');
  clock.now += 1;
  await provider.getStreamSchema('org-id', 's');
  assert.deepEqual([count('/streams?type=logs'), count('/schema')], [2, 2], 'refetched after 5 minutes');
  await assert.rejects(provider.getStreamSchema('org-id', 'other'), /Log stream 'other' is not accessible/);
  assert.equal(count('/streams?type=logs'), 2, 'an unknown stream is checked against the cached list');
});

test('a failed stream list is not cached', async () => {
  const { provider } = setup([org, 'not a list', { list: [{ name: 's' }] }]);
  await assert.rejects(provider.listStreams('org-id'), /Unexpected OpenObserve streams response/);
  assert.deepEqual(await provider.listStreams('org-id'), ['s']);
});
