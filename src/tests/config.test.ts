import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { CONFIG_DIR, PROJECT_ROOT, ensureEnvFiles, openObserveAccountFor, openObserveEnvFile, splitBasicCredential, writePrivateEnvFile } from '../config.js';
import { runModule } from './helpers.js';

test('writes provider credentials to a private env file without changing values', () => {
  const file = join(tmpdir(), `mcp-logs-${randomUUID()}.env`);
  try {
    writePrivateEnvFile(file, { OPENOBSERVE_EMAIL: 'reader@example.test', OPENOBSERVE_TOKEN: 'abc=def' });
    assert.equal(readFileSync(file, 'utf8'), 'OPENOBSERVE_EMAIL=reader@example.test\nOPENOBSERVE_TOKEN=abc=def\n');
  } finally {
    try { unlinkSync(file); } catch { /* file was not created */ }
  }
});

test('rejects newlines in account values and invalid setting names', () => {
  const file = join(tmpdir(), `mcp-logs-${randomUUID()}.env`);
  assert.throws(() => writePrivateEnvFile(file, { OPENOBSERVE_TOKEN: 'first\nOTHER=leak' }), /newline/);
  assert.throws(() => writePrivateEnvFile(file, { 'bad-name': 'x' }), /Invalid account setting name/);
  assert.equal(existsSync(file), false);
});

test('splits a pasted Basic credential and leaves raw tokens alone', () => {
  const basic = Buffer.from('svc@sa.internal:p4ss:word').toString('base64');
  assert.deepEqual(splitBasicCredential('me@example.test', basic), { email: 'svc@sa.internal', token: 'p4ss:word' });
  assert.deepEqual(splitBasicCredential('me@example.test', `Basic ${basic}`), { email: 'svc@sa.internal', token: 'p4ss:word' });
  assert.deepEqual(splitBasicCredential('me@example.test', `Authorization: Basic ${basic}`), { email: 'svc@sa.internal', token: 'p4ss:word' });
  assert.deepEqual(splitBasicCredential('me@example.test', 'raw-token'), { email: 'me@example.test', token: 'raw-token' });
  const notEmail = Buffer.from('user:secret').toString('base64');
  assert.deepEqual(splitBasicCredential('me@example.test', notEmail), { email: 'me@example.test', token: notEmail }, 'decoded text without an email stays raw');
});

test('creates an OpenObserve account file per environment from the example, and nothing else', () => {
  for (const name of ['openobserve.env.example', 'seq.env.example']) copyFileSync(join(PROJECT_ROOT, 'config', name), join(CONFIG_DIR, name));
  ensureEnvFiles();
  for (const env of ['dev', 'stg', 'prod'] as const) assert.equal(existsSync(openObserveEnvFile(env)), true, env);
  assert.deepEqual(readdirSync(CONFIG_DIR).sort(), ['openobserve.dev.env', 'openobserve.env.example', 'openobserve.prod.env', 'openobserve.stg.env', 'seq.env', 'seq.env.example']);
  // Copied example values are placeholders, not an account.
  assert.deepEqual(openObserveAccountFor('stg'), { env: 'stg', url: 'https://observe.example.com', email: '', token: '' });
});

test('reads an account file: comments, quotes, CRLF, "=" inside values, trailing slash', () => {
  writeFileSync(openObserveEnvFile('prod'), '# PROD account\r\nOPENOBSERVE_URL="https://prod.example.test/"\r\n\r\nOPENOBSERVE_EMAIL=\'reader@example.test\'\r\nOPENOBSERVE_TOKEN=abc=def==\r\nnot a setting\r\n');
  assert.deepEqual(openObserveAccountFor('PROD'), { env: 'prod', url: 'https://prod.example.test', email: 'reader@example.test', token: 'abc=def==' });
  assert.throws(() => openObserveAccountFor('qa'), /Unknown OpenObserve environment 'qa'/);
});

