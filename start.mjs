#!/usr/bin/env node
// Launcher: ensures Node version, dependencies, and a fresh build before running dist/index.js.
// Stdlib only (runs before node_modules exists). Never writes to stdout: in MCP mode stdout is JSON-RPC.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const at = (...p) => join(root, ...p);
const mtime = (p) => (existsSync(p) ? statSync(p).mtimeMs : 0);
const fail = (msg) => { process.stderr.write(`[start] ${msg}\n`); process.exit(1); };

const [major] = process.versions.node.split('.').map(Number);
if (major < 22) fail(`Node ${process.versions.node} is too old; install Node 22 or newer.`);

const npm = (...args) => {
  process.stderr.write(`[start] npm ${args.join(' ')}\n`);
  const r = spawnSync('npm', args, { cwd: root, stdio: ['ignore', 2, 2], shell: process.platform === 'win32' });
  if (r.status !== 0) fail(`'npm ${args.join(' ')}' failed. Fix the error above, then run again.`);
};

// Check the locked tree and actual import graph: an interrupted install can leave a fresh marker.
const lock = existsSync(at('npm-shrinkwrap.json')) ? at('npm-shrinkwrap.json') : at('package-lock.json');
const dependenciesReady = () => {
  try {
    const packages = JSON.parse(readFileSync(lock, 'utf8')).packages;
    if (Object.entries(packages).some(([path, pkg]) => path && !pkg.optional && !existsSync(at(path, 'package.json')))) return false;
    return spawnSync(process.execPath, ['--input-type=module', '-e',
      "import '@modelcontextprotocol/sdk/server/mcp.js'; import '@modelcontextprotocol/sdk/server/stdio.js'; import 'zod'; import 'typescript';",
    ], { cwd: root, stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
};

// Reinstall when dependencies are missing, incomplete, or older than the lockfile (e.g. after git pull).
const installed = at('node_modules', '.package-lock.json');
if (!existsSync(installed) || mtime(lock) > mtime(installed) || !dependenciesReady()) {
  npm(existsSync(lock) ? 'ci' : 'install', '--include=dev');
}

// Rebuild when dist is missing or any source file is newer (skipped in packaged installs without src/).
const entry = at('dist', 'index.js');
if (existsSync(at('src'))) {
  const built = mtime(entry);
  const stale = !built || [at('tsconfig.json'), ...readdirSync(at('src'), { recursive: true }).map((f) => at('src', f))]
    .some((f) => mtime(f) > built);
  if (stale) npm('run', 'build');
}
if (!existsSync(entry)) fail('dist/index.js not found; run `npm run build`.');

// A large export holds one fetch window (up to ROWS_PER_WINDOW rows) in memory; Node's default heap (~4 GB) is
// not always enough. Allow half the machine's RAM, at most 8 GB; V8 only uses what it needs.
const heapMb = Math.min(8192, Math.floor(totalmem() / 1048576 / 2));
const child = spawn(process.execPath, [`--max-old-space-size=${heapMb}`, entry, ...process.argv.slice(2)], { stdio: 'inherit' });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
