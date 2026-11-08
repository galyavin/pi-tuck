import { test, expect } from 'vitest';
import { shrinkDialogue, wholeDialogue, omittedDialogue, type DialogueInput } from '../src/tuck/core/shrink';
import { userPrefixRecords } from '../src/tuck/core/brief';
import { DIALOGUE_SUFFIX } from '../src/tuck/core/format';
import { parseRecords, serializeRecords, splitSummary, type TranscriptRecord } from '../src/tuck/core/transcript';
import type { NormalizedBlock } from '../src/tuck/types';
import { session } from './random-sessions';

const sentence = (seed: number, words = 9) => Array.from({ length: words }, (_, i) => `W${seed}x${i}`).join(' ') + '.';
const prose = (seed: number, sentences: number) => Array.from({ length: sentences }, (_, i) => sentence(seed * 100 + i)).join(' ');
const recordsOf = (text: string): TranscriptRecord[] => text ? parseRecords(splitSummary(text)!.body) : [];
const inputOf = (blocks: NormalizedBlock[]): DialogueInput => ({ blocks, sourceIndices: blocks.map(block => block.sourceIndex) });
function dialogue(turns: number, user = 3, assistant = 30) {
  return inputOf(Array.from({ length: turns }, (_, turn): NormalizedBlock[] => [
    { kind: 'user', sourceIndex: turn * 3, text: prose(turn, user) },
    { kind: 'assistant', sourceIndex: turn * 3 + 1, text: prose(turn + 100, assistant) },
    { kind: 'tool_result', sourceIndex: turn * 3 + 2, name: 'read' },
  ]).flat());
}

test('a dialogue that fits comes back whole, byte for byte', () => {
  const input = dialogue(30), whole = wholeDialogue(input);
  expect(shrinkDialogue(input, whole.length)).toEqual({ text: whole, step: 'whole', size: whole.length });
  expect(shrinkDialogue(input, whole.length - 1).step).not.toBe('whole');
});

test('counted ranges account for tools and several assistant units sharing one original source', () => {
  const blocks: NormalizedBlock[] = [];
  for (let at = 0; at < 40; at++) {
    for (let part = 0; part < 3; part++) blocks.push({ kind: 'assistant', sourceIndex: at * 2, text: sentence(at * 3 + part, 400) });
    blocks.push({ kind: 'tool_result', sourceIndex: at * 2 + 1, name: 'read' });
  }
  const input = inputOf(blocks), floor = recordsOf(omittedDialogue(input));
  expect(floor.find(record => record.role === 'assistant')?.count).toBe(120);
  expect(floor.find(record => record.role === 'assistant')?.sourceRange).toEqual({ start: 0, end: 78 });
  expect(floor.find(record => record.role === 'toolResult')?.sourceRange).toEqual({ start: 1, end: 79 });
  expect(floor.some(record => record.sourceIndices !== undefined)).toBe(false);
  for (const limit of [4000, 8000, 16000]) {
    const records = recordsOf(shrinkDialogue(input, limit).text);
    const shown = records.filter(record => record.kind === 'excerpt' && record.role === 'assistant');
    const omitted = records.find(record => record.kind === 'omission' && record.role === 'assistant')!;
    expect(shown.length + omitted.count!).toBe(120);
    for (const block of blocks.filter(block => block.kind === 'assistant')) {
      expect(shown.some(record => record.sourceIndex === block.sourceIndex) || block.sourceIndex! >= omitted.sourceRange!.start && block.sourceIndex! <= omitted.sourceRange!.end).toBe(true);
    }
  }
});

test('the recent assistant third survives before more user text, with the newest assistant units first', () => {
  const input = dialogue(60, 12, 6), limit = 12000;
  const records = recordsOf(shrinkDialogue(input, limit).text);
  const replies = records.filter(record => record.kind === 'excerpt' && record.role === 'assistant');
  expect(replies.length).toBeGreaterThan(0);
  expect(replies.at(-1)?.sourceIndex).toBe(59 * 3 + 1);
  const units = input.blocks.filter(block => block.kind === 'assistant');
  expect(replies.map(record => record.sourceIndex)).toEqual(units.slice(-replies.length).map(block => block.sourceIndex));
  const characters = replies.reduce((sum, record) => sum + record.text!.length, 0);
  expect(characters).toBeGreaterThan(limit / 3 - 2 * prose(100, 6).length);
});

