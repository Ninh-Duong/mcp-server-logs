/** Interactive CLI (`npm run cli`): pick a log platform, search, export. Errors return to this menu. */
import { logger } from '../utils/logger.js';
import { createPrompt } from './io.js';
import { runOpenObserve } from './openobserve.js';
import { runSeq } from './seq.js';

export async function runCliMenu(): Promise<void> {
  logger.setCliMode(true);
  const prompt = createPrompt();
  while (true) {
    console.log('\nWhich log platform do you want to use?');
    console.log('  1. Seq');
    console.log('  2. Observe');
    console.log('  3. Exit');
    const choice = (await prompt.ask('Choose 1-3: ')).trim();
    if (choice === '3') break;
    if (choice !== '1' && choice !== '2') { console.log('Choose 1, 2, or 3.'); continue; }
    try {
      if (choice === '1') await runSeq(prompt);
      else await runOpenObserve(prompt);
    } catch (err) {
      logger.error('cli.operation_failed', { provider: choice === '1' ? 'seq' : 'openobserve', errorType: err instanceof Error ? err.name : 'UnknownError' });
      console.error(`Error: ${(err as Error).message}`);
    }
    await prompt.ask('\nPress Enter to return to provider selection...');
  }
  prompt.close();
  logger.setCliMode(false);
}
