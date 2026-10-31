/** The CLI time range question: presets, a local day + hours, or custom bounds, resolved once to ISO. */
import { parseTimeBound } from '../providers/base.js';
import { Prompt } from './io.js';

const PRESETS: Array<[string, string]> = [['Last 15 minutes', '15m'], ['Last 1 hour', '1h'], ['Last 6 hours', '6h'], ['Last 24 hours', '24h'], ['Last 7 days', '7d']];
const DAY_CHOICE = PRESETS.length + 1;
const CUSTOM_CHOICE = DAY_CHOICE + 1;

/** Preset or custom range, resolved once to ISO so every query in this search uses the same window. */
export async function askTimeRange(prompt: Prompt, defaultChoice: number): Promise<{ from: string; to: string }> {
  console.log(`\nTime range:\n${PRESETS.map(([label], index) => `  ${index + 1}. ${label}`).join('\n')}\n  ${DAY_CHOICE}. Day + hours (24h)\n  ${CUSTOM_CHOICE}. Custom (from / to)`);
  const choice = Number((await prompt.ask(`Choose 1-${CUSTOM_CHOICE} [${defaultChoice}]: `)).trim() || defaultChoice);
  const { fromInput, toInput } = await askBounds(prompt, choice);
  return resolveRange(fromInput, toInput);
}

async function askBounds(prompt: Prompt, choice: number): Promise<{ fromInput: string; toInput: string }> {
  if (PRESETS[choice - 1]) return { fromInput: PRESETS[choice - 1]![1], toInput: '' };
  if (choice === DAY_CHOICE) return askDayHours(prompt);
  if (choice === CUSTOM_CHOICE) {
    const fromInput = (await prompt.ask('From (e.g. 2026-10-07 09:00 local, ISO 8601, or 30m): ')).trim();
    return { fromInput, toInput: (await prompt.ask('To (blank = now): ')).trim() };
  }
  throw new Error('Invalid time range selection');
}

/** Local day + 24h hours, e.g. yesterday 14 → 18. */
async function askDayHours(prompt: Prompt): Promise<{ fromInput: string; toInput: string }> {
  const dayInput = (await prompt.ask('Day (YYYY-MM-DD, or 0 = today, 1 = yesterday, 2 = 2 days ago) [1]: ')).trim() || '1';
  const daysAgo = /^\d{1,3}$/.test(dayInput);
  const day = daysAgo ? new Date() : new Date(`${dayInput}T00:00`);
  if (daysAgo) day.setDate(day.getDate() - Number(dayInput));
  const at = (input: string) => {
    const match = input.trim().match(/^(\d{1,2})(?::(\d{2}))?$/);
    if (!match || isNaN(day.getTime()) || Number(match[1]) > 24 || Number(match[2] ?? 0) > 59) throw new Error('Invalid day or hour: use YYYY-MM-DD or 0/1/2, and hours 0-24 (optionally :mm)');
    return new Date(day.getFullYear(), day.getMonth(), day.getDate(), Number(match[1]), Number(match[2] ?? 0)).toISOString();
  };
  const fromInput = at(await prompt.ask('From hour (e.g. 14 or 14:30): '));
  return { fromInput, toInput: at(await prompt.ask('To hour (e.g. 18; 24 = end of day): ')) };
}

function resolveRange(fromInput: string, toInput: string): { from: string; to: string } {
  const now = new Date().toISOString();
  const from = parseTimeBound(fromInput);
  let to = toInput ? parseTimeBound(toInput) : now;
  if (!from || !to || Date.parse(from) >= Date.parse(to)) throw new Error('Invalid time range: use local "YYYY-MM-DD HH:mm", ISO 8601, or 15m/1h/7d, with From before To');
  if (from >= now) throw new Error(`From ${new Date(from).toLocaleString()} is in the future (now ${new Date(now).toLocaleString()}); pick an earlier day or hour`);
  // A range ending later today stops at now, so exports record what they actually cover.
  if (to > now) to = now;
  console.log(`Range: ${new Date(from).toLocaleString()} → ${new Date(to).toLocaleString()} local (${from} → ${to})`);
  return { from, to };
}
