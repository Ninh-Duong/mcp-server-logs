/** Shared pieces of the MCP tools: results, error handling, argument schemas and annotations. */
import { z } from 'zod';
import { OPENOBSERVE_ENVS, withOpenObserveEnv } from '../config.js';
import { LOG_LEVELS } from '../types.js';
import { logger } from '../utils/logger.js';

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export const text = (body: string): ToolResult => ({ content: [{ type: 'text', text: body }] });
export const json = (data: unknown): ToolResult => text(JSON.stringify(data));

/**
 * Runs a tool body. A thrown error becomes an `isError` result with its message (after `prefix`); the process log
 * keeps only the error type, never the message (it may quote log data or SQL).
 */
export async function run(tool: string, body: () => Promise<ToolResult>, prefix = ''): Promise<ToolResult> {
  try {
    return await body();
  } catch (err) {
    logger.error('mcp.tool_failed', { tool, errorType: err instanceof Error ? err.name : 'UnknownError' });
    return { isError: true, content: [{ type: 'text', text: `${prefix}${(err as Error).message}` }] };
  }
}

/** `run` with the OpenObserve account of `env` for this one call; without `env`, the server's default account. */
export const runIn = (tool: string, env: string | undefined, body: () => Promise<ToolResult>, prefix = ''): Promise<ToolResult> =>
  run(tool, () => withOpenObserveEnv(env, body), prefix);

/** Reads only: no side effects. Tools that call OpenObserve or Seq also talk to an outside system. */
export const READ_REMOTE = { readOnlyHint: true, openWorldHint: true } as const;
export const READ_LOCAL = { readOnlyHint: true, openWorldHint: false } as const;

export const env = z.enum(OPENOBSERVE_ENVS).optional()
  .describe("OpenObserve environment ('dev', 'stg', 'prod'): uses config/openobserve.<env>.env for this call. Omit for the server default (OPENOBSERVE_ENV, else the OPENOBSERVE_URL/EMAIL/TOKEN variables, else dev if its file has a URL). Use the same env for every call of one investigation.");
export const organization = z.string().min(1).describe('Organization identifier from list_openobserve_organizations.');
export const stream = z.string().min(1).describe('Log stream from list_openobserve_streams.');
export const level = z.union([z.enum(LOG_LEVELS), z.array(z.enum(LOG_LEVELS)).min(1)]).optional()
  .describe("One level = minimum severity (e.g. 'Warning' returns Warning, Error, Fatal); an array = exactly those levels.");
export const to = z.string().optional().describe('Upper time bound, ISO 8601 with timezone; defaults to now.');
export const limit = z.number().int().min(1).max(500).default(50).describe('Maximum rows (1-500).');
