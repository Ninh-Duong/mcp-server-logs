import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { logsInstructions, registerLogsTools } from '../tools/index.js';

/** Connects a linked pair of MCP Client and Server for protocol compliance testing */
async function createClient(prefix?: string): Promise<{ client: Client; server: McpServer }> {
  const server = new McpServer({ name: 'mcp-server-logs', version: '1.0.0' }, { instructions: logsInstructions(prefix) });
  registerLogsTools(server, { prefix });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'compliance-test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, server };
}

test('MCP Specification: Tool definitions, naming syntax, and annotations compliance', async () => {
  const { client } = await createClient();
  const { tools } = await client.listTools();

  assert.equal(tools.length, 12, 'exactly 12 tools registered');

  const MCP_NAME_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

  for (const tool of tools) {
    // 1. Tool name syntax
    assert.match(tool.name, MCP_NAME_REGEX, `Tool name '${tool.name}' must conform to MCP naming syntax`);

    // 2. Title & Description
    assert.ok(typeof tool.title === 'string' && tool.title.trim().length > 0, `Tool '${tool.name}' must have a non-empty title`);
    assert.ok(typeof tool.description === 'string' && tool.description.trim().length > 0, `Tool '${tool.name}' must have a non-empty description`);

    // 3. InputSchema syntax
    assert.equal(tool.inputSchema.type, 'object', `Tool '${tool.name}' inputSchema must be of type 'object'`);
    assert.ok(tool.inputSchema.properties, `Tool '${tool.name}' inputSchema must have properties defined`);

    // 4. Properties description check
    for (const [propName, propSchema] of Object.entries(tool.inputSchema.properties as Record<string, { description?: string }>)) {
      assert.ok(propSchema.description, `Parameter '${propName}' in tool '${tool.name}' must have a description`);
    }

    // 5. Annotations compliance
    assert.ok(tool.annotations, `Tool '${tool.name}' must have annotations`);
    assert.equal(typeof tool.annotations.readOnlyHint, 'boolean', `Tool '${tool.name}' must define readOnlyHint`);
    assert.equal(typeof tool.annotations.openWorldHint, 'boolean', `Tool '${tool.name}' must define openWorldHint`);
  }

  // Exactly one tool writes (export_openobserve_logs)
  const writingTools = tools.filter((t) => !t.annotations?.readOnlyHint);
  assert.deepEqual(writingTools.map((t) => t.name), ['export_openobserve_logs'], 'only export_openobserve_logs has readOnlyHint: false');
});

test('MCP Specification: InputSchema validation and boundary rejection', async () => {
  const { client } = await createClient();

  // Test 1: Out of range integer limit rejection
  const limitOverflow = await client.callTool({ name: 'query_logs', arguments: { limit: 9999 } }) as { isError?: boolean };
  assert.equal(limitOverflow.isError, true, 'limit > 500 must be rejected by schema');

  // Test 2: Invalid type parameter rejection (string passed where number expected)
  const wrongType = await client.callTool({ name: 'query_logs', arguments: { limit: 'fifty' } }) as { isError?: boolean };
  assert.equal(wrongType.isError, true, 'non-numeric limit must be rejected by schema');

  // Test 3: Missing required parameters in read_ai_context
  const missingSnapshot = await client.callTool({ name: 'read_ai_context', arguments: {} }) as { isError?: boolean };
  assert.equal(missingSnapshot.isError, true, 'missing required snapshot parameter must fail schema validation');

  // Test 4: Missing required parameter in find_openobserve_logs_by_rcid
  const missingRcid = await client.callTool({
    name: 'find_openobserve_logs_by_rcid',
    arguments: { organization: 'org', stream: 'stream' },
  }) as { isError?: boolean };
  assert.equal(missingRcid.isError, true, 'missing rcid must fail schema validation');
});

test('MCP Specification: Prompts schema, metadata, and message response syntax', async () => {
  const { client } = await createClient();
  const { prompts } = await client.listPrompts();

  assert.equal(prompts.length, 2, 'exactly 2 prompts registered');
  const promptNames = prompts.map((p) => p.name).sort();
  assert.deepEqual(promptNames, ['analyze_ai_context', 'investigate_api_bug']);

  for (const prompt of prompts) {
    assert.ok(prompt.title && prompt.title.length > 0, `Prompt '${prompt.name}' must have a title`);
    assert.ok(prompt.description && prompt.description.length > 0, `Prompt '${prompt.name}' must have a description`);
    assert.ok(prompt.arguments && prompt.arguments.length > 0, `Prompt '${prompt.name}' must have arguments schema`);
  }

  // Verify investigate_api_bug prompt message syntax
  const bugPrompt = await client.getPrompt({
    name: 'investigate_api_bug',
    arguments: { bug_report: 'NullReferenceException', api_endpoint: 'POST /checkout' },
  });
  assert.ok(bugPrompt.description, 'prompt result has description');
  assert.equal(bugPrompt.messages.length, 1, 'prompt returns exactly one message');
  assert.equal(bugPrompt.messages[0]!.role, 'user');
  assert.equal((bugPrompt.messages[0]!.content as { type: string }).type, 'text');
  const bugText = (bugPrompt.messages[0]!.content as { text: string }).text;
  assert.match(bugText, /NullReferenceException/);
  assert.match(bugText, /POST \/checkout/);

  // Verify analyze_ai_context prompt message syntax
  const analyzePrompt = await client.getPrompt({
    name: 'analyze_ai_context',
    arguments: { question: 'Summarize errors' },
  });
  assert.equal(analyzePrompt.messages.length, 1);
  assert.equal(analyzePrompt.messages[0]!.role, 'user');
  const analyzeText = (analyzePrompt.messages[0]!.content as { text: string }).text;
  assert.match(analyzeText, /Summarize errors/);
  assert.match(analyzeText, /read_ai_context/);
});

test('MCP Specification: Namespace prefixing preserves complete tool and prompt contract', async () => {
  const PREFIX = 'logs__';
  const { client } = await createClient(PREFIX);
  const { tools } = await client.listTools();
  const { prompts } = await client.listPrompts();

  assert.ok(tools.every((t) => t.name.startsWith(PREFIX)), 'all tools prefixed with logs__');
  assert.ok(prompts.every((p) => p.name.startsWith(PREFIX)), 'all prompts prefixed with logs__');

  // Verify prefixed prompt returns instructions with prefixed tool references
  const prompt = await client.getPrompt({
    name: 'logs__investigate_api_bug',
    arguments: { bug_report: 'crash', api_endpoint: '/api/v1' },
  });
  const text = (prompt.messages[0]!.content as { text: string }).text;
  assert.match(text, /logs__list_openobserve_organizations/);
  assert.match(text, /logs__search_openobserve_logs/);
});

test('MCP Protocol: Server instructions sent during handshake match standard format', async () => {
  const instructions = logsInstructions();
  assert.ok(instructions.length > 50, 'instructions must be informative');
  assert.match(instructions, /mcp-server-logs:/);
  assert.match(instructions, /read_ai_context/);
  assert.match(instructions, /list_ai_context_snapshots/);
  assert.match(instructions, /export_openobserve_logs/);
});
