// Run through npm run check:package so npm's CLI path works on every supported OS.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(join(tmpdir(), 'mcp logs package '));
const run = (args, cwd, env = process.env) => {
  const result = spawnSync(process.execPath, [process.env.npm_execpath, ...args], { cwd, env, encoding: 'utf8', timeout: 120_000 });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  return result.stdout;
};

try {
  const [packed] = JSON.parse(run(['pack', '--json', '--pack-destination', temp], root));
  const files = packed.files.map(({ path }) => path);
  for (const file of ['cli.mjs', 'npm-shrinkwrap.json', 'dist/index.js', 'config/openobserve.env.example', 'config/seq.env.example']) {
    assert.ok(files.includes(file), `Missing packed file: ${file}`);
  }
  assert.ok(!files.some((file) => /^(?:src|dist\/tests|node_modules|logs|ai-context)\//.test(file) || /(?:^|\/)\.env$|config\/.*\.env$/.test(file)));
  writeFileSync(join(temp, 'package.json'), '{"private":true}');
  run(['install', '--ignore-scripts', '--no-audit', '--no-fund', join(temp, packed.filename)], temp);

  const installed = join(temp, 'node_modules', 'mcp-server-logs');
  const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(installed, 'npm-shrinkwrap.json'), 'utf8'));
  assert.equal(lock.packages[''].engines.node, manifest.engines.node);
  assert.equal(manifest.bin['mcp-server-logs'], './cli.mjs');
  assert.ok(!existsSync(join(installed, 'src')));

  // Empty provider settings and a blocked fetch keep this check local and credential-free.
  const env = { ...process.env, LOG_DIR: join(temp, 'logs'), CONFIG_DIR: join(temp, 'config'), AI_CONTEXT_DIR: join(temp, 'ai-context') };
  for (const key of Object.keys(env)) if (/^(OPENOBSERVE|SEQ)_/.test(key)) delete env[key];
  const blocker = join(temp, 'block-network.mjs');
  writeFileSync(blocker, "globalThis.fetch = () => { throw new Error('Network access forbidden in package QC'); };\n");
  env.NODE_OPTIONS = `--import=${pathToFileURL(blocker).href}`;
  const output = run(['exec', '--offline', '--no', '--', 'mcp-server-logs', '--preflight'], temp, env);
  assert.match(output, /Overall Health Status: .*READY/);
  assert.match(output, /Unconfigured/);
  assert.doesNotMatch(output, /connection verified/i);
  process.stderr.write('Packed tarball install and credential-free preflight passed.\n');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
