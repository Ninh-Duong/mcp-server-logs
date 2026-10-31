#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { logsInstructions, registerLogsTools } from './tools/index.js';
import { runPreflightChecks } from './utils/preflight.js';
import { logger } from './utils/logger.js';

// Library exports for Master / Router MCP integration
export { logsInstructions, registerLogsTools, type RegisterToolsOptions } from './tools/index.js';
export { LogsService, defaultLogsService } from './service.js';
export { getProvider, getAllProviders, listProviders, openObserveProvider } from './providers/index.js';
export { runPreflightChecks, type PreflightResult } from './utils/preflight.js';
export { logger } from './utils/logger.js';
export * from './types.js';

/**
 * Initializes and starts the MCP server over stdio transport
 */
export async function startMcpServer(): Promise<McpServer> {
  logger.info('Initializing mcp-server-logs in stdio mode...');

  // Run silent preflight checks and log warnings to stderr/file
  const preflight = runPreflightChecks(false);
  if (!preflight.ok) {
    logger.warn('Preflight checks detected issues; some providers may be unavailable.');
  }

  const server = new McpServer({ name: 'mcp-server-logs', version: '1.0.0' }, { instructions: logsInstructions() });

  // Register mcp-server-logs tools into the MCP server
  registerLogsTools(server);

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info('mcp-server-logs is running and connected via stdio.');
  return server;
}

// Execution dispatch: CLI menu, Preflight check, or MCP Stdio server
export async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--cli') || args.includes('-c')) {
    const { runCliMenu } = await import('./cli/menu.js');
    await runCliMenu();
  } else if (args.includes('--preflight')) {
    const result = runPreflightChecks(true);
    process.exit(result.ok ? 0 : 1);
  } else {
    // Default mode: MCP Server over stdio
    await startMcpServer();
  }
}

// Only auto-run when this file is the entry point (realpath resolves the npm bin symlink), not when imported
if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  main().catch((err) => {
    logger.error(`Fatal startup error: ${(err as Error).message}`, err);
    process.exit(1);
  });
}
