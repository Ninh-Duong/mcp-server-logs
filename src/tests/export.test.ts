import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { readLhub, snapshotFiles } from '../ai-context/index.js';
import { runExport } from '../export.js';
import { KEY, entry, hour, jsonl, meta, routed, us } from './helpers.js';

const oldFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = oldFetch; });

const windows = [{ from: hour(9), to: hour(10) }, { from: hour(10), to: hour(11) }];

test('fetches every window into one folder and reports progress per window', async () => {
  const base = mkdtempSync(join(tmpdir(), 'ai-context-'));
  const progress: Array<[number, number]> = [];
  const saved: Array<[number, number, number]> = [];
  const result = await runExport({
    meta: meta(9, 11), orgKey: KEY, windows, withFlows: false, baseDir: base,
    fetchWindow: async (window, onProgress) => {
      onProgress(1);
      return { logs: [entry(window.from.replace(':00:00', ':30:00'), 'Error', 'Api', `failed at ${window.from.slice(11, 13)}`)] };
    },
    onProgress: (index, rows) => progress.push([index, rows]),
    onWindow: (index, _window, rows, duplicates) => saved.push([index, rows, duplicates]),
  });
  assert.equal(result.rows, 2);
  assert.deepEqual(progress, [[0, 1], [1, 1]]);
  assert.deepEqual(saved, [[0, 1, 0], [1, 1, 0]]);
  assert.deepEqual(jsonl(readLhub(join(result.dir, 'services/Api/error.lhub'), KEY).text).map((l) => l.message), ['failed at 09', 'failed at 10']);

  // The same range again: everything is a duplicate, unless skipDuplicates is false.
  const again = await runExport({ meta: meta(9, 11), orgKey: KEY, windows, withFlows: false, baseDir: base,
    fetchWindow: async (window) => ({ logs: [entry(window.from.replace(':00:00', ':30:00'), 'Error', 'Api', `failed at ${window.from.slice(11, 13)}`)] }) });
  assert.deepEqual([again.rows, again.duplicates], [0, 2]);
  const kept = await runExport({ meta: meta(9, 11, { service: 'Api' }), orgKey: KEY, windows, withFlows: false, baseDir: base, skipDuplicates: false,
    fetchWindow: async (window) => ({ logs: [entry(window.from.replace(':00:00', ':30:00'), 'Error', 'Api', `failed at ${window.from.slice(11, 13)}`)] }) });
  assert.equal(kept.rows, 2);
});

test('fetches flows of the export\'s failing requests in batches of 50, each around its own errors', async () => {
  const base = mkdtempSync(join(tmpdir(), 'ai-context-'));
  // 120 failing requests, one per minute from 09:00; each flow has its error row plus one earlier step.
  const failing = Array.from({ length: 120 }, (_, i) => entry(new Date(Date.parse(hour(9)) + i * 60_000).toISOString(), 'Error', 'Api', `Order ${i} failed`, { rcid: `r${i}` }));
  const { queries } = routed(['_timestamp', 'service_name', 'severity', 'rcid'], (sql) => {
    const ids = [...sql.matchAll(/'(r\d+)'/g)].map((m) => m[1]!);
    return ids.map((id) => ({ _timestamp: us(failing[Number(id.slice(1))]!.timestamp) - 1000, service_name: 'Gateway', severity: 'Information', rcid: id, body: 'POST /orders' }));
  }, ['shop']);
  const result = await runExport({
    meta: { ...meta(9, 11), organization: 'acme' }, orgKey: 'org-id', windows, withFlows: true, baseDir: base,
    fetchWindow: async (window) => ({ logs: failing.filter((e) => e.timestamp >= window.from && e.timestamp < window.to) }),
  });
  assert.equal(result.flows, 120);
  assert.equal(snapshotFiles(result.dir).filter((f) => f.startsWith('rcid/')).length, 120);
  assert.equal(queries.length, 3, '50 ids per query');
  // Each batch is queried from its oldest error minus 15 minutes.
  const starts = queries.map((q) => q.start_time).sort((a, b) => a - b);
  assert.deepEqual(starts, [0, 50, 100].map((i) => us(failing[i]!.timestamp) - 15 * 60_000_000));
  const flow = jsonl(readLhub(join(result.dir, 'rcid/rcid-r7.lhub'), 'org-id').text);
  assert.deepEqual(flow.map((l) => [l.service, l.level]), [['Gateway', 'Information']]);
});

test('exporting the same range twice gives two folders instead of failing at the end', async () => {
  const base = mkdtempSync(join(tmpdir(), 'ai-context-'));
  const run = () => runExport({ meta: meta(9, 11), orgKey: KEY, windows, withFlows: false, baseDir: base, skipDuplicates: false,
    fetchWindow: async (window) => ({ logs: [entry(window.from, 'Error', 'Api', 'x')] }) });
  const [first, second] = [await run(), await run()];
  assert.notEqual(first.snapshot, second.snapshot);
  assert.match(second.snapshot, /_all-levels-2_2$/);
});
