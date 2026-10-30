import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  appendFrame, cloneLogsToAiContext, cloneRcidToAiContext, createLhub, dropExported, exportDir, findCachedLogs, findCachedQuery,
  findCachedRcid, listSnapshots, normalizeSql, localStamp, messageTemplate, openSnapshot, readLhub,
  readLhubHeader, snapshotFiles, fetchWindowMs, startExport, timeWindows, uncompact,
} from '../ai-context/index.js';
import { compact } from '../ai-context/model.js';
import { KEY, entry, hour, jsonl, meta } from './helpers.js';

const read = (dir: string, file: string) => readLhub(join(dir, file), KEY).text;

test('groups messages that differ only by ids, numbers and timestamps', () => {
  assert.equal(messageTemplate("The 'bool' property 'SiteActive' on entity type 'EntityStagingCDS'"), "The '<s>' property '<s>' on entity type '<s>'");
  assert.equal(messageTemplate('Order 123 failed for 3439df6a-64db-4aa6-97db-2e151e565ee2 at 2026-10-07T09:00:01Z'), 'Order <n> failed for <uuid> at <ts>');
  assert.equal(messageTemplate('[NestWinston] 1      10/7/2026, 7:00:00 PM WARN [Guard] token deadbeef12 bad\nstack line'), '[NestWinston] <n> <ts> WARN [Guard] token <hex> bad');
});

test('a .lhub file takes appended encrypted frames; only the organization key reads them back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lhub-'));
  const path = join(dir, 'x.lhub');
  const file = createLhub(path, { kind: 'logs', provider: 'openobserve', env: 'prod', organization: 'acme', stream: 's', from: hour(9), to: hour(11) }, KEY);
  const lines = (from: number) => Array.from({ length: 2000 }, (_, i) => `{"message":"Request ${from + i} handled for customer 42"}`).join('\n') + '\n';
  appendFrame(file, lines(0), Date.parse(hour(9)), Date.parse(hour(10)));
  appendFrame(file, lines(2000), Date.parse(hour(10)), Date.parse(hour(11)));

  const all = readLhub(path, KEY).text;
  assert.equal(all.trim().split('\n').length, 4000, 'both frames, in order');
  assert.ok(all.indexOf('Request 1999 ') < all.indexOf('Request 2000 '));
  const raw = readFileSync(path);
  assert.ok(raw.length * 10 < Buffer.byteLength(all), `at least 10x smaller (${raw.length} vs ${Buffer.byteLength(all)} bytes)`);
  assert.ok(!raw.includes('Request 1 handled') && !raw.includes(KEY), 'no log text or key in the file');
  assert.equal(readLhubHeader(path).organization, 'acme');

  const later = readLhub(path, KEY, { from: Date.parse('2026-10-07T10:30:00Z'), to: Date.parse(hour(11)) }).text;
  assert.equal(later.trim().split('\n').length, 2000, 'frames outside the range are skipped');

  assert.throws(() => readLhub(path, 'another-org-identifier'), /Cannot decrypt snapshot/);
  const tampered = Buffer.from(raw);
  tampered[tampered.length - 20]! ^= 1;
  writeFileSync(join(dir, 'y.lhub'), tampered);
  assert.throws(() => readLhub(join(dir, 'y.lhub'), KEY), /Cannot decrypt snapshot/, 'modified files are rejected');
});

