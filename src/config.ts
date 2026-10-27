import { AsyncLocalStorage } from 'node:async_hooks';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Calculate relative project root portably across environments
const currentDir = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(currentDir, '..');
// The root .env (see .env.example) loads first so it can move the folders below; variables already set win.
loadEnvFile(resolve(PROJECT_ROOT, '.env'));
export const LOGS_DIR = resolve(PROJECT_ROOT, process.env.LOG_DIR || 'logs');
export const CONFIG_DIR = resolve(PROJECT_ROOT, process.env.CONFIG_DIR || 'config');
export const AI_CONTEXT_DIR = resolve(PROJECT_ROOT, process.env.AI_CONTEXT_DIR || 'ai-context');
/** Time zone of ai-context export folder names (log timestamps inside stay UTC). */
export const AI_CONTEXT_TIME_ZONE = process.env.AI_CONTEXT_TIME_ZONE || 'UTC';

/** Each OpenObserve environment has its own account file: config/openobserve.<env>.env */
export const OPENOBSERVE_ENVS = ['dev', 'stg', 'prod'] as const;
export type OpenObserveEnv = (typeof OPENOBSERVE_ENVS)[number];
export const openObserveEnvFile = (env: OpenObserveEnv): string => resolve(CONFIG_DIR, `openobserve.${env}.env`);

/**
 * Creates the account files to fill in, from their examples, when missing: config/openobserve.<env>.env per
 * environment and config/seq.env. Their example values are placeholders (see `real`), not an account.
 */
export function ensureEnvFiles(): void {
  const copies: Array<[string, string]> = [
    ...OPENOBSERVE_ENVS.map((env): [string, string] => ['openobserve.env.example', openObserveEnvFile(env)]),
    ['seq.env.example', resolve(CONFIG_DIR, 'seq.env')],
  ];
  for (const [example, file] of copies) {
    try {
      if (!existsSync(file) && existsSync(resolve(CONFIG_DIR, example))) copyFileSync(resolve(CONFIG_DIR, example), file);
    } catch {
      // A read-only config folder must not stop startup; the provider then reports what is missing.
    }
  }
}

/** Example placeholders (your_..., ...@example.com) count as unset. */
const real = (value: string | undefined): string => (value && !/^your_|@example\.com$/i.test(value) ? value : '');

/**
 * Lightweight stdlib .env parser (avoids external dotenv dependency)
 */
function readEnvFile(envPath: string): Record<string, string> {
  const values: Record<string, string> = {};
  if (!existsSync(envPath)) return values;

  try {
    const content = readFileSync(envPath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      values[key] = val;
    }
  } catch {
    // Ignore read errors silently
  }
  return values;
}

