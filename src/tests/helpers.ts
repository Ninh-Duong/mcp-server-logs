/** Shared test fixtures: fake OpenObserve / Seq servers over globalThis.fetch, log entries, child Node processes. */
import { spawn } from 'node:child_process';
import { config, PROJECT_ROOT } from '../config.js';
import { OpenObserveProvider } from '../providers/openobserve.js';
import { LogEntry } from '../types.js';

export const KEY = 'org-key-123';
export const ORG = { data: [{ name: 'acme', identifier: 'org-id' }] };
export const SCHEMA = ['_timestamp', 'service_name', 'severity', 'instrumentation_library_name', 'endpointname', 'path', 'body', 'rcid', 'telemetry_sdk_version', 'environment'];

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Points the active OpenObserve account at a fake server. */
export function useFakeAccount(): void {
  config.openobserve = { env: undefined, url: 'https://logs.example.test:10443', email: 'reader@example.test', token: 'test-token' };
}

/** Answers OpenObserve calls in order and records them. */
export function setup(responses: unknown[]): { provider: OpenObserveProvider; calls: Array<{ url: string; init?: RequestInit }> } {
  useFakeAccount();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return json(responses[calls.length - 1]);
  };
  return { provider: new OpenObserveProvider(), calls };
}

/** Fake OpenObserve answering organization/stream/schema calls by URL and every _search by its SQL. */
export function routed(schema: string[], answer: (sql: string, query: { start_time: number; end_time: number }) => unknown[], streams = ['s']) {
  useFakeAccount();
  const sqls: string[] = [];
  const queries: Array<{ sql: string; start_time: number; end_time: number; from: number; size: number }> = [];
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    if (path.endsWith('/api/organizations')) return json(ORG);
    if (path.includes('/schema')) return json({ schema: schema.map((name) => ({ name, type: 'Utf8' })) });
    if (path.includes('/streams')) return json({ list: streams.map((name) => ({ name })) });
    const query = JSON.parse(String(init?.body)).query;
    sqls.push(String(query.sql));
    queries.push(query);
    return json({ hits: answer(String(query.sql), query) });
  };
  return { provider: new OpenObserveProvider(), sqls, queries };
}

/** Fake OpenObserve _search over `rows`: time filter (end_time inclusive or not), newest first, from/size paging. */
export function fakeSearch(rows: Array<{ _timestamp: number; message: string }>, inclusiveEnd: boolean) {
  useFakeAccount();
  const queries: Array<{ start_time: number; end_time: number; from: number; size: number }> = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/api/organizations')) return json(ORG);
    const q = JSON.parse(String(init?.body)).query;
    queries.push(q);
    const hits = rows.filter((r) => r._timestamp >= q.start_time && (inclusiveEnd ? r._timestamp <= q.end_time : r._timestamp < q.end_time))
      .sort((a, b) => b._timestamp - a._timestamp).slice(q.from, q.from + q.size);
    return json({ hits });
  };
  return { provider: new OpenObserveProvider(), queries };
}

export const entry = (timestamp: string, level: string, service: string, message: string, metadata: Record<string, unknown> = {}): LogEntry =>
  ({ timestamp, level, service, message, provider: 'openobserve', metadata: { severity: level, ...metadata } });
export const hour = (h: number) => `2026-10-07T${String(h).padStart(2, '0')}:00:00.000Z`;
export const meta = (from: number, to: number, extra: Record<string, unknown> = {}) =>
  ({ provider: 'openobserve', env: 'prod', organization: 'acme', stream: 'shop', from: hour(from), to: hour(to), limit: Infinity, ...extra });
export const jsonl = (text: string) => text.trim().split('\n').map((line) => JSON.parse(line));

/** Microseconds of an ISO time, as OpenObserve stores `_timestamp`. */
export const us = (iso: string) => Date.parse(iso) * 1000;

/** Runs an ES module snippet in a fresh Node process from the project root (module state such as config is re-read). */
export const runModule = (script: string, env: Record<string, string | undefined> = {}) => runNode(['--input-type=module', '-e', script], env);

/** Runs `node <args>` from the project root and collects its output. */
export function runNode(args: string[], env: Record<string, string | undefined> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, args, { cwd: PROJECT_ROOT, env: { ...process.env, ...env } });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill(), 10_000);
  return new Promise((done) => child.on('close', (code) => { clearTimeout(timer); done({ code, stdout, stderr }); }));
}
