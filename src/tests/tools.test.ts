import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CONFIG_DIR, config } from '../config.js';
import { registerLogsTools } from '../tools/index.js';
import { logger } from '../utils/logger.js';
import { routed, us } from './helpers.js';

const oldFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = oldFetch; });

const TOOLS = [
  'list_log_providers', 'query_logs', 'list_openobserve_organizations', 'list_openobserve_streams', 'list_openobserve_stream_schema',
  'list_openobserve_services', 'get_openobserve_service_logs', 'export_openobserve_logs', 'list_ai_context_snapshots', 'read_ai_context',
  'find_openobserve_logs_by_rcid', 'search_openobserve_logs',
];

/** A real MCP client connected in memory to a server with the mcp-server-logs tools, so argument validation and defaults apply. */
async function connect(prefix?: string): Promise<Client> {
  const server = new McpServer({ name: 'test', version: '1.0.0' });
  registerLogsTools(server, { prefix });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

/** Calls a tool; returns its text and whether it failed. */
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args }) as { content: Array<{ text: string }>; isError?: boolean };
  return { text: result.content.map((c) => c.text).join('\n'), isError: Boolean(result.isError) };
}
const data = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
  const { text, isError } = await call(client, name, args);
  assert.equal(isError, false, text);
  return JSON.parse(text);
};

const NOW = Date.now();
const recent = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
/** A small stream: one error request (rcid r1) and one information row, inside the last hour. */
const ROWS = [
  { _timestamp: us(recent(10)), service_name: 'Shop.Api', severity: 'Error', body: 'Order 1 failed', rcid: 'r1' },
  { _timestamp: us(recent(20)), service_name: 'Shop.Email', severity: 'Information', body: 'Sent 3 mails', rcid: 'r2' },
];
const SCHEMA = ['_timestamp', 'service_name', 'severity', 'body', 'rcid'];
/** Fake OpenObserve that answers the SQL each tool sends. */
const fakeStream = () => routed(SCHEMA, (sql) => {
  if (sql.startsWith('SELECT COUNT')) return [{ n: ROWS.length }];
  if (sql.includes('GROUP BY "service_name", "severity"')) return [{ service: 'Shop.Api', lvl: 'Error', n: 1 }, { service: 'Shop.Email', lvl: 'Information', n: 1 }];
  if (sql.includes('"rcid" IN (')) return ROWS.filter((r) => sql.includes(`'${r.rcid}'`));
  if (sql.includes('"rcid" = ')) return ROWS.filter((r) => sql.includes(`'${r.rcid}'`));
  return ROWS;
});

test('registers the prompt and every tool, with an optional name prefix', async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOLS].sort());
  assert.ok(tools.every((t) => t.title), 'every tool has a title');
  assert.deepEqual(tools.filter((t) => !t.annotations?.readOnlyHint).map((t) => t.name), ['export_openobserve_logs'], 'only the export writes');
  assert.equal(tools.find((t) => t.name === 'export_openobserve_logs')!.annotations!.destructiveHint, false);
  const prompt = await client.getPrompt({ name: 'investigate_api_bug', arguments: { bug_report: 'API timeout', api_endpoint: 'POST /api/orders' } });
  const text = (prompt.messages[0]!.content as { text: string }).text;
  for (const word of [/schema/i, /log-work/i, /source code/i, /Observed at: not provided/]) assert.match(text, word);

  const prefixed = await connect('logs_');
  assert.ok((await prefixed.listTools()).tools.every((t) => t.name.startsWith('logs_')));
  const prefixedPrompt = await prefixed.getPrompt({ name: 'logs_investigate_api_bug', arguments: { bug_report: 'x', api_endpoint: 'GET /' } });
  assert.match((prefixedPrompt.messages[0]!.content as { text: string }).text, /logs_search_openobserve_logs/);
});