const printAccount = `const { config } = await import('./dist/config.js'); process.stdout.write(JSON.stringify({ openobserve: config.openobserve, seq: config.seq }));`;
const configDir = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-logs-config-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
};
const account = (url: string) => `OPENOBSERVE_URL=${url}\nOPENOBSERVE_EMAIL=r@example.test\nOPENOBSERVE_TOKEN=t\n`;

test('OPENOBSERVE_ENV picks config/openobserve.<env>.env at startup', async () => {
  const dir = configDir({ 'openobserve.dev.env': account('https://dev.example.test'), 'openobserve.stg.env': account('https://stg.example.test') });
  const { stdout } = await runModule(printAccount, { CONFIG_DIR: dir, OPENOBSERVE_ENV: 'stg' });
  assert.deepEqual(JSON.parse(stdout).openobserve, { env: 'stg', url: 'https://stg.example.test', email: 'r@example.test', token: 't' });
});

test('without OPENOBSERVE_ENV the DEV account is used when it has a URL', async () => {
  const dir = configDir({ 'openobserve.dev.env': account('https://dev.example.test') });
  assert.equal(JSON.parse((await runModule(printAccount, { CONFIG_DIR: dir })).stdout).openobserve.env, 'dev');
  const empty = configDir({});
  assert.equal(JSON.parse((await runModule(printAccount, { CONFIG_DIR: empty })).stdout).openobserve.url, '');
});

test('OPENOBSERVE_* variables work without any account file', async () => {
  const dir = configDir({});
  const { stdout } = await runModule(printAccount, { CONFIG_DIR: dir, OPENOBSERVE_URL: 'https://env.example.test//', OPENOBSERVE_EMAIL: 'e@example.test', OPENOBSERVE_TOKEN: 'tok', SEQ_SERVER_URL: 'https://seq.example.test/', SEQ_API_KEY: 'k' });
  const parsed = JSON.parse(stdout);
  assert.deepEqual(parsed.openobserve, { url: 'https://env.example.test', email: 'e@example.test', token: 'tok' });
  assert.deepEqual(parsed.seq, { serverUrl: 'https://seq.example.test', apiKey: 'k' });
});

test('example placeholders count as missing, so the CLI and preflight say what to fill in', async () => {
  const dir = configDir({
    'openobserve.dev.env': 'OPENOBSERVE_URL=https://logs.example.test\nOPENOBSERVE_EMAIL=logging-reader@example.com\nOPENOBSERVE_TOKEN=your_service_account_token\n',
    'seq.env': 'SEQ_SERVER_URL=http://localhost:5341\nSEQ_API_KEY=your_read_only_seq_api_key\n',
  });
  const { stdout } = await runModule(`
    const { config, openObserveAccountFor } = await import('./dist/config.js');
    config.openobserve = openObserveAccountFor('dev');
    const { openObserveProvider, getProvider } = await import('./dist/providers/index.js');
    process.stdout.write(JSON.stringify([openObserveProvider.getStatus().missingVariables, getProvider('seq').getStatus().missingVariables]));`, { CONFIG_DIR: dir });
  assert.deepEqual(JSON.parse(stdout), [['OPENOBSERVE_EMAIL', 'OPENOBSERVE_TOKEN'], ['SEQ_API_KEY']]);
});

const hubFile = (hub: object) => {
  const file = join(mkdtempSync(join(tmpdir(), 'mcp-logs-hub-')), 'mcp-server-logs.json');
  writeFileSync(file, JSON.stringify({ transport: 'stdio', env: {}, ...hub }));
  return file;
};
const printAccounts = `const { config, openObserveAccountFor, openObserveAccountSource: source, seqSource } = await import('./dist/config.js');
  process.stdout.write(JSON.stringify({ openobserve: config.openobserve, seq: config.seq, stg: openObserveAccountFor('stg'), prod: openObserveAccountFor('prod'),
    sources: { dev: source('dev'), stg: source('stg'), prod: source('prod'), seq: seqSource } }));`;