function loadEnvFile(envPath: string): void {
  for (const [key, val] of Object.entries(readEnvFile(envPath))) {
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

type HubAccount = { url?: string; email?: string; token?: string };
type HubConfig = { openobserve?: { default_env?: string } & Partial<Record<OpenObserveEnv, HubAccount>>; seq?: { server_url?: string; api_key?: string } };

/**
 * Accounts sent by a parent MCP (mcp-hub): CENTRAL_CONFIG_PATH names its JSON file with `openobserve` and `seq`
 * sections. They rank below variables already set and above the config/*.env files, which stay the fallback.
 */
function readHubConfig(): HubConfig {
  const path = process.env.CENTRAL_CONFIG_PATH;
  if (!path) return {};
  try {
    return JSON.parse(readFileSync(resolve(PROJECT_ROOT, path), 'utf8')) as HubConfig;
  } catch (error) {
    process.stderr.write(`CENTRAL_CONFIG_PATH ignored, using config/*.env: ${(error as Error).message}\n`);
    return {};
  }
}
const hub = readHubConfig();

/** Where an account comes from: variables set by the client, the hub's file, the config/*.env files, or nowhere. */
export type ConfigSource = 'env' | 'hub' | 'local' | 'unset';

ensureEnvFiles();
// The hub's Seq account, then the one the CLI saves in config/seq.env; SEQ_* variables set by the MCP client win.
const seqFromEnv = Boolean(process.env.SEQ_SERVER_URL || process.env.SEQ_API_KEY);
if (hub.seq?.server_url && process.env.SEQ_SERVER_URL === undefined) process.env.SEQ_SERVER_URL = hub.seq.server_url;
if (hub.seq?.api_key && process.env.SEQ_API_KEY === undefined) process.env.SEQ_API_KEY = hub.seq.api_key;
loadEnvFile(resolve(CONFIG_DIR, 'seq.env'));
export const seqSource: ConfigSource = seqFromEnv ? 'env' : real(hub.seq?.server_url) ? 'hub' : real(process.env.SEQ_SERVER_URL) ? 'local' : 'unset';

/** Accepts a raw token or a pasted Basic credential (base64 "email:password", optionally prefixed "Basic "). */
export function splitBasicCredential(email: string, token: string): { email: string; token: string } {
  const encoded = token.replace(/^(?:authorization:\s*)?basic\s+/i, '');
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  if (separator > 0 && Buffer.from(decoded).toString('base64') === encoded && /^[^\s:@]+@[^\s:@]+\.[^\s:@]+$/.test(decoded.slice(0, separator))) {
    return { email: decoded.slice(0, separator), token: decoded.slice(separator + 1) };
  }
  return { email, token };
}

const parseAccount = (url: string | undefined, email: string | undefined, token: string | undefined) => ({
  url: real(url).replace(/\/+$/, ''),
  ...splitBasicCredential(real(email), real(token)),
});

export const config = {
  seq: {
    serverUrl: real(process.env.SEQ_SERVER_URL).replace(/\/+$/, ''),
    apiKey: real(process.env.SEQ_API_KEY),
  },
  openobserve: {
    /** Selected environment, or undefined when using OPENOBSERVE_* variables directly */
    env: undefined as OpenObserveEnv | undefined,
    ...parseAccount(process.env.OPENOBSERVE_URL, process.env.OPENOBSERVE_EMAIL, process.env.OPENOBSERVE_TOKEN),
  },
};

/** The account for `env` sent by the hub, else saved in config/openobserve.<env>.env, without making it active. */
export function openObserveAccountFor(env: string): { env: OpenObserveEnv; url: string; email: string; token: string } {
  const key = env.toLowerCase() as OpenObserveEnv;
  if (!OPENOBSERVE_ENVS.includes(key)) throw new Error(`Unknown OpenObserve environment '${env}'. Use ${OPENOBSERVE_ENVS.join(', ')}`);
  const fromHub = hub.openobserve?.[key];
  if (real(fromHub?.url)) return { env: key, ...parseAccount(fromHub?.url, fromHub?.email, fromHub?.token) };
  const saved = readEnvFile(openObserveEnvFile(key));
  return { env: key, ...parseAccount(saved.OPENOBSERVE_URL, saved.OPENOBSERVE_EMAIL, saved.OPENOBSERVE_TOKEN) };
}

/** Where the account for `env` comes from: the hub's `openobserve.<env>`, config/openobserve.<env>.env, or nowhere. */
export function openObserveAccountSource(env: string): ConfigSource {
  const { env: key, url } = openObserveAccountFor(env);
  return real(hub.openobserve?.[key]?.url) ? 'hub' : url ? 'local' : 'unset';
}

/** Switches the active OpenObserve account to the one saved for `env`. */
export function useOpenObserveEnv(env: string): void {
  config.openobserve = openObserveAccountFor(env);
}

const callAccount = new AsyncLocalStorage<typeof config.openobserve>();

/** The OpenObserve account of the running tool call (picked with `env`), else the startup account. */
export const openObserveAccount = (): typeof config.openobserve => callAccount.getStore() ?? config.openobserve;

/** Runs `fn` with the account saved for `env` (one MCP call); without `env`, with the startup account. */
export const withOpenObserveEnv = <T>(env: string | undefined, fn: () => T): T => (env ? callAccount.run(openObserveAccountFor(env), fn) : fn());

// MCP mode picks its environment at startup, e.g. "env": { "OPENOBSERVE_ENV": "dev" } in the MCP client config,
// else (without OPENOBSERVE_URL) the hub's `openobserve.default_env`. Without either, DEV is used when it has a URL.
const requestedEnv = (process.env.OPENOBSERVE_ENV || (!config.openobserve.url && hub.openobserve?.default_env) || '').toLowerCase() as OpenObserveEnv;
if (OPENOBSERVE_ENVS.includes(requestedEnv)) useOpenObserveEnv(requestedEnv);
else if (!config.openobserve.url && openObserveAccountFor('dev').url) useOpenObserveEnv('dev');

/** Save CLI account settings without putting credentials in tracked files. */
export function writePrivateEnvFile(file: string, entries: Record<string, string>): void {
  for (const [key, value] of Object.entries(entries)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error('Invalid account setting name');
    if (/[\r\n]/.test(value)) throw new Error('Account values cannot contain a newline');
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Object.entries(entries).map(([key, value]) => `${key}=${value}\n`).join(''), { encoding: 'utf8', mode: 0o600 });
  chmodSync(file, 0o600);
}