test('analyze_ai_context prompt walks an agent through read_ai_context only', async () => {
  const client = await connect('logs_');
  assert.deepEqual((await client.listPrompts()).prompts.map((p) => p.name).sort(), ['logs_analyze_ai_context', 'logs_investigate_api_bug']);
  const prompt = await client.getPrompt({ name: 'logs_analyze_ai_context', arguments: { question: 'Why do orders fail?', snapshot: 'openobserve/prod/x/s/f' } });
  const text = (prompt.messages[0]!.content as { text: string }).text;
  for (const part of [/Why do orders fail\?/, /openobserve\/prod\/x\/s\/f/, /logs_read_ai_context/, /SUMMARY/, /rcid\//, /never open .*\.lhub/i, /source code/i]) assert.match(text, part);
  const noSnapshot = await client.getPrompt({ name: 'logs_analyze_ai_context', arguments: { question: 'q' } });
  assert.match((noSnapshot.messages[0]!.content as { text: string }).text, /logs_list_ai_context_snapshots/);
});

test('read_ai_context never shows an absolute path', async () => {
  const client = await connect();
  for (const args of [{ snapshot: 'openobserve/prod/nope/s/missing', grep: 'x' }, { snapshot: 'openobserve/prod/nope/s/missing' }, { snapshot: '../../outside', grep: 'x' }]) {
    const result = await call(client, 'read_ai_context', args);
    assert.equal(result.isError, true);
    assert.match(result.text, /Export folder not found inside ai-context\//);
    assert.doesNotMatch(result.text, /[A-Za-z]:[\\/]|\/tmp\/|\/Users\/|\/home\//, result.text);
  }
});

test('list_log_providers and query_logs', async () => {
  const client = await connect();
  assert.equal((await data(client, 'list_log_providers')).count, 2);
  const unknown = await call(client, 'query_logs', { provider: 'loki' });
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /^Log query error: Unknown provider 'loki'/);
  const tooMany = await call(client, 'query_logs', { limit: 501 });
  assert.equal(tooMany.isError, true, 'limit is validated (1-500)');

  fakeStream();
  const result = await data(client, 'query_logs', { provider: 'openobserve', organization: 'org-id', stream: 's', from: '1h' });
  assert.deepEqual([result.total, result.provider, result.query], [2, 'openobserve', '*']);
});

test('OpenObserve discovery and search tools', async () => {
  const client = await connect();
  const { sqls } = fakeStream();
  assert.deepEqual((await data(client, 'list_openobserve_organizations')).organizations, [{ name: 'acme', identifier: 'org-id' }]);
  assert.deepEqual((await data(client, 'list_openobserve_streams', { organization: 'org-id' })).streams, ['s']);
  assert.deepEqual((await data(client, 'list_openobserve_stream_schema', { organization: 'org-id', stream: 's' })).fields.map((f: { name: string }) => f.name), SCHEMA);
  const services = await data(client, 'list_openobserve_services', { organization: 'org-id', stream: 's' });
  assert.deepEqual([services.from, services.field, services.services.map((s: { name: string }) => s.name)], ['1h', 'service_name', ['Shop.Api', 'Shop.Email']]);

  const errors = await data(client, 'get_openobserve_service_logs', { organization: 'org-id', stream: 's', level: 'Warning' });
  assert.deepEqual(errors.logs.map((l: { message: string }) => l.message), ['Order 1 failed'], "one level = that level or more severe");
  assert.match(sqls.at(-1)!, /"severity" IN \('Warning'/);

  const byRcid = await data(client, 'find_openobserve_logs_by_rcid', { organization: 'org-id', stream: 's', rcid: 'r2' });
  assert.deepEqual(byRcid.logs.map((l: { message: string }) => l.message), ['Sent 3 mails']);
  assert.match(sqls.at(-1)!, /WHERE "rcid" = 'r2'/, 'default field rcid');

  const search = await data(client, 'search_openobserve_logs', { organization: 'org-id', sql: 'SELECT * FROM "s"' });
  assert.deepEqual([search.total, search.search.from, search.search.limit], [2, '15m', 50]);
  const bad = await call(client, 'search_openobserve_logs', { organization: 'org-id', sql: 'DROP TABLE s' });
  assert.deepEqual([bad.isError, bad.text], [true, 'Only a single SELECT query is allowed']);
  assert.doesNotMatch(logger.getRecentLogs(5).join('\n'), /Only a single SELECT/, 'tool failures log only the error type');
  assert.equal((await call(client, 'list_openobserve_streams', { organization: 'other-org' })).isError, true);
});

test('export_openobserve_logs writes one folder; list and read it back through the access check', async () => {
  const client = await connect();
  fakeStream();
  const exported = await data(client, 'export_openobserve_logs', { organization: 'org-id', stream: 's', from: '1h' });
  assert.equal(exported.dir, undefined, 'no absolute path in the result');
  assert.deepEqual([exported.totalRows, exported.rows, exported.flows, exported.fetchWindowMinutes], [2, 2, 1, 1440]);
  assert.match(exported.snapshot, /^openobserve\/default\/acme\/s\/\d{8}-\d{4}_\d{8}-\d{4}_all-services_all-levels_2$/);
  assert.match(exported.next, /read_ai_context/);

  const listed = await data(client, 'list_ai_context_snapshots', { stream: 's' });
  assert.deepEqual(listed.snapshots.map((s: { snapshot: string; rows: number }) => [s.snapshot, s.rows]), [[exported.snapshot, 2]]);
  assert.equal((await data(client, 'list_ai_context_snapshots', { env: 'prod' })).total, 0);

  const summary = await call(client, 'read_ai_context', { snapshot: exported.snapshot, limit: 3 });
  assert.match(summary.text, /^1: # Log export: s \/ all services \/ all levels\n2: \n3: /);
  assert.match(summary.text, /continue with offset 4\.$/);
  const errors = await call(client, 'read_ai_context', { snapshot: exported.snapshot, file: 'services/Shop.Api/error.lhub' });
  assert.match(errors.text, /^1: \{.*"message":"Order 1 failed"/);
  const grep = await call(client, 'read_ai_context', { snapshot: exported.snapshot, grep: 'order 1 FAILED' });
  assert.deepEqual(grep.text.split('\n').map((line) => line.split(': ')[0]), ['rcid/rcid-r1.lhub:1', 'services/Shop.Api/error.lhub:1'], 'grep reads every file');
  const inOneFile = await call(client, 'read_ai_context', { snapshot: exported.snapshot, file: 'services/Shop.Api/error.lhub', grep: 'order' });
  assert.match(inOneFile.text, /^services\/Shop.Api\/error\.lhub:1: /);
  assert.equal((await call(client, 'read_ai_context', { snapshot: exported.snapshot, grep: 'nothing like this' })).text, "No match for 'nothing like this'.");

  config.openobserve = { env: undefined, url: '', email: '', token: '' };
  const denied = await call(client, 'read_ai_context', { snapshot: exported.snapshot });
  assert.deepEqual([denied.isError, /No access/.test(denied.text)], [true, true]);
});

test('export_openobserve_logs with rcid saves that one request', async () => {
  const client = await connect();
  fakeStream();
  const exported = await data(client, 'export_openobserve_logs', { organization: 'org-id', stream: 's', from: '1h', rcid: 'r1' });
  assert.match(exported.snapshot, /_rcid-r1_all-levels_1$/);
  const flow = await call(client, 'read_ai_context', { snapshot: exported.snapshot, file: 'rcid/rcid-r1.lhub' });
  assert.match(flow.text, /Order 1 failed/);
  const unknownOrg = await call(client, 'export_openobserve_logs', { organization: 'other-org', stream: 's' });
  assert.match(unknownOrg.text, /not accessible/);
  const badRange = await call(client, 'export_openobserve_logs', { organization: 'org-id', stream: 's', from: 'yesterday-ish' });
  assert.match(badRange.text, /Invalid time range/);
});

test('one server serves every environment: OpenObserve tools take env', async () => {
  writeFileSync(join(CONFIG_DIR, 'openobserve.prod.env'), 'OPENOBSERVE_URL=https://prod.example.test\nOPENOBSERVE_EMAIL=reader@example.test\nOPENOBSERVE_TOKEN=p\n');
  const client = await connect();
  const listed = await data(client, 'list_log_providers');
  const environments = listed.openobserve_environments;
  assert.deepEqual(environments.map((e: { env: string; configured: boolean; source: string }) => [e.env, e.configured, e.source]), [['dev', false, 'unset'], ['stg', false, 'unset'], ['prod', true, 'local']]);
  assert.equal(listed.providers.find((p: { name: string }) => p.name === 'seq').source, 'unset');

  fakeStream();
  const answer = globalThis.fetch;
  const hosts: string[] = [];
  globalThis.fetch = (url, init) => { hosts.push(new URL(String(url)).hostname); return answer(url, init); };
  await data(client, 'list_openobserve_streams', { env: 'prod', organization: 'org-id' });
  assert.deepEqual([...new Set(hosts)], ['prod.example.test'], 'env picks config/openobserve.prod.env for this call');
  hosts.length = 0;
  await data(client, 'list_openobserve_streams', { organization: 'org-id' });
  assert.deepEqual([...new Set(hosts)], ['logs.example.test'], 'without env: the server default account');

  const exported = await data(client, 'export_openobserve_logs', { env: 'prod', organization: 'org-id', stream: 's', from: '1h' });
  assert.match(exported.snapshot, /^openobserve\/prod\/acme\/s\//, 'the export is filed under the env it came from');
  assert.equal((await call(client, 'read_ai_context', { snapshot: exported.snapshot })).isError, false);

  const missing = await call(client, 'list_openobserve_organizations', { env: 'stg' });
  assert.deepEqual([missing.isError, /Missing OPENOBSERVE_URL.*\(STG\)/.test(missing.text)], [true, true], missing.text);
  assert.equal((await call(client, 'query_logs', { provider: 'openobserve', env: 'qa' })).isError, true, 'env is validated');
});
