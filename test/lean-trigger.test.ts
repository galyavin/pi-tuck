import { expect, test } from 'vitest';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { bandOf } from '../src/budget';
import { LEAN_HOLDING, LEAN_MIN_SAMPLES, leanInputs, leanLine } from '../src/lean';
import { receiptOf, scenario } from './budget-fixture';

// Lean line: K + sqrt(2(K + R)·δ / h) from the branch's own usage, never later than 1.8.0's trigger; admission unchanged.
const usage = (input: number) => ({ input, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: input, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const reply = (input: number, content: unknown[] = [{ type: 'text', text: 'ok' }], stopReason = 'stop') =>
 ({ type: 'message', message: { role: 'assistant', content, stopReason, api: 'a', provider: 'p', model: 'm', timestamp: 0, usage: usage(input) } });
const cut = { type: 'compaction' };
const branch = (...e: unknown[]) => e as SessionEntry[];
const line = (K: number, d: number, R = 0) => Math.ceil(K + Math.sqrt(2 * (K + R) * d / LEAN_HOLDING));

test('the lean line needs a cut, a reply after it and enough growth samples', () => {
 expect(leanLine(branch(reply(1000), reply(2000), reply(3000), reply(4000), reply(5000), reply(6000)))).toBeUndefined();
 expect(leanLine(branch(cut))).toBeUndefined();
 const few = branch(cut, ...Array.from({ length: LEAN_MIN_SAMPLES }, (_, i) => reply(30_000 + i * 1000)));
 expect(leanLine(few)).toBeUndefined();
 const enough = branch(cut, ...Array.from({ length: LEAN_MIN_SAMPLES + 1 }, (_, i) => reply(30_000 + i * 1000)));
 expect(leanLine(enough)).toBe(line(30_000, 1000));
 // Shrinking context: no positive growth, no line.
 expect(leanLine(branch(cut, ...Array.from({ length: 6 }, (_, i) => reply(30_000 - i * 10))))).toBeUndefined();
});

test('K is what the latest cut left; growth skips the drop at a cut; errored replies do not count', () => {
 const b = branch(reply(10_000), reply(12_000), reply(14_000), cut, reply(5_000), reply(6_000), reply(99_999, [], 'error'), reply(7_000), cut, reply(4_000), reply(4_500));
 const { kept, growth, samples, cuts } = leanInputs(b);
 expect(kept).toBe(4_000);
 expect(cuts).toBe(2);
 expect(samples).toBe(5);
 expect(growth).toBe((2_000 + 2_000 + 1_000 + 1_000 + 500) / 5);
});

test('unchanged re-reads soon after a cut raise R and so the line', () => {
 const text = 'x'.repeat(4_000);
 const read = (id: string, input: number) => [reply(input, [{ type: 'toolCall', id, name: 'read', arguments: { path: 'a.ts' } }], 'toolUse'),
  { type: 'message', message: { role: 'toolResult', toolCallId: id, toolName: 'read', isError: false, content: [{ type: 'text', text }], timestamp: 0 } }];
 const grow = (from: number) => Array.from({ length: 5 }, (_, i) => reply(from + i * 1000));
 const quiet = branch(...read('1', 20_000), cut, ...grow(30_000));
 const thrash = branch(...read('1', 20_000), cut, ...read('2', 30_000), ...grow(31_000));
 expect(leanInputs(thrash).rereads).toBe(1_000);
 expect(leanLine(thrash)!).toBeGreaterThan(leanLine(quiet)!);
});

// End to end at a large window: a session whose recorded cut left about 3k and which grows about 200 a request cuts at its lean line,
// far below the band; the same request without that history does not cut.
const WINDOW = 131_072, RESERVE = 16_384, BAND = bandOf(WINDOW - RESERVE);
const large = {
 at: 'tool' as const, host: 100, systemTokens: 800, fresh: 2_000, keepRecent: 2_000,
 limits: { contextWindow: WINDOW, maxTokens: RESERVE }, reserveTokens: RESERVE,
 cutAtDefault: true, compaction: { requestReserve: undefined },
};
const lean = { lean: { kept: 3_000, growth: 200, replies: 6 } };

test('a lean session cuts at its line, far below the band, as an opportunistic cut', async () => {
 expect(line(3_000, 200)).toBeLessThan(12_000);
 const r = await scenario({ ...large, ...lean, complete: 12_000 });
 expect(r.faults, r.probe).toEqual([]);
 expect(r.aborts, r.probe).toBe(0);
 expect(r.cuts, r.probe).toBe(1);
 expect(receiptOf(r.entries[0]!).target, r.probe).toBe('band');
 expect(r.guard[1]!, r.probe).toBeLessThan(12_000);
 expect(r.last?.stopReason, r.probe).toBe('stop');
});

test('without a measured lean line the same request is sent whole, as in 1.8.0', async () => {
 const r = await scenario({ ...large, complete: 12_000 });
 expect(r.faults, r.probe).toEqual([]);
 expect(r.cuts, r.probe).toBe(0);
 expect(12_000).toBeLessThan(BAND);
});

test('below its lean line a lean session does not cut', async () => {
 const r = await scenario({ ...large, ...lean, complete: 5_000 });
 expect(r.faults, r.probe).toEqual([]);
 expect(r.cuts, r.probe).toBe(0);
});

test('an explicit cutAt turns the lean line off', async () => {
 const r = await scenario({ ...large, ...lean, cutAtDefault: false, compaction: { requestReserve: undefined, cutAt: 0.9 }, complete: 12_000 });
 expect(r.faults, r.probe).toEqual([]);
 expect(r.cuts, r.probe).toBe(0);
});

test('a cache-sensitive model never gets a lean cut', async () => {
 const r = await scenario({ ...large, ...lean, compaction: { requestReserve: undefined, cacheSensitiveModels: ['openai-codex/gpt-6.1-sol'] }, complete: 12_000 });
 expect(r.faults, r.probe).toEqual([]);
 expect(r.cuts, r.probe).toBe(0);
 // The same session without the list cuts at its lean line.
 expect((await scenario({ ...large, ...lean, complete: 12_000 })).cuts).toBe(1);
});

// A cut planned at prompt time or by the guard is carried by requests at once and saved at the next boundary, after the reply that carried
// it. Both log orders must read as the clean case: K is what the cut left, growth never takes the drop (state-machine review L1).
test('a cut saved after the reply that carried it gives the same K and growth as one saved before it', () => {
 const grow = (from: number, n: number) => Array.from({ length: n }, (_, i) => reply(from + i * 3_000));
 const before = branch(...grow(200_000, 6), cut, ...grow(60_000, 6));
 const after = branch(...grow(200_000, 6), reply(60_000), cut, ...grow(63_000, 5));
 for (const b of [before, after]) {
  const { kept, growth, samples, cuts } = leanInputs(b);
  expect(kept).toBe(60_000);
  expect(growth).toBe(3_000);
  expect(samples).toBe(10);
  expect(cuts).toBe(1);
 }
 expect(leanLine(after)).toBe(leanLine(before));
 // Two cuts in one boundary (the prompt's cut, then a fresh one): the second entry is the second cut, and K is what the reply after it saw.
 const twice = branch(...grow(200_000, 6), reply(60_000), cut, cut, ...grow(40_000, 5));
 expect(leanInputs(twice).kept).toBe(40_000);
 expect(leanInputs(twice).growth).toBe(3_000);
});

test('right after a cut with no reply yet the lean line waits for a measured K', () => {
 const grow = (from: number, n: number) => Array.from({ length: n }, (_, i) => reply(from + i * 3_000));
 expect(leanLine(branch(...grow(200_000, 6), cut, ...grow(60_000, 6), cut))).toBeUndefined();
});

test('a re-read in the reply that first carries a prompt-time cut counts against that cut', () => {
 const text = 'x'.repeat(4_000);
 const read = (id: string, input: number) => [reply(input, [{ type: 'toolCall', id, name: 'read', arguments: { path: 'a.ts' } }], 'toolUse'),
  { type: 'message', message: { role: 'toolResult', toolCallId: id, toolName: 'read', isError: false, content: [{ type: 'text', text }], timestamp: 0 } }];
 const b = branch(...read('1', 200_000), reply(203_000), ...read('2', 60_000), cut, reply(65_000));
 expect(leanInputs(b).rereads).toBe(1_000);
 expect(leanInputs(b).cuts).toBe(1);
});
