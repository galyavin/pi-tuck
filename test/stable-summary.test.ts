import { expect, test } from 'vitest';
import { parseRecords, splitSummary } from '../src/tuck/core/transcript';
import { run } from './synthetic-sessions';

// Prefix-stable summaries: the previous summary's dialogue records lead the next summary verbatim, counters follow the dialogue, and a
// summary that must shrink keeps its carried prompts as the prefix.
const shared = (a: string, b: string) => { let n = 0; while (n < a.length && a[n] === b[n]) n++; return n; };
const counted = (line: string) => /^(user|assistant|toolResult) omitted \d+ #\d+-#\d+:/.test(line);

test('a whole dialogue grows by appending: each summary begins with the previous one\'s records', () => {
 const cuts = run('low-prose', { window: 32000, reserve: 4096, turns: 500, stopAfterCuts: 8 });
 expect(cuts.length).toBe(8);
 for (let k = 1; k < cuts.length; k++) {
  const before = splitSummary(cuts[k - 1]!.summary!)!.body.split('\n').filter(line => !counted(line) && /^#\d+ (user|assistant)/.test(line));
  const after = splitSummary(cuts[k]!.summary!)!.body.split('\n');
  expect(after.slice(0, before.length), `cut ${k + 1}`).toEqual(before);
 }
});

test('counters follow every dialogue record', () => {
 for (const cut of run('prose', { window: 128000, reserve: 16384, turns: 400, stopAfterCuts: 6 })) {
  const lines = splitSummary(cut.summary!)!.body.split('\n');
  const lastDialogue = lines.findLastIndex(line => /^#\d+ (user|assistant|custom)/.test(line));
  const firstCounter = lines.findIndex(counted);
  if (firstCounter >= 0) expect(firstCounter).toBeGreaterThan(lastDialogue);
  expect(parseRecords(splitSummary(cut.summary!)!.body).length).toBe(lines.length);
 }
});

test('a shrinking summary keeps its carried prompts as the shared prefix', () => {
 const cuts = run('prose', { window: 128000, reserve: 16384, turns: 400, stopAfterCuts: 6 });
 const prefixes = cuts.slice(1).map((cut, k) => shared(cuts[k]!.summary!, cut.summary!));
 // 1.8.0 re-ranked the whole history at every cut and shared 337 characters (the header and first prompt) at cuts 2, 5 and 6.
 expect(prefixes.filter(n => n > 10_000).length).toBeGreaterThanOrEqual(3);
 expect(prefixes.reduce((a, b) => a + b, 0)).toBeGreaterThan(70_000);
});
