import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

test('npm artifact contains its guarded bin and publishable dependency lock, without source or tests', () => {
  const result = spawnSync('npm pack --dry-run --json --ignore-scripts', { cwd: root, encoding: 'utf8', shell: true });
  assert.equal(result.status, 0, result.stderr);
  const files = JSON.parse(result.stdout)[0].files.map((file: { path: string }) => file.path) as string[];
  assert.ok(files.includes('cli.mjs'));
  assert.ok(files.includes('npm-shrinkwrap.json'));
  assert.ok(files.includes(manifest.bin['mcp-server-logs'].replace(/^\.\//, '')));
  assert.ok(files.includes('dist/index.js'));
  assert.ok(files.includes('config/openobserve.env.example'));
  assert.ok(!files.some((file) => /^(?:src|dist\/tests|node_modules)\//.test(file)));
  const lock = JSON.parse(readFileSync(join(root, 'npm-shrinkwrap.json'), 'utf8'));
  assert.equal(lock.packages[''].engines.node, manifest.engines.node);
  assert.equal(lock.packages[''].bin['mcp-server-logs'], 'cli.mjs');
});

test('npm bin rejects unsupported Node before loading its missing SDK dependency', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-logs-bin-'));
  try {
    const bin = join(dir, manifest.bin['mcp-server-logs']);
    mkdirSync(dirname(bin), { recursive: true });
    copyFileSync(join(root, manifest.bin['mcp-server-logs']), bin);
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    writeFileSync(join(dir, 'old-node.mjs'), "Object.defineProperty(process.versions, 'node', { value: '18.0.0' });");
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(join(dir, 'old-node.mjs')).href, bin, '--preflight'], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Node 18\.0\.0.*Node 22/);
    assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|@modelcontextprotocol/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const damage of ['missing package', 'missing imported file', 'healthy']) test(`source launcher checks ${damage} despite a fresh install marker before server import`, () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-logs-start-'));
  try {
    copyFileSync(join(root, 'start.mjs'), join(dir, 'start.mjs'));
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    const packages: Record<string, { version: string }> = {};
    for (const name of ['@modelcontextprotocol/sdk', 'zod', 'typescript']) {
      const dependency = join(dir, 'node_modules', name);
      mkdirSync(join(dependency, 'server'), { recursive: true });
      packages[`node_modules/${name}`] = { version: '1.0.0' };
      writeFileSync(join(dependency, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', main: './index.js' }));
      writeFileSync(join(dependency, 'index.js'), '');
      writeFileSync(join(dependency, 'server', 'mcp.js'), damage === 'missing imported file' ? "import './missing.js';" : '');
      writeFileSync(join(dependency, 'server', 'stdio.js'), '');
    }
    if (damage === 'missing package') rmSync(join(dir, 'node_modules', 'zod'), { recursive: true });
    writeFileSync(join(dir, 'npm-shrinkwrap.json'), JSON.stringify({ packages }));
    writeFileSync(join(dir, 'node_modules', '.package-lock.json'), '{}');
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(dir, 'node_modules', '.package-lock.json'), future, future);
    writeFileSync(join(dir, 'dist', 'index.js'), `import { existsSync } from 'node:fs'; process.exit(${damage === 'healthy'} || existsSync(new URL('../repaired', import.meta.url)) ? 0 : 42);`);
    // Replacing only npm avoids network and tests the real launcher and server child ordering.
    writeFileSync(join(dir, 'fake-npm.mjs'), `
      import cp from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const realSpawn = cp.spawnSync;
      cp.spawnSync = (command, args, options) => {
        if (command === process.execPath) return realSpawn(command, args, options);
        if (command !== 'npm' || args.join(' ') !== 'ci --include=dev') throw new Error('Unexpected install command');
        writeFileSync(new URL('./repaired', import.meta.url), '');
        return { status: 0 };
      };
      syncBuiltinESMExports();
    `);
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(join(dir, 'fake-npm.mjs')).href, join(dir, 'start.mjs')], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(dir, 'repaired')), damage !== 'healthy');
    assert.equal(result.stdout, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