test('one export folder: services/<service>/<level>.lhub across windows, one SUMMARY, renamed with its row count', () => {
  const base = mkdtempSync(join(tmpdir(), 'ai-context-'));
  const out = startExport(meta(9, 12), { orgKey: KEY, baseDir: base });
  assert.ok(out.dir.endsWith('_partial'), 'unfinished exports are marked');
  out.addWindow([entry('2026-10-07T09:10:00Z', 'Error', 'Shop.Api', 'Order 1 failed', { rcid: 'r1', empty: '', tenant: 't1' }), entry('2026-10-07T09:20:00Z', 'Information', 'Shop.Email', 'Sent 3')], { from: hour(9), to: hour(10) });
  out.addWindow([], { from: hour(10), to: hour(11) });
  out.addWindow([entry('2026-10-07T11:30:00Z', 'Error', 'Shop.Api', 'Order 2 failed', { rcid: 'r2' })], { from: hour(11), to: hour(12) }, undefined, 4);
  const result = out.finish();

  // Folder names use AI_CONTEXT_TIME_ZONE, UTC in tests (src/tests/env.ts).
  assert.match(result.snapshot, /^openobserve\/prod\/acme\/shop\/20261007-0900_20261007-1200_all-services_all-levels_3$/);
  assert.ok(!existsSync(out.dir) && existsSync(result.dir));
  assert.deepEqual(snapshotFiles(result.dir), ['SUMMARY.lhub', 'manifest.lhub', 'patterns.lhub', 'services/Shop.Api/error.lhub', 'services/Shop.Email/information.lhub']);
  const errors = jsonl(read(result.dir, 'services/Shop.Api/error.lhub'));
  assert.deepEqual(errors.map((e) => e.message), ['Order 1 failed', 'Order 2 failed'], 'both windows, oldest first');
  assert.deepEqual(errors[0].attrs, { tenant: 't1' }, 'empty fields dropped');
  assert.deepEqual(errors[0].ids, { rcid: 'r1' });

  const patterns = JSON.parse(read(result.dir, 'patterns.lhub'));
  assert.deepEqual(patterns.map((p: { level: string; count: number; example: string }) => [p.level, p.count, p.example]), [
    ['Error', 2, 'services/Shop.Api/error.lhub:1'], ['Information', 1, 'services/Shop.Email/information.lhub:1'],
  ]);
  const summary = read(result.dir, 'SUMMARY.lhub');
  assert.match(summary, /\| Shop.Api \| 2 \| 0 \| 2 \|/);
  assert.match(summary, /\| Duplicates skipped \| 4 /);
  assert.match(summary, /09:00|20261007-0900/);
  assert.equal(readLhubHeader(join(result.dir, 'SUMMARY.lhub')).rows, 3);
  assert.match(readFileSync(join(base, 'INDEX.md'), 'utf8'), /3 rows · 4 dup → `openobserve\/prod\/acme\/shop\/20261007-0900_/);
});

test('request flows go to rcid/, one file each, and the SUMMARY groups them by bug', () => {
  const base = mkdtempSync(join(tmpdir(), 'ai-context-'));
  const out = startExport(meta(9, 10), { orgKey: KEY, baseDir: base });
  const failing = entry('2026-10-07T09:00:02Z', 'Error', 'Shop.Gateway', 'Request failed', { rcid: 'r1' });
  out.addWindow([failing], { from: hour(9), to: hour(10) });
  assert.deepEqual(out.flowIds().map(({ field, value }) => [field, value]), [['rcid', 'r1']]);
  const ts = (i: number) => new Date(Date.UTC(2026, 9, 7, 9) + i * 1000).toISOString();
  out.addFlows([
    { field: 'rcid', value: 'r1', entries: [failing, entry('2026-10-07T09:00:00Z', 'Information', 'Shop.Gateway', 'POST /customers', { rcid: 'r1' }), entry('2026-10-07T09:00:01Z', 'Error', 'Shop.Customer.Api', 'Save failed for 42', { rcid: 'r1' })] },
    { field: 'rcid', value: 'run', entries: Array.from({ length: 1000 }, (_, i) => entry(ts(i), i === 700 ? 'Error' : 'Information', 'Job', `step ${i}`, { rcid: 'run' })) },
  ]);
  const { dir } = out.finish();
  assert.deepEqual(jsonl(read(dir, 'rcid/rcid-r1.lhub')).map((l) => l.service), ['Shop.Gateway', 'Shop.Customer.Api', 'Shop.Gateway'], 'oldest first across services');
  const long = jsonl(read(dir, 'rcid/rcid-run.lhub'));
  assert.equal(long.length, 500);
  assert.equal(long[400].message, 'step 700', 'first error keeps 400 lines of lead-up');
  const summary = read(dir, 'SUMMARY.lhub');
  // Bug #1 is the gateway error the export found; the flow shows the real break happened upstream in Customer.Api.
  assert.match(summary, /\| 1 \| 1 \| Shop.Gateway \| `Request failed` \| 1 \| Shop.Customer\.Api: Save failed for <n> \| rcid\/rcid-r1\.lhub \|/);
  assert.equal(JSON.parse(read(dir, 'manifest.lhub')).flows[0].pattern, 1);
});

test('an rcid-only export is named and counted by its flow rows', () => {
  const base = mkdtempSync(join(tmpdir(), 'ai-context-'));
  const out = startExport(meta(9, 10, { service: 'rcid-r9' }), { orgKey: KEY, baseDir: base });
  out.addFlows([{ field: 'rcid', value: 'r9', entries: [entry('2026-10-07T09:00:00Z', 'Error', 'Api', 'boom', { rcid: 'r9' }), entry('2026-10-07T09:00:01Z', 'Information', 'Api', 'end', { rcid: 'r9' })] }]);
  const result = out.finish();
  assert.match(result.snapshot, /_rcid-r9_all-levels_2$/);
  assert.deepEqual(snapshotFiles(result.dir), ['SUMMARY.lhub', 'manifest.lhub', 'patterns.lhub', 'rcid/rcid-r9.lhub']);
});

test('picks every distinct error correlation id, rcid before trace_id, one flow per id value', () => {
  const logs = [
    ...[1, 2, 3, 4].map((i) => entry(`2026-10-07T09:0${i}:00Z`, 'Error', 'Api', `Order ${i} failed`, { rcid: `r${i}`, trace_id: `t${i}` })),
    entry('2026-10-07T09:05:00Z', 'Error', 'Api', 'Timeout calling DMS', { trace_id: 'tx' }),
    entry('2026-10-07T09:06:00Z', 'Error', 'Api', 'No id here'),
    entry('2026-10-07T09:08:00Z', 'Error', 'Worker', 'Same request, other sink', { trace_id: 'r4' }),
    entry('2026-10-07T09:07:00Z', 'Information', 'Api', 'ok', { rcid: 'info-only' }),
  ];
  const out = startExport(meta(9, 10), { orgKey: KEY, baseDir: mkdtempSync(join(tmpdir(), 'ai-context-')) });
  out.addWindow(logs, { from: hour(9), to: hour(10) });
  assert.deepEqual(out.flowIds().map(({ field, value }) => ({ field, value })), [
    { field: 'rcid', value: 'r4' }, { field: 'rcid', value: 'r3' }, { field: 'rcid', value: 'r2' }, { field: 'rcid', value: 'r1' },
    { field: 'trace_id', value: 'tx' },
  ], 'trace_id r4 is the same request as rcid r4');
  assert.equal(out.flowIds(3).length, 3, 'the total cap applies');
});

test('drops logs already saved by an overlapping export of the same stream', () => {
  const base = mkdtempSync(join(tmpdir(), 'ai-context-'));
  const logs = (hours: number[]) => hours.map((h) => entry(hour(h), 'Error', 'Api', `Order ${h} failed`, { rcid: `r${h}` }));
  const first = startExport(meta(14, 18), { orgKey: KEY, baseDir: base });
  first.addWindow(logs([14, 15]), { from: hour(14), to: hour(16) });
  first.addWindow(logs([16, 17]), { from: hour(16), to: hour(18) });
  first.finish();

  const overlap = dropExported(logs([16, 17, 18, 19]), meta(16, 20, { service: 'Api' }), KEY, { from: hour(16), to: hour(20) }, base);
  assert.equal(overlap.duplicates, 2, 'any service/level of the stream counts');
  assert.deepEqual(overlap.fresh.map((e) => e.timestamp), [hour(18), hour(19)]);
  assert.equal(overlap.seenIn.length, 1);
  assert.equal(dropExported(logs([20, 21]), meta(20, 22), KEY, { from: hour(20), to: hour(22) }, base).duplicates, 0, 'frames outside the window are not read');
  assert.equal(dropExported(logs([16, 17]), meta(16, 18), 'wrong-key', { from: hour(16), to: hour(18) }, base).duplicates, 0, 'exports it cannot decrypt are skipped');
});

test('opens one file of an export only through the access check and only inside ai-context', async () => {
  const base = mkdtempSync(join(tmpdir(), 'ai-context-'));
  const out = startExport(meta(9, 10), { orgKey: KEY, baseDir: base });
  out.addWindow([entry('2026-10-07T09:00:00Z', 'Error', 'Api', 'boom')], { from: hour(9), to: hour(10) });
  const { snapshot } = out.finish();

  const asked: string[] = [];
  const keyFor = async (h: { env?: string; organization: string }) => { asked.push(`${h.env}/${h.organization}`); return KEY; };
  assert.match((await openSnapshot(snapshot, undefined, keyFor, base)).text, /boom/, 'SUMMARY by default');
  assert.match((await openSnapshot(snapshot, 'SUMMARY', keyFor, base)).file, /^SUMMARY\.lhub$/, 'the extension is optional');
  assert.match((await openSnapshot(snapshot, 'services/Api/error', keyFor, base)).text, /"message":"boom"/);
  assert.deepEqual([...new Set(asked)], ['prod/acme']);
  await assert.rejects(openSnapshot(snapshot, undefined, async () => { throw new Error('No access: not enabled'); }, base), /No access/, 'a cached file still checks access');
  await assert.rejects(openSnapshot('../outside', undefined, keyFor, base), /not found inside ai-context/);
  await assert.rejects(openSnapshot(snapshot, '../../../../../../x', keyFor, base), /inside the export folder/);
  await assert.rejects(openSnapshot(snapshot, 'services/Nope/error.lhub', keyFor, base), /No file .* Files: SUMMARY\.lhub/);

  const [listed] = listSnapshots(base);
  assert.equal(listed!.snapshot, snapshot);
  assert.equal(listed!.header?.rows, 1);
  assert.equal(listed!.partial, false);
  assert.equal(listed!.files, 4);
});

test('the decrypted file kept for paging is released after 5 idle minutes', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'ai-context-'));
  const make = (message: string, from: number) => {
    const out = startExport(meta(from, from + 1), { orgKey: KEY, baseDir: base });
    out.addWindow([entry(hour(from), 'Error', 'Api', message)], { from: hour(from), to: hour(from + 1) });
    return out.finish();
  };
  const first = make('first', 9);
  const second = make('second', 11);
  const keyFor = async () => KEY;
  // Whole seconds, so the mtime can be restored exactly after the content changes.
  const path = join(first.dir, 'services/Api/error.lhub');
  utimesSync(path, 1_790_000_000, 1_790_000_000);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  assert.match((await openSnapshot(first.snapshot, 'services/Api/error', keyFor, base)).text, /first/);
  // Same path and mtime, new content: the cached text is still served until it is released.
  copyFileSync(join(second.dir, 'services/Api/error.lhub'), path);
  utimesSync(path, 1_790_000_000, 1_790_000_000);
  assert.match((await openSnapshot(first.snapshot, 'services/Api/error', keyFor, base)).text, /first/);
  t.mock.timers.tick(5 * 60_000);
  assert.match((await openSnapshot(first.snapshot, 'services/Api/error', keyFor, base)).text, /second/);
});

test('SUMMARY says what was downloaded and what framework noise was only counted', () => {
  const base = mkdtempSync(join(tmpdir(), 'ai-context-'));
  const window = (h: number, n: number, avgMs: number) => ({
    noise: [{ service: 'api', level: 'Information', category: 'Microsoft.AspNetCore.Hosting.Diagnostics', hour: hour(h).slice(0, 13) + ':00:00Z', n }],
    templates: [{ category: 'Microsoft.AspNetCore.Hosting.Diagnostics', template: 'Request starting {Path}', n, firstSeen: hour(h), lastSeen: hour(h) }],
    http: [{ path: '/orders', method: 'POST', status: '500', n: 2, avgMs, maxMs: avgMs * 2 }],
  });
  const out = startExport(meta(4, 6), { orgKey: KEY, baseDir: base });
  out.addWindow([entry('2026-10-07T04:30:00Z', 'Error', 'api', 'boom')], { from: hour(4), to: hour(5) }, window(4, 7, 100));
  out.addWindow([], { from: hour(5), to: hour(6) }, window(5, 5, 200));
  const { dir } = out.finish();
  const summary = read(dir, 'SUMMARY.lhub');
  assert.match(summary, /## What this export contains/);
  assert.match(summary, /Counted, not downloaded\*\*: 12 framework noise rows/);
  assert.match(summary, /\| Microsoft\.AspNetCore\.Hosting\.Diagnostics \| Information \| 12 \| 1 \|/, 'windows summed');
  assert.match(summary, /\| 12 \| Microsoft\.AspNetCore\.Hosting\.Diagnostics \| `Request starting \{Path\}` \| 2026-10-07T04:00:00\.000Z \| 2026-10-07T05:00:00\.000Z \|/);
  assert.match(summary, /\| \/orders \| POST \| 500 \| 4 \| 150 \| 400 \|/, 'HTTP counts merged with a weighted average');
  assert.match(readFileSync(join(base, 'INDEX.md'), 'utf8'), /1 rows · 12 noise counted/);

  const all = startExport(meta(4, 5, { includeNoise: true }), { orgKey: KEY, baseDir: base });
  all.addWindow([], { from: hour(4), to: hour(5) }, { noise: [], templates: [], http: [] });
  const text = read(all.finish().dir, 'SUMMARY.lhub');
  assert.match(text, /framework noise included \(`include_noise`\)/);
  assert.doesNotMatch(text, /Counted, not downloaded/);
});

test('names folders in AI_CONTEXT_TIME_ZONE and sizes fetch windows by the expected row count', () => {
  assert.equal(localStamp('2026-10-15T02:35:55.837Z'), '20261015-0235');
  assert.equal(localStamp('2026-10-15T20:00:00Z', 'Asia/Tokyo'), '20261016-0500', 'another zone crosses midnight');
  assert.deepEqual(timeWindows('2026-10-01T00:00:00.000Z', '2026-10-04T12:00:00.000Z').map((w) => [w.from.slice(0, 13), w.to.slice(0, 13)]), [
    ['2026-10-01T00', '2026-10-02T00'], ['2026-10-02T00', '2026-10-03T00'], ['2026-10-03T00', '2026-10-04T00'], ['2026-10-04T00', '2026-10-04T12'],
  ]);
  assert.equal(timeWindows('2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z', 60 * 60_000).length, 24);
  const day = ['2026-10-15T02:00:00.000Z', '2026-10-16T02:00:00.000Z'] as const;
  const hours = (ms: number) => ms / (60 * 60_000);
  assert.equal(hours(fetchWindowMs(50_000, ...day)), 24, 'a quiet day is one window');
  assert.equal(hours(fetchWindowMs(1_000_000, ...day)), 6, '250k rows per 6h');
  assert.equal(hours(fetchWindowMs(4_000_000, ...day)), 1);
  assert.equal(hours(fetchWindowMs(9_400_000, ...day)), 0.25, '~390k rows per hour is over 250k');
});

test('an unfinished export stays visible as _partial', () => {
  const base = mkdtempSync(join(tmpdir(), 'ai-context-'));
  const out = startExport(meta(9, 10), { orgKey: KEY, baseDir: base });
  out.addWindow([entry('2026-10-07T09:00:00Z', 'Error', 'Api', 'boom')], { from: hour(9), to: hour(10) });
  const [listed] = listSnapshots(base);
  assert.equal(listed!.partial, true);
  assert.equal(listed!.header, undefined, 'no SUMMARY yet');
  assert.ok(statSync(out.dir).isDirectory());
  assert.deepEqual(readdirSync(join(out.dir, 'services')), ['Api']);
});

test('INDEX.md drops lines of export folders that were deleted', () => {
  const base = mkdtempSync(join(tmpdir(), 'ai-context-'));
  const make = (from: number) => {
    const out = startExport(meta(from, from + 1), { orgKey: KEY, baseDir: base });
    out.addWindow([entry(hour(from), 'Error', 'Api', 'boom')], { from: hour(from), to: hour(from + 1) });
    return out.finish();
  };
  const old = make(1);
  rmSync(old.dir, { recursive: true });
  const kept = make(2);
  make(3);
  const index = readFileSync(join(base, 'INDEX.md'), 'utf8');
  assert.equal((index.match(/^- /gm) ?? []).length, 2);
  assert.ok(!index.includes(old.snapshot) && index.includes(kept.snapshot));
});

test('uncompact reconstructs a LogEntry from a compact JSONL record', () => {
  const original = entry('2026-10-07T09:10:00Z', 'Error', 'Shop.Api', 'Order failed', { rcid: 'r1', tenant: 't1' });
  const compacted = compact(original);
  const reconstructed = uncompact(compacted);
  assert.equal(reconstructed.timestamp, original.timestamp);
  assert.equal(reconstructed.level, original.level);
  assert.equal(reconstructed.service, original.service);
  assert.equal(reconstructed.message, original.message);
  assert.equal(reconstructed.metadata?.rcid, 'r1');
  assert.equal(reconstructed.metadata?.tenant, 't1');
});

test('findCachedRcid, findCachedLogs, cloneLogsToAiContext, and cloneRcidToAiContext', () => {
  const base = mkdtempSync(join(tmpdir(), 'ai-context-cache-'));
  const entries = [
    entry('2026-10-07T09:10:00Z', 'Error', 'Shop.Api', 'Order failed', { rcid: 'rcid-999', tenant: 't1' }),
    entry('2026-10-07T09:20:00Z', 'Information', 'Shop.Api', 'Order retry', { rcid: 'rcid-999' }),
  ];

  // Test cloneLogsToAiContext
  const snap = cloneLogsToAiContext(meta(9, 10), KEY, entries, base);
  assert.ok(snap);

  // Test findCachedLogs - cache hit
  const hit = findCachedLogs({ stream: 'shop', service: 'Shop.Api', from: hour(9), to: hour(10) }, KEY, base);
  assert.ok(hit);
  assert.equal(hit.length, 2);
  assert.equal(hit[0]?.message, 'Order retry'); // newest first

  // Test findCachedLogs - level filter
  const errorOnly = findCachedLogs({ stream: 'shop', service: 'Shop.Api', levels: ['Error'], from: hour(9), to: hour(10) }, KEY, base);
  assert.ok(errorOnly);
  assert.equal(errorOnly.length, 1);
  assert.equal(errorOnly[0]?.level, 'Error');

  // Test findCachedLogs - cache miss (time outside snapshot)
  const miss = findCachedLogs({ stream: 'shop', from: hour(7), to: hour(8) }, KEY, base);
  assert.equal(miss, undefined);

  // Test cloneRcidToAiContext and findCachedRcid
  const rcidSnap = cloneRcidToAiContext(meta(9, 10), KEY, 'rcid-999', 'rcid', entries, base);
  assert.ok(rcidSnap);

  const rcidHit = findCachedRcid('shop', 'rcid-999', KEY, base);
  assert.ok(rcidHit);
  assert.equal(rcidHit.length, 2);

  const rcidMiss = findCachedRcid('shop', 'non-existent-rcid', KEY, base);
  assert.equal(rcidMiss, undefined);
});

test('findCachedQuery: same normalized SQL, env and window under the organization key; others and broken copies miss', () => {
  const base = mkdtempSync(join(tmpdir(), 'ai-context-query-'));
  const rows = [entry('2026-10-07T09:30:00Z', 'Error', 'Shop.Api', 'b'), entry('2026-10-07T09:10:00Z', 'Information', 'Shop.Api', 'a')];
  const snap = cloneLogsToAiContext(meta(9, 10, { sql: 'SELECT * FROM "shop"\n  WHERE x', limit: 5 }), KEY, rows, base)!;
  const search = { env: 'prod', sql: 'SELECT * FROM "shop" WHERE x', from: hour(9), to: hour(10) };
  assert.deepEqual(findCachedQuery(search, 5, KEY, base)?.map((l) => l.message), ['b', 'a'], 'result order, not time order');
  assert.deepEqual(findCachedQuery(search, 1, KEY, base)?.map((l) => l.message), ['b']);
  assert.equal(findCachedQuery(search, 500, KEY, base)?.length, 2, '2 rows < limit 5: the cache held every row');
  assert.equal(findCachedQuery(search, 5, 'other-org-key', base), undefined, 'another organization');
  assert.equal(findCachedQuery({ ...search, env: 'dev' }, 5, KEY, base), undefined);
  assert.equal(findCachedQuery({ ...search, to: hour(11) }, 5, KEY, base), undefined);

  const header = JSON.stringify(readLhubHeader(join(exportDir(snap, base), 'SUMMARY.lhub')));
  assert.match(header, /"query":"[0-9a-f]{32}","limit":5/);
  assert.doesNotMatch(header, /SELECT|org-key/, 'the plaintext header shows neither the SQL nor the identifier');
  rmSync(join(exportDir(snap, base), 'query.lhub'));
  assert.equal(findCachedQuery(search, 5, KEY, base), undefined, 'a copy without query.lhub misses');
  assert.equal(normalizeSql('  SELECT  "a  b"\n FROM t WHERE c = \'x  y\'  '), 'SELECT "a  b" FROM t WHERE c = \'x  y\'', 'quoted text keeps its spaces');
});
