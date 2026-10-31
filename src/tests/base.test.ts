import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeLogLevel, parseTimeBound, resolveLevels, searchWindow } from '../providers/base.js';
import { getAllProviders, getProvider, listProviders } from '../providers/index.js';
import { LOG_LEVELS } from '../types.js';

test('levels are ordered from least to most severe', () => {
  assert.deepEqual([...LOG_LEVELS], ['Verbose', 'Debug', 'Information', 'Warning', 'Error', 'Fatal']);
  assert.deepEqual(resolveLevels('Warning'), ['Warning', 'Error', 'Fatal'], 'one level = minimum severity');
  assert.deepEqual(resolveLevels(['Debug', 'Error']), ['Debug', 'Error'], 'an array = exactly those');
  assert.equal(resolveLevels(undefined), undefined);
});

test('normalizes provider level names', () => {
  const cases: Array<[string | undefined, string]> = [
    ['FATAL', 'Fatal'], ['Critical', 'Fatal'], ['emerg', 'Fatal'], ['ERR', 'Error'], ['error', 'Error'],
    ['warning', 'Warning'], ['Debug', 'Debug'], ['trace', 'Verbose'], ['Verbose', 'Verbose'],
    ['info', 'Information'], [undefined, 'Information'], ['  Warn  ', 'Warning'],
  ];
  for (const [raw, level] of cases) assert.equal(normalizeLogLevel(raw), level, String(raw));
});

test('parses relative and absolute time bounds', () => {
  const ago = (input: string) => Date.now() - Date.parse(parseTimeBound(input)!);
  const near = (ms: number, expected: number) => assert.ok(Math.abs(ms - expected) < 5_000, `${ms} ≈ ${expected}`);
  near(ago('15m'), 15 * 60_000);
  near(ago(' 2h '), 2 * 3_600_000);
  near(ago('7d'), 7 * 86_400_000);
  near(ago('1w'), 7 * 86_400_000);
  assert.equal(parseTimeBound('2026-10-07T09:00:00+07:00'), '2026-10-07T02:00:00.000Z');
  assert.equal(parseTimeBound('2026-10-07'), '2026-10-07T00:00:00.000Z', 'a bare date is UTC midnight');
  assert.equal(parseTimeBound('2026-10-07 09:00'), new Date(2026, 9, 7, 9, 0).toISOString(), 'date and time without zone is local time');
  for (const bad of ['garbage', '15x', 'Today', '']) assert.equal(parseTimeBound(bad), undefined, bad);
});

test('finds providers by name, case-insensitively', () => {
  assert.equal(getProvider('SEQ')?.name, 'seq');
  assert.equal(getProvider('nope'), undefined);
  assert.deepEqual(getAllProviders().map((p) => p.name), ['seq', 'openobserve']);
  assert.deepEqual(listProviders().map((s) => [s.name, s.configured]), [['seq', false], ['openobserve', false]]);
});

test('normalizes the short level names of Serilog and others', () => {
  const cases: Array<[string, string]> = [['VRB', 'Verbose'], ['TRC', 'Verbose'], ['DBG', 'Debug'], ['INF', 'Information'], ['WRN', 'Warning'], ['FTL', 'Fatal'], ['CRT', 'Fatal']];
  for (const [raw, level] of cases) assert.equal(normalizeLogLevel(raw), level, raw);
});

test('search windows count relative bounds from the minute start and keep ISO bounds', () => {
  const now = Date.parse('2026-10-07T12:00:30.250Z');
  assert.deepEqual(searchWindow('15m', undefined, '1h', now), { from: '2026-10-07T11:45:00.000Z', to: '2026-10-07T12:00:00.000Z' });
  assert.deepEqual(searchWindow(undefined, '5m', '1h', now), { from: '2026-10-07T11:00:00.000Z', to: '2026-10-07T11:55:00.000Z' });
  assert.deepEqual(searchWindow('2026-10-07T11:00:00.123Z', '2026-10-07T11:30:00Z', '1h', now), { from: '2026-10-07T11:00:00.123Z', to: '2026-10-07T11:30:00.000Z' });
  assert.deepEqual(searchWindow('2026-10-07T12:00:10Z', undefined, '1h', now), { from: '2026-10-07T12:00:10.000Z', to: '2026-10-07T12:00:30.250Z' },
    'an ISO start inside the current minute ends now, not before it starts');
  assert.equal(searchWindow('soon', undefined, '1h', now).from, undefined);
  assert.equal(parseTimeBound('1h', now), '2026-10-07T11:00:30.250Z', 'parseTimeBound takes a clock');
});
