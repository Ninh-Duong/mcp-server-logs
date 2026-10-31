/**
 * Preloaded before every test file (`node --test --import ./dist/tests/env.js`): points logs, config and ai-context at a
 * fresh temp folder per test process and drops provider variables, so tests never read real accounts, call real
 * servers or write into the repo's logs/, config/ or ai-context/. Child processes spawned by a test inherit its folder.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'mcp-logs-test-'));
process.env.LOG_DIR = join(root, 'logs');
process.env.CONFIG_DIR = join(root, 'config');
process.env.AI_CONTEXT_DIR = join(root, 'ai-context');
process.env.AI_CONTEXT_TIME_ZONE = 'UTC'; // a developer's root .env may set another zone
mkdirSync(process.env.CONFIG_DIR, { recursive: true });
for (const key of Object.keys(process.env)) {
  if (/^(OPENOBSERVE|SEQ)_|^(APP_ENV|NODE_ENV|CENTRAL_CONFIG_PATH)$/.test(key)) delete process.env[key];
}
