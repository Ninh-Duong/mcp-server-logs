import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROJECT_ROOT } from '../config.js';
import { listSnapshots } from '../ai-context/index.js';

/** Fake Seq and OpenObserve servers installed in the CLI process: one stream "s" with an error request r1 and an info row. */
const FAKE_SERVERS = `
  const NOW = Date.now();
  const ROWS = [
    { _timestamp: (NOW - 10 * 60000) * 1000, service_name: 'Shop.Api', severity: 'Error', body: 'Order 1 failed', rcid: 'r1' },
    { _timestamp: (NOW - 20 * 60000) * 1000, service_name: 'Shop.Email', severity: 'Information', body: 'Sent 3 mails', rcid: 'r2' },
  ];
  const reply = (body) => new Response(JSON.stringify(body), { status: 200 });
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    if (path.includes('seq.example.test')) return reply([{ Timestamp: new Date(NOW).toISOString(), Level: 'Error', RenderedMessage: 'seq boom' }]);
    if (path.endsWith('/api/organizations')) return reply({ data: [{ name: 'acme', identifier: 'org-id' }] });
    if (path.includes('/schema')) return reply({ schema: ['_timestamp', 'service_name', 'severity', 'body', 'rcid'].map((name) => ({ name, type: 'Utf8' })) });
    if (path.includes('/streams')) return reply({ list: [{ name: 's' }] });
    const sql = JSON.parse(String(init.body)).query.sql;
    if (sql.startsWith('SELECT COUNT')) return reply({ hits: [{ n: ROWS.length }] });
    if (sql.includes('GROUP BY "service_name", "severity"')) return reply({ hits: [{ service: 'Shop.Api', lvl: 'Error', n: 1 }, { service: 'Shop.Email', lvl: 'Information', n: 1 }] });
    return reply({ hits: ROWS.filter((r) => !sql.includes(' IN (') || sql.includes("'" + r.rcid + "'")) });
  };
`;

/**
 * Runs the CLI menu in a child process with a TTY-like stdin. Each step waits for its prompt text, then types its keys.
 * `setup` runs before the menu starts (e.g. FAKE_SERVERS, a saved Seq account).
 */
