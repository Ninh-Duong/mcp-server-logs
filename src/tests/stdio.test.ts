import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { PROJECT_ROOT } from '../config.js';

test('MCP stdio: stdout carries only JSON-RPC and lists every tool', async () => {
  const child = spawn(process.execPath, ['cli.mjs'], { cwd: PROJECT_ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  const replies = new Map<number, { result?: { tools?: Array<{ name: string }>; instructions?: string } }>();
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
    for (const line of stdout.split('\n').slice(0, -1)) {
      const message = JSON.parse(line);
      if (message.id !== undefined) replies.set(message.id, message);
    }
  });
  const send = (message: object) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const reply = async (id: number) => {
    for (let i = 0; i < 100 && !replies.has(id); i++) await new Promise((r) => setTimeout(r, 50));
    return replies.get(id);
  };
  try {
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    // Agents in other repositories never see AGENTS.md: the server tells them how to read ai-context when they connect.
    const instructions = (await reply(1))?.result?.instructions ?? '';
    assert.match(instructions, /read_ai_context/);
    assert.match(instructions, /never open.*\.lhub/i);
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/list' });
    assert.equal((await reply(2))?.result?.tools?.length, 12);
  } finally {
    child.kill();
  }
  for (const line of stdout.split('\n').filter(Boolean)) assert.equal(JSON.parse(line).jsonrpc, '2.0', line);
});
