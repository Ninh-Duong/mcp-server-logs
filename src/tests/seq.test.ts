import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { config } from '../config.js';
import { defaultLogsService } from '../service.js';

const oldFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = oldFetch; });

function setup(levels: string[]): string[] {
  config.seq.serverUrl = 'https://seq.example.test';
  config.seq.apiKey = 'test-key';
  const urls: string[] = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    const events = levels.map((Level, i) => ({ Timestamp: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), Level, RenderedMessage: Level }));
    return new Response(JSON.stringify(events), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return urls;
}

test('a single level is a minimum severity and is pushed into the Seq filter', async () => {
  const urls = setup(['Information', 'Warning', 'Error', 'Fatal']);
  const logs = await defaultLogsService.queryLogs({ provider: 'seq', query: "App = 'api'", level: 'Warning' });
  assert.deepEqual(logs.map((l) => l.level).sort(), ['Error', 'Fatal', 'Warning']);
  const filter = new URL(urls[0]!).searchParams.get('filter') || '';
  assert.match(filter, /^\(App = 'api'\) and @Level in \[.*'Warning'.*\] ci$/);
  assert.doesNotMatch(filter, /'Information'/);
});

test('an array of levels matches exactly those levels', async () => {
  setup(['Debug', 'Information', 'Error']);
  const logs = await defaultLogsService.queryLogs({ provider: 'seq', level: ['Debug'] });
  assert.deepEqual(logs.map((l) => l.level), ['Debug']);
});

test('rejects an unparseable time bound before calling Seq', async () => {
  const urls = setup([]);
  await assert.rejects(defaultLogsService.queryLogs({ provider: 'seq', from: 'garbage' }), /Invalid time range/);
  assert.equal(urls.length, 0);
});

test('sends the API key header, count and time bounds, and maps Seq events', async () => {
  config.seq.serverUrl = 'https://seq.example.test';
  config.seq.apiKey = 'test-key';
  const requests: Array<{ url: URL; headers: Headers }> = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: new URL(String(url)), headers: new Headers(init?.headers) });
    return new Response(JSON.stringify([
      { Timestamp: '2026-01-01T00:00:00Z', Level: 'Warning', MessageTemplate: 'Order {Id} slow', Properties: [{ Name: 'Id', Value: 7 }, { Name: '', Value: 'dropped' }] },
      { Timestamp: '2026-01-01T00:01:00Z', Level: 'Error', RenderedMessage: 'Order 8 failed', Properties: { Id: 8 } },
    ]), { status: 200 });
  };
  const logs = await defaultLogsService.queryLogs({ provider: 'seq', from: '2026-01-01T00:00:00Z', to: '2026-01-01T01:00:00Z', limit: 1000 });
  const { url, headers } = requests[0]!;
  assert.equal(headers.get('x-seq-apikey'), 'test-key');
  assert.equal(url.pathname, '/api/events');
  assert.equal(url.searchParams.get('count'), '500', 'limit is capped at 500');
  assert.equal(url.searchParams.get('fromDateUtc'), '2026-01-01T00:00:00.000Z');
  assert.equal(url.searchParams.get('toDateUtc'), '2026-01-01T01:00:00.000Z');
  assert.deepEqual(logs.map((l) => [l.level, l.message, l.metadata]), [
    ['Error', 'Order 8 failed', { Id: 8 }], ['Warning', 'Order {Id} slow', { Id: 7 }],
  ], 'newest first; properties as array or object');
});

test('reports Seq HTTP errors, tolerates a non-array body, and needs an account', async () => {
  setup([]);
  globalThis.fetch = async () => new Response('denied', { status: 403 });
  await assert.rejects(defaultLogsService.queryLogs({ provider: 'seq' }), /Seq API returned HTTP 403: denied/);
  globalThis.fetch = async () => new Response(JSON.stringify({ events: [] }), { status: 200 });
  assert.deepEqual(await defaultLogsService.queryLogs({ provider: 'seq' }), []);
  config.seq.apiKey = '';
  await assert.rejects(defaultLogsService.queryLogs({ provider: 'seq' }), /Seq provider is not configured: .*SEQ_API_KEY/);
});

test('rejects a time range that ends before it starts', async () => {
  const urls = setup([]);
  await assert.rejects(defaultLogsService.queryLogs({ provider: 'seq', from: '2026-01-02T00:00:00Z', to: '2026-01-01T00:00:00Z' }), /Invalid time range/);
  assert.equal(urls.length, 0);
});