async function runCli(steps: Array<[string, string]>, setup = '', env: Record<string, string> = {}): Promise<{ code: number | null; output: string; done: number }> {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    Object.defineProperty(process.stdin, 'isTTY', { value: true });
    ${setup}
    const { runCliMenu } = await import('./dist/cli/menu.js');
    await runCliMenu();
  `], { cwd: PROJECT_ROOT, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  let output = '';
  let step = 0;
  let pending = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    output += chunk;
    pending += chunk;
    if (step < steps.length && pending.includes(steps[step]![0])) {
      child.stdin.write(steps[step++]![1]);
      pending = '';
    }
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
  const timeout = setTimeout(() => child.kill(), 15_000);
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
  clearTimeout(timeout);
  return { code, output, done: step };
}

/** A config folder holding a DEV OpenObserve account pointing at the fake server. */
const devConfig = () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-logs-cli-'));
  writeFileSync(join(dir, 'openobserve.dev.env'), 'OPENOBSERVE_URL=https://logs.example.test\nOPENOBSERVE_EMAIL=r@example.test\nOPENOBSERVE_TOKEN=t\n');
  return dir;
};
/** Main menu → Observe → DEV → first organization → first stream → search mode. */
const observe = (mode: string): Array<[string, string]> => [
  ['Choose 1-3:', '2\r'], ['Choose environment', '1\r'], ['Choose Organization number', '1\r'], ['Choose stream number', '1\r'], ['Choose 1-3:', `${mode}\r`],
];
const back: [string, string] = ['Press Enter to return', '\r'];

test('CLI starts by choosing Seq or Observe', async () => {
  const child = spawn(process.execPath, ['dist/index.js', '--cli'], { cwd: PROJECT_ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
  const timeout = setTimeout(() => child.kill(), 15_000);
  child.stdin.write('3\n');
  const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
  clearTimeout(timeout);
  assert.equal(code, 0, output);
  assert.match(output, /1\. Seq/i);
  assert.match(output, /2\. Observe/i);
});

test('secret paste is masked and Observe without a saved env file fails to connect', async () => {
  const { code, output } = await runCli([
    ['Choose 1-3:', '1\r'],
    ['Seq URL:', 'not-a-url\r'],
    ['Seq API key', '\x1b[200~fake-key-for-paste\x1b[201~\r'],
    back,
    ['Choose 1-3:', '2\r'],
    ['Choose environment', '3\r'],
    ['Press Enter to return', '\x1b[A\r'],
    ['Choose 1-3:', '3\r'],
  ], `const { config } = await import('./dist/config.js'); config.seq = { serverUrl: '', apiKey: '' };`);
  assert.equal(code, 0, output);
  assert.match(output, /Invalid URL/); // Reached URL validation with a nonempty key; nothing saved.
  assert.match(output, /\*{3,}/, 'Pasted input must give visible masked feedback');
  assert.doesNotMatch(output, /fake-key|key-for-paste/);
  assert.match(output, /Connect failed: .*openobserve\.prod\.env is missing/);
  assert.doesNotMatch(output, /Use saved|Observe URL:|account token/i, 'Observe must not prompt for an account');
});

test('Seq: saved account search, HTTPS rule, invalid menu choice', async () => {
  const { code, output, done } = await runCli([
    ['Choose 1-3:', '1\r'], ['Use saved Seq account? (Y/n)', '\r'], ['Seq filter', '\r'], ['Maximum results [10]', '\r'], back,
    ['Choose 1-3:', '1\r'], ['Use saved Seq account? (Y/n)', 'n\r'], ['Seq URL', 'http://seq.example.test\r'], ['Seq API key', 'k\r'], back,
    ['Choose 1-3:', '4\r'], ['Choose 1-3:', '3\r'],
  ], `${FAKE_SERVERS} const { config } = await import('./dist/config.js'); config.seq = { serverUrl: 'https://seq.example.test', apiKey: 'k' };`);
  assert.equal(code, 0, output);
  assert.equal(done, 12, output);
  assert.match(output, /Found 1 logs:\n\[.*\] \[Error\] seq boom/);
  assert.match(output, /Seq URL must use HTTPS outside localhost/);
  assert.match(output, /Choose 1, 2, or 3\./);
});

test('Observe: service & level export, SQL preview, RCID export', async () => {
  const before = listSnapshots().length;
  const { code, output, done } = await runCli([
    // 1. Service & level, last hour, all services, all levels, save without flows.
    ...observe('1'), ['Choose 1-7 [2]', '\r'], ['Choose service', '0\r'], ['Choose level(s)', '5\r'], ['Maximum results [all]', '\r'],
    ['Include framework noise', '\r'], ['Save to ai-context?', '\r'], ['Fetch full request flows', 'n\r'], back,
    // 2. SQL with the default statement; preview only.
    ...observe('3'), ['Choose 1-7 [1]', '1\r'], ['Maximum results [all]', '\r'], ['SQL [SELECT * FROM "s"]', '\r'], ['Save to ai-context?', 'n\r'], back,
    // 3. RCID not found, then found.
    ...observe('2'), ['Choose 1-7 [1]', '\r'], ['Maximum results [all]', '\r'], ['RCID:', 'nope\r'], back,
    ...observe('2'), ['Choose 1-7 [1]', '\r'], ['Maximum results [all]', '\r'], ['RCID:', 'r1\r'], back,
    ['Choose 1-3:', '3\r'],
  ], FAKE_SERVERS, { CONFIG_DIR: devConfig() });
  assert.equal(code, 0, output);
  assert.equal(done, 42, output);
  assert.match(output, /Services in s:\n\s+1\. Shop.Api\s+1 logs \(1 Error, 0 Warning\)/);
  assert.match(output, /≈2 rows: 0 framework noise \(counted only\), 2 to download in 1 window\(s\) of 24h/);
  assert.match(output, /Found 2 logs:\n\[.*\] \[Error\] \[Shop.Api\] Order 1 failed/);
  assert.match(output, /Saved 2 logs in one encrypted export folder/);
  assert.match(output, /No log carries this RCID in the range/);
  assert.match(output, /Saved 1 logs, 1 request flows in one encrypted export folder/);
  assert.equal(listSnapshots().length, before + 2);
});

test('Observe: time range input errors', async () => {
  const { code, output, done } = await runCli([
    ...observe('3'), ['Choose 1-7', '9\r'], back,
    ...observe('3'), ['Choose 1-7', '7\r'], ['From (', '2099-01-01 00:00\r'], ['To (blank', '2099-01-02 00:00\r'], back,
    ...observe('3'), ['Choose 1-7', '7\r'], ['From (', 'later\r'], ['To (blank', '\r'], back,
    ...observe('3'), ['Choose 1-7', '6\r'], ['Day (', '1\r'], ['From hour', '25\r'], back,
    ['Choose 1-3:', '3\r'],
  ], FAKE_SERVERS, { CONFIG_DIR: devConfig() });
  assert.equal(code, 0, output);
  assert.equal(done, 35, output);
  assert.match(output, /Invalid time range selection/);
  assert.match(output, /is in the future/);
  assert.match(output, /Invalid time range: use local/);
  assert.match(output, /Invalid day or hour/);
});
