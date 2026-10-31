/** Terminal input for the CLI: questions, hidden secrets, and a stdout progress line. */
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

export interface Prompt {
  ask(question: string): Promise<string>;
  /** Asks without echoing; shows one * per character (at most 32) so a paste visibly arrived. */
  secret(label: string): Promise<string>;
  close(): void;
}

export function createPrompt(): Prompt {
  let hideInput = false;
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!hideInput) process.stdout.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: Boolean(process.stdin.isTTY), historySize: 0 });
  const ask = (question: string): Promise<string> => new Promise((done) => rl.question(question, done));
  const secret = async (label: string): Promise<string> => {
    console.log('Paste with Ctrl+Shift+V or Shift+Insert, then press Enter. Input appears as *.');
    process.stdout.write(label);
    hideInput = true;
    const showMask = (_text: string, key: { name?: string }) => {
      if (key.name !== 'return' && key.name !== 'enter') process.stdout.write(`\r\x1b[2K${label}${'*'.repeat(Math.min(rl.line.length, 32))}`);
    };
    if (process.stdin.isTTY) process.stdin.on('keypress', showMask);
    try {
      return await ask('');
    } finally {
      process.stdin.removeListener('keypress', showMask);
      hideInput = false;
      process.stdout.write('\n');
    }
  };
  return { ask, secret, close: () => rl.close() };
}

/** "y/N"-style answer: true unless the answer is "n" (or, with defaultNo, true only for "y"). */
export async function confirm(prompt: Prompt, question: string, defaultNo = false): Promise<boolean> {
  const answer = (await prompt.ask(question)).trim().toLowerCase();
  return defaultNo ? answer === 'y' : answer !== 'n';
}

/** Picks one item from a numbered list printed under `title`. */
export async function choose<T>(prompt: Prompt, title: string, items: T[], label: (item: T) => string, question: string, error: string): Promise<T> {
  console.log(`\n${title}`);
  items.forEach((item, index) => console.log(`  ${index + 1}. ${label(item)}`));
  const item = items[Number((await prompt.ask(question)).trim()) - 1];
  if (item === undefined) throw new Error(error);
  return item;
}

/** One progress line that rewrites itself instead of a log line per page. */
export const progressLine = (tag: string) => (rows: number) => process.stdout.write(`\r\x1b[2K${tag}fetched ${rows.toLocaleString()} rows…`);
export const clearLine = () => process.stdout.write('\r\x1b[2K');
