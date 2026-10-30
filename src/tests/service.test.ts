import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { config } from '../config.js';
import { defaultLogsService } from '../service.js';
import { logger } from '../utils/logger.js';
import { ORG, json, useFakeAccount } from './helpers.js';

const oldFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = oldFetch; });

/** Seq at seq.example.test and OpenObserve at logs.example.test, each returning two logs a minute apart. */
function bothProviders(openObserveStatus = 200): string[] {
  useFakeAccount();
  config.seq = { serverUrl: 'https://seq.example.test', apiKey: 'k' };
  const hosts: string[] = [];
  globalThis.fetch = async (url) => {
    const { host, pathname } = new URL(String(url));
    hosts.push(host);
    if (host === 'seq.example.test') return json([0, 2].map((m) => ({ Timestamp: `2026-01-01T00:0${m}:00Z`, Level: 'Error', RenderedMessage: `seq ${m}` })));
    if (pathname.endsWith('/organizations')) return json(ORG);
    if (openObserveStatus !== 200) return new Response('down', { status: openObserveStatus });
    return json({ hits: [1, 3].map((m) => ({ _timestamp: Date.parse(`2026-01-01T00:0${m}:00Z`) * 1000, level: 'error', message: `oo ${m}` })) });
  };
  return hosts;
}

const hour1 = (h: number) => ({ from: `2026-01-01T0${h}:00:00Z`, to: `2026-01-01T0${h + 1}:00:00Z` });

test('without provider: only OpenObserve is queried when its account is configured', async () => {
  const hosts = bothProviders();
  const logs = await defaultLogsService.queryLogs({ organization: 'org-id', stream: 's', ...hour1(0), limit: 3 });
  assert.deepEqual(logs.map((l) => l.message), ['oo 3', 'oo 1']);
  assert.deepEqual([...new Set(hosts)], ['logs.example.test:10443'], 'Seq is not called');
  assert.equal(defaultLogsService.resolveProvider().name, 'openobserve');
});

test('without provider: Seq when OpenObserve has no account', async () => {
  const hosts = bothProviders();
  config.openobserve = { env: undefined, url: '', email: '', token: '' };
  const logs = await defaultLogsService.queryLogs({ query: 'x' });
  assert.deepEqual(logs.map((l) => l.message), ['seq 2', 'seq 0']);
  assert.deepEqual([...new Set(hosts)], ['seq.example.test'], 'OpenObserve is not called');
});

test('a failing default provider is an error, not an empty result', async () => {
  bothProviders(500);
  await assert.rejects(defaultLogsService.queryLogs({ organization: 'org-id', stream: 's', ...hour1(2) }), /OpenObserve HTTP 500/);
  await assert.rejects(defaultLogsService.queryLogs({ query: 'x' }), /OpenObserve organization is required/, 'OpenObserve calls need an organization');
});

test('no configured provider and an unknown provider are errors', async () => {
  config.seq = { serverUrl: '', apiKey: '' };
  config.openobserve = { env: undefined, url: '', email: '', token: '' };
  await assert.rejects(defaultLogsService.queryLogs({ query: 'x' }), /No log provider is configured/);
  await assert.rejects(defaultLogsService.queryLogs({ provider: 'loki' }), /Unknown provider 'loki'. Available: seq, openobserve/);
});

test('a single provider gets its level filter applied after the query', async () => {
  bothProviders();
  const logs = await defaultLogsService.queryLogs({ provider: 'openobserve', organization: 'org-id', stream: 's', level: 'Fatal' });
  assert.deepEqual(logs, []);
});

test('lists provider status', () => {
  config.seq = { serverUrl: 'https://seq.example.test', apiKey: '' };
  const [seq] = defaultLogsService.listProviders();
  assert.deepEqual([seq!.configured, seq!.missingVariables], [false, ['SEQ_API_KEY']]);
});

test('never writes the organization identifier to the process log', async () => {
  bothProviders();
  const secret = 'org-id';
  await defaultLogsService.queryLogs({ provider: 'openobserve', organization: secret, stream: 's' });
  const lines = logger.getRecentLogs(50).filter((line) => line.includes('log_query_started'));
  assert.ok(lines.length);
  assert.ok(lines.every((line) => !line.includes(secret)), lines.join('\n'));
});