test('CENTRAL_CONFIG_PATH: hub accounts win over config/*.env, which stay the fallback per environment', async () => {
  const dir = configDir({ 'openobserve.stg.env': account('https://local-stg.example.test'), 'openobserve.prod.env': account('https://local-prod.example.test'), 'seq.env': 'SEQ_SERVER_URL=http://local-seq\nSEQ_API_KEY=local\n' });
  const central = hubFile({
    openobserve: { default_env: 'stg', stg: { url: 'https://hub-stg.example.test/', email: 'h@example.test', token: 'ht' }, prod: { url: '', email: '', token: '' } },
    seq: { server_url: 'https://hub-seq.example.test', api_key: 'hk' },
  });
  const parsed = JSON.parse((await runModule(printAccounts, { CONFIG_DIR: dir, CENTRAL_CONFIG_PATH: central })).stdout);
  const hubStg = { env: 'stg', url: 'https://hub-stg.example.test', email: 'h@example.test', token: 'ht' };
  assert.deepEqual(parsed.openobserve, hubStg, 'default_env picks the startup account');
  assert.deepEqual(parsed.stg, hubStg);
  assert.equal(parsed.prod.url, 'https://local-prod.example.test', 'an empty hub account falls back to the file');
  assert.deepEqual(parsed.seq, { serverUrl: 'https://hub-seq.example.test', apiKey: 'hk' });
  assert.deepEqual(parsed.sources, { dev: 'unset', stg: 'hub', prod: 'local', seq: 'hub' }, 'each account reports where it comes from');
});

test('CENTRAL_CONFIG_PATH: variables set by the client still win over the hub', async () => {
  const central = hubFile({ openobserve: { default_env: 'stg', stg: { url: 'https://hub-stg.example.test' } }, seq: { server_url: 'https://hub-seq.example.test', api_key: 'hk' } });
  const { stdout } = await runModule(printAccounts, { CONFIG_DIR: configDir({}), CENTRAL_CONFIG_PATH: central, OPENOBSERVE_URL: 'https://env.example.test', SEQ_SERVER_URL: 'https://env-seq.example.test' });
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.openobserve.url, 'https://env.example.test');
  assert.deepEqual(parsed.seq, { serverUrl: 'https://env-seq.example.test', apiKey: 'hk' });
  assert.equal(parsed.sources.seq, 'env');
});

test('without the hub, accounts come from config/*.env', async () => {
  const dir = configDir({ 'openobserve.dev.env': account('https://dev.example.test'), 'seq.env': 'SEQ_SERVER_URL=http://local-seq\nSEQ_API_KEY=local\n' });
  const parsed = JSON.parse((await runModule(printAccounts, { CONFIG_DIR: dir })).stdout);
  assert.deepEqual(parsed.sources, { dev: 'local', stg: 'unset', prod: 'unset', seq: 'local' });
  assert.equal(JSON.parse((await runModule(printAccounts, { CONFIG_DIR: configDir({}) })).stdout).sources.seq, 'unset');
});

test('CENTRAL_CONFIG_PATH: a missing or broken hub file is reported and the local files are used', async () => {
  const dir = configDir({ 'openobserve.dev.env': account('https://dev.example.test') });
  const broken = hubFile({});
  writeFileSync(broken, '{ not json');
  for (const central of [join(dir, 'missing.json'), broken]) {
    const { stdout, stderr } = await runModule(printAccount, { CONFIG_DIR: dir, CENTRAL_CONFIG_PATH: central });
    assert.equal(JSON.parse(stdout).openobserve.url, 'https://dev.example.test');
    assert.match(stderr, /CENTRAL_CONFIG_PATH ignored/);
  }
});

test('per-environment Seq files no longer override the Seq account', async () => {
  const dir = configDir({ 'openobserve.dev.env': account('https://dev.example.test'), 'seq.dev.env': 'SEQ_SERVER_URL=http://localhost:5341\nSEQ_API_KEY=placeholder\n' });
  const { stdout } = await runModule(printAccount, { CONFIG_DIR: dir, OPENOBSERVE_ENV: 'dev', SEQ_SERVER_URL: 'https://seq.example.test', SEQ_API_KEY: 'real' });
  assert.deepEqual(JSON.parse(stdout).seq, { serverUrl: 'https://seq.example.test', apiKey: 'real' });
});
