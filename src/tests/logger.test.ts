import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, sep } from 'node:path';
import { test } from 'node:test';
import { config, LOGS_DIR } from '../config.js';
import { logger } from '../utils/logger.js';
import { runPreflightChecks } from '../utils/preflight.js';
import { runNode } from './helpers.js';

/** Captures what `fn` writes to stdout and stderr. */
function capture(fn: () => void): { stdout: string; stderr: string } {
  const out = { stdout: '', stderr: '' };
  const write = { stdout: process.stdout.write, stderr: process.stderr.write };
  process.stdout.write = ((chunk: string) => { out.stdout += chunk; return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => { out.stderr += chunk; return true; }) as typeof process.stderr.write;
  try { fn(); } finally { Object.assign(process.stdout, { write: write.stdout }); Object.assign(process.stderr, { write: write.stderr }); }
  return out;
}

test('MCP mode never writes to stdout; every line goes to stderr and the process log', () => {
  const { stdout, stderr } = capture(() => {
    logger.info('unit.info', { a: 1 });
    logger.error('unit.error');
  });
  assert.equal(stdout, '', 'stdout is reserved for JSON-RPC');
  assert.match(stderr, /\[INFO\] unit\.info \| \{"a":1\}\n.*\[ERROR\] unit\.error/s);
  assert.match(logger.getRecentLogs(2).join('\n'), /unit\.info[\s\S]*unit\.error/);
});

test('CLI mode prints only warnings and errors; info stays in the log file', () => {
  logger.setCliMode(true);
  try {
    const { stdout, stderr } = capture(() => {
      logger.info('cli.info');
      logger.warn('cli.warn');
    });
    assert.doesNotMatch(stdout, /cli\.info/);
    assert.match(stdout, /\[WARN\] cli\.warn/);
    assert.equal(stderr, '');
    assert.match(logger.getRecentLogs(2).join('\n'), /cli\.info/);
  } finally {
    logger.setCliMode(false);
  }
});

test('partitions log files by year and month: logs/YYYY/MM/mcp-process-YYYY-MM-DD.log', () => {
  const filePath = logger.getLogFilePath('2026-10-22T10:00:00.000Z');
  assert.ok(filePath.endsWith(['2026', '10', 'mcp-process-2026-10-22.log'].join(sep)));
  assert.ok(existsSync(dirname(filePath)), 'the month folder is created; the file appears with the first line logged that day');
});

test('preflight reports each provider and the logs folder', () => {
  config.seq = { serverUrl: 'https://seq.example.test', apiKey: '' };
  config.openobserve = { env: 'dev', url: 'https://logs.example.test', email: 'r@example.test', token: 't' };
  const result = capture(() => runPreflightChecks(false));
  const { ok, items } = runPreflightChecks(false);
  assert.equal(result.stdout, '');
  assert.equal(ok, true);
  const status = Object.fromEntries(items.map((i) => [i.name, i.status]));
  assert.deepEqual(status, {
    'Node.js Runtime': 'PASS', 'Logs Storage': 'PASS', 'MCP Tools & Schema': 'PASS', 'Seq Provider': 'WARN', 'OpenObserve Provider': 'PASS',
    'OpenObserve DEV': 'WARN', 'OpenObserve STG': 'WARN', 'OpenObserve PROD': 'WARN',
  }, 'one row per env file: none is filled in the test config folder');
  assert.match(items.find((i) => i.name === 'OpenObserve PROD')!.message, /config\/openobserve\.prod\.env/);
  assert.match(items.find((i) => i.name === 'OpenObserve Provider')!.message, /\[DEV\]/);
  assert.match(items.find((i) => i.name === 'Logs Storage')!.message, new RegExp(LOGS_DIR.replace(/[\\.]/g, '\\$&')));

  config.seq = { serverUrl: '', apiKey: '' };
  config.openobserve = { env: undefined, url: '', email: '', token: '' };
  const empty = runPreflightChecks(false).items;
  assert.match(empty.find((i) => i.name === 'Seq Provider')!.message, /Unconfigured/);
  assert.equal(empty.find((i) => i.name === 'OpenObserve Provider')!.status, 'WARN');
});

test('preflight fails when the logs folder is not writable, and --preflight exits 1', async () => {
  const { code, stdout } = await runNode(['dist/index.js', '--preflight'], { LOG_DIR: `${process.execPath}/not-a-folder` });
  assert.equal(code, 1, stdout);
  assert.match(stdout, /\[FAIL\].*Logs Storage/);
  assert.match(stdout, /REQUIRES ATTENTION/);
});
