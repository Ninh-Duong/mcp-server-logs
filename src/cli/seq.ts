/** CLI Seq search: reuse or enter the account (saved to config/seq.env), then one filtered query. */
import { resolve } from 'node:path';
import { CONFIG_DIR, config, writePrivateEnvFile } from '../config.js';
import { defaultLogsService } from '../service.js';
import { Prompt, confirm } from './io.js';

export async function runSeq(prompt: Prompt): Promise<void> {
  await configureSeq(prompt);
  const query = (await prompt.ask('Seq filter (blank for recent logs): ')).trim();
  const count = Number((await prompt.ask('Maximum results [10]: ')).trim() || 10);
  if (!Number.isInteger(count) || count < 1 || count > 500) throw new Error('Maximum results must be 1-500');
  const logs = await defaultLogsService.queryLogs({ provider: 'seq', query: query || undefined, limit: count });
  console.log(`\nFound ${logs.length} logs:`);
  for (const log of logs) console.log(`[${log.timestamp}] [${log.level}] ${log.message}`);
}

async function configureSeq(prompt: Prompt): Promise<void> {
  if (config.seq.serverUrl && config.seq.apiKey && await confirm(prompt, 'Use saved Seq account? (Y/n): ')) return;
  const serverUrl = (await prompt.ask(`Seq URL${config.seq.serverUrl ? ` [${config.seq.serverUrl}]` : ''}: `)).trim() || config.seq.serverUrl;
  const apiKey = (await prompt.secret('Seq API key (hidden): ')).trim() || config.seq.apiKey;
  if (!serverUrl || !apiKey) throw new Error('Seq URL and API key are required');
  const parsed = new URL(serverUrl);
  const local = parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !local) throw new Error('Seq URL must use HTTPS outside localhost');
  writePrivateEnvFile(resolve(CONFIG_DIR, 'seq.env'), { SEQ_SERVER_URL: serverUrl, SEQ_API_KEY: apiKey });
  config.seq.serverUrl = serverUrl.replace(/\/+$/, '');
  config.seq.apiKey = apiKey;
  console.log('Seq account saved locally.');
}