test('a mandatory source renders as nothing and is not counted; missing locators are stated', () => {
  const input = dialogue(10);
  input.mandatorySourceIndices = new Set([0, 1, 2]);
  input.blocks.push({ kind: 'user', text: 'Unlocated input.' });
  const records = recordsOf(omittedDialogue(input));
  expect(records.map(record => record.count)).toEqual([10, 9, 9]);
  expect(records.every(record => record.sourceRange!.start >= 3)).toBe(true);
  expect(records[0]?.reason).toContain('no source locator');
});

test('an allowance smaller than counted omission metadata offers no misleading partial view', () => {
  const input = dialogue(30);
  for (const limit of [0, 1, 100]) expect(shrinkDialogue(input, limit)).toEqual({ text: '', step: 'none', size: 0 });
  const floor = omittedDialogue(input);
  expect(shrinkDialogue(input, floor.length).text.length).toBeLessThanOrEqual(floor.length);
});

test('random sessions stay within the allowance, round trip exactly, and retain exact passage spans', () => {
  let checked = 0, clipped = 0;
  for (let seed = 1; seed <= 150; seed++) {
    const { blocks, mandatory, sourceIndices, sourceEntryIds } = session(seed);
    const input: DialogueInput = { blocks, mandatorySourceIndices: seed % 3 ? mandatory : undefined, sourceIndices, sourceEntryIds };
    const whole = wholeDialogue(input);
    const texts = new Map<string, string[]>();
    for (const block of blocks) if ('text' in block) {
      const key = `${block.kind === 'notice' ? 'custom' : block.kind}:${block.sourceIndex}`;
      texts.set(key, [...(texts.get(key) ?? []), block.text]);
    }
    for (const limit of [Infinity, whole.length, ...[0.9, 0.7, 0.5, 0.3, 0.15, 0.08, 0.03].map(fraction => Math.floor(whole.length * fraction)), 700, 100]) {
      const result = shrinkDialogue(input, limit);
      expect(result.text.length).toBeLessThanOrEqual(limit);
      expect(result.size).toBe(result.text.length);
      if (limit >= whole.length) expect(result.text).toBe(whole);
      if (!result.text) continue;
      expect(result.text.endsWith(DIALOGUE_SUFFIX)).toBe(true);
      const records = recordsOf(result.text);
      expect(parseRecords(serializeRecords(records))).toEqual(records);
      for (const record of records) if (record.span && record.sourceIndex !== undefined) {
        const candidates = texts.get(`${record.role}:${record.sourceIndex}`) ?? [];
        expect(candidates.some(text => text.length === record.span!.totalCharacters &&
          (record.kind === 'omission' || text.slice(record.span!.start, record.span!.end) === record.text))).toBe(true);
        if (record.kind === 'excerpt') clipped++;
      }
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(500);
  expect(clipped).toBeGreaterThan(0);
});

test('user excerpts retain their source time; counted ranges stay compact', () => {
  const input = dialogue(20, 40, 10);
  const sourceTimes = Object.fromEntries(input.sourceIndices.map(index => [index!, { basis: 'message' as const, utc: '2026-11-08T12:00:00Z' }]));
  input.blocks = input.blocks.map(block => ({ ...block, sourceTimes }));
  const records = recordsOf(shrinkDialogue(input, 12000).text);
  const user = records.find(record => record.role === 'user' && record.kind === 'excerpt')!;
  expect(user.sourceTimes?.[0]).toMatchObject({ basis: 'message', utc: '2026-11-08T12:00:00Z' });
  expect(records.filter(record => record.sourceRange).every(record => record.sourceTimes === undefined && record.sourceIndices === undefined)).toBe(true);
});

test('a protected prefix completes a Unicode character at the opening boundary', () => {
  const text = 'x'.repeat(79) + '😊' + ' remaining text';
  const records = userPrefixRecords({ kind: 'user', sourceIndex: 4, text, originalText: text, startsSource: true }, undefined, 80);
  expect(records[0]?.text).toBe(text.slice(0, 81));
  expect(records[1]?.reason).toBe('tuck_recall {"index":4,"offset":81}');
  expect(parseRecords(serializeRecords(records))).toEqual(records);
});
