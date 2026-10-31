/** OpenObserve discovery and search tools: organizations, streams, schema, services, service logs, RCID, SQL. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { openObserveProvider } from '../providers/index.js';
import { resolveLevels } from '../providers/base.js';
import { READ_REMOTE, env, json, level, limit, organization, runIn, stream, to } from './common.js';

export function registerOpenObserveTools(server: McpServer, prefix: string): void {
  server.registerTool(`${prefix}list_openobserve_organizations`, {
    title: 'List OpenObserve organizations',
    description: 'Connect to OpenObserve and list organizations accessible to the logging account of an environment (env, default: the server default).',
    inputSchema: { env },
    annotations: READ_REMOTE,
  }, (args) => runIn('list_openobserve_organizations', args.env, async () => json({ organizations: await openObserveProvider.listOrganizations() })));

  server.registerTool(`${prefix}list_openobserve_streams`, {
    title: 'List OpenObserve log streams',
    description: 'List log streams of type logs in an accessible OpenObserve organization. Call this before schema discovery or SQL search. The list is cached for 5 minutes.',
    inputSchema: { env, organization },
    annotations: READ_REMOTE,
  }, ({ env: e, ...args }) => runIn('list_openobserve_streams', e, async () => json({ organization: args.organization, streams: await openObserveProvider.listStreams(args.organization) })));

  server.registerTool(`${prefix}list_openobserve_stream_schema`, {
    title: 'List stream fields',
    description: 'Return field names and types for an accessible OpenObserve log stream. Call this before composing SQL; only query fields returned here. The schema is cached for 5 minutes.',
    inputSchema: { env, organization, stream },
    annotations: READ_REMOTE,
  }, ({ env: e, ...args }) => runIn('list_openobserve_stream_schema', e, async () =>
    json({ ...args, fields: await openObserveProvider.getStreamSchema(args.organization, args.stream) })));

  server.registerTool(`${prefix}list_openobserve_services`, {
    title: 'List services in a stream',
    description: 'List services that logged in an OpenObserve log stream, with log counts (and Error/Warning counts when the stream has a level field). Works for structured streams (service_name) and Kubernetes streams (deployment from pod name).',
    inputSchema: { env, organization, stream, from: z.string().default('1h').describe('Lower time bound (default 1h), ISO 8601 with timezone or relative duration.'), to },
    annotations: READ_REMOTE,
  }, ({ env: e, ...args }) => runIn('list_openobserve_services', e, async () =>
    json({ organization: args.organization, stream: args.stream, from: args.from, ...await openObserveProvider.listServices(args) })));

  server.registerTool(`${prefix}get_openobserve_service_logs`, {
    title: 'Get service logs',
    description: 'Get logs of one service (from list_openobserve_services) or all services in a stream, filtered by level, newest first. Use this instead of SQL for level filtering: Kubernetes streams have no level field.',
    inputSchema: {
      env, organization, stream,
      service: z.string().optional().describe('Service name from list_openobserve_services; omit for all services.'),
      level, from: z.string().default('1h').describe('Lower time bound (default 1h).'), to, limit,
    },
    annotations: READ_REMOTE,
  }, ({ env: e, level: levelArg, ...args }) => runIn('get_openobserve_service_logs', e, async () => {
    const logs = await openObserveProvider.searchServiceLogs({ ...args, levels: resolveLevels(levelArg) });
    return json({ total: logs.length, logs });
  }));

  server.registerTool(`${prefix}find_openobserve_logs_by_rcid`, {
    title: 'Find logs by RCID',
    description: 'Find OpenObserve logs with an exact RCID in one accessible log stream.',
    inputSchema: {
      env, organization, stream,
      rcid: z.string().min(1).describe('Exact request or correlation ID to find across logs.'),
      field: z.string().min(1).default('rcid').describe('Name of the RCID field in the stream.'),
      from: z.string().default('15m').describe('Lower time bound (default 15m).'), to, limit,
    },
    annotations: READ_REMOTE,
  }, ({ env: e, ...args }) => runIn('find_openobserve_logs_by_rcid', e, async () => {
    const logs = await openObserveProvider.findByRcid(args);
    return json({ total: logs.length, logs });
  }));

  server.registerTool(`${prefix}search_openobserve_logs`, {
    title: 'Search with SQL',
    description: 'Run a read-only OpenObserve SQL SELECT against an accessible organization. Discover the stream fields first; use quoted identifiers, a narrow from/to window (ISO 8601 with timezone or supported relative values), and limit 1-500 (start at 100 or less). Cache first: the same SQL (whitespace aside), organization, env and window is answered from ai-context (cached: true) without calling OpenObserve; relative bounds and the default end count from the start of the current minute (window shows the bounds used).',
    inputSchema: {
      env, organization,
      sql: z.string().min(1).describe('Exactly one SELECT statement against the chosen stream. Discover stream fields first and quote identifiers.'),
      from: z.string().default('15m').describe('Inclusive lower bound (default 15m), ISO 8601 with timezone or relative duration.'),
      to: z.string().optional().describe('Exclusive upper bound, ISO 8601 with timezone; defaults to now.'),
      limit: z.number().int().min(1).max(500).default(50).describe('Maximum rows (1-500); start at 100 or less.'),
    },
    annotations: READ_REMOTE,
  }, ({ env: e, ...args }) => runIn('search_openobserve_logs', e, async () => {
    const { logs, cached, from, to } = await openObserveProvider.searchCached(args);
    return json({ total: logs.length, search: args, window: { from, to }, cached, logs });
  }));
}
