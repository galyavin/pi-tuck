import { expect, test } from 'vitest';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { bandOf } from '../src/budget';
import { piContextSafetyMargin } from '../src/request-capacity';
import { thrashing } from '../src/thrash';
import { receiptOf, scenario } from './budget-fixture';

// Thrash-adaptive trigger: only in a branch whose cuts drop files the agent re-reads unchanged soon after, the trigger moves to native's line,
// max(band, keepRecentTokens) (parked 4302e2c), capped at window - Pi's margin - max(reply floor, raised reply room) less the margin.
// Cuts still plan to the band. Without thrash the trigger is the band, exactly as in 1.7.0.
const WINDOW = 32_768, RESERVE = 16_384, ROOM = WINDOW - RESERVE, BAND = bandOf(ROOM), MARGIN = Math.ceil(ROOM * 0.02);
const small = {
 at: 'tool' as const, host: 100, systemTokens: 800, fresh: 2_000, keepRecent: 20_000,
 limits: { contextWindow: WINDOW, maxTokens: RESERVE }, reserveTokens: RESERVE,
 cutAtDefault: true, compaction: { requestReserve: undefined },
};
const thrash = { thrash: {} };

test('thrashing, keepRecentTokens above the room: a request between the room and keepRecentTokens is sent without a cut', async () => {
 const r = await scenario({ ...small, ...thrash, complete: 19_000 });
 expect(r.measured!.complete, r.probe).toBe(19_000);
 expect(r.faults, r.probe).toEqual([]);
 expect(r.aborts, r.probe).toBe(0);
 expect(r.cuts, r.probe).toBe(0);
 expect(r.guard[1], r.probe).toBe(19_000);
 expect(r.last?.stopReason, r.probe).toBe('stop');
});

test('without thrash the same request cuts at the band, as in 1.7.0', async () => {
 const r = await scenario({ ...small, complete: 19_000 });
 expect(r.faults, r.probe).toEqual([]);
 expect(r.cuts, r.probe).toBe(1);
 expect(r.guard[1], r.probe).toBeLessThanOrEqual(BAND);
});

test('thrashing: a request past keepRecentTokens cuts to the band', async () => {
 const r = await scenario({ ...small, ...thrash, complete: 20_001 });
 expect(r.faults, r.probe).toEqual([]);
 expect(r.cuts, r.probe).toBe(1);
 const receipt = receiptOf(r.entries[0]!);
 expect(receipt.reason, r.probe).toBe('tool-loop');
 expect(receipt.target, r.probe).toBe('band');
 expect(r.guard[1], r.probe).toBeLessThanOrEqual(BAND);
 expect(r.last?.stopReason, r.probe).toBe('stop');
});

test('thrashing, keepRecentTokens below the room: the trigger stays the band, as native cuts at window - reserve', async () => {
 for (const [complete, cuts] of [[BAND - 1, 0], [BAND, 1]] as const) {
  const r = await scenario({ ...small, ...thrash, keepRecent: 3_000, complete });
  expect(r.faults, r.probe).toEqual([]);
  expect(r.cuts, r.probe).toBe(cuts);
 }
});

test('thrashing, keepRecentTokens past the hard line: the trigger is capped at the hard line less the margin', async () => {
 const cap = WINDOW - await piContextSafetyMargin() - 3_584 - MARGIN;
 for (const [complete, cuts] of [[21_000, 0], [cap + 1, 1]] as const) {
  const r = await scenario({ ...small, ...thrash, keepRecent: 60_000, complete });
  expect(r.faults, r.probe).toEqual([]);
  expect(r.cuts, r.probe).toBe(cuts);
 }
});

test('thrashing after a length stop: the cap keeps 1.7.0\'s raised reply room', async () => {
 const margin = await piContextSafetyMargin(), output = 5_000, raised = 2 * output;
 const capped = WINDOW - margin - raised - MARGIN, floorOnly = WINDOW - margin - output - MARGIN;
 expect(capped).toBeGreaterThan(BAND + 1);
 for (const [complete, cuts] of [[capped - 1, 0], [capped + 1, 1]] as const) {
  const r = await scenario({ ...small, thrash: { lengthStopOutput: output }, keepRecent: 60_000, complete });
  expect(r.faults, r.probe).toEqual([]);
  expect(r.cuts, r.probe).toBe(cuts);
 }
 expect(floorOnly).toBeGreaterThan(capped + 1);
});

test('an explicit cutAt keeps the band trigger while thrashing', async () => {
 const r = await scenario({ ...small, ...thrash, cutAtDefault: false, compaction: { requestReserve: undefined, cutAt: 1 }, complete: 19_000 });
 expect(r.faults, r.probe).toEqual([]);
 expect(r.cuts, r.probe).toBe(1);
});

const reply = (content: unknown[], stopReason = 'toolUse') => ({ type: 'message', message: { role: 'assistant', content, stopReason, api: 'a', provider: 'p', model: 'm', timestamp: 0,
 usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });
const readCall = (id: string, path = 'a.ts', extra: Record<string, unknown> = {}) => reply([{ type: 'toolCall', id, name: 'read', arguments: { path, ...extra } }]);
const result = (id: string, text: string, isError = false) => ({ type: 'message', message: { role: 'toolResult', toolCallId: id, toolName: 'read', isError, content: [{ type: 'text', text }], timestamp: 0 } });
const cut = { type: 'compaction' };
const text = reply([{ type: 'text', text: 'working' }], 'stop');
const branch = (...entries: unknown[]) => entries as SessionEntry[];

test('thrash counts unchanged re-reads soon after a cut, per cut', () => {
 expect(thrashing(branch())).toBe(false);
 // No cut: repeated reads are not thrash.
 expect(thrashing(branch(readCall('1'), result('1', 'x'), readCall('2'), result('2', 'x')))).toBe(false);
 // One cut, one re-read of the same unchanged text right after it.
 expect(thrashing(branch(readCall('1'), result('1', 'x'), cut, readCall('2'), result('2', 'x')))).toBe(true);
 // The file changed: the agent reads new content, which is not thrash.
 expect(thrashing(branch(readCall('1'), result('1', 'x'), cut, readCall('2'), result('2', 'y')))).toBe(false);
 // A different range is a different read.
 expect(thrashing(branch(readCall('1'), result('1', 'x'), cut, readCall('2', 'a.ts', { offset: 5 }), result('2', 'x')))).toBe(false);
 // Too late after the cut: three other replies first.
 expect(thrashing(branch(readCall('1'), result('1', 'x'), cut, text, text, text, readCall('2'), result('2', 'x')))).toBe(false);
 // A failed re-read does not count.
 expect(thrashing(branch(readCall('1'), result('1', 'x'), cut, readCall('2'), result('2', 'x', true)))).toBe(false);
 // Re-read within the same segment (no cut between the reads) does not count.
 expect(thrashing(branch(cut, readCall('1'), result('1', 'x'), readCall('2'), result('2', 'x')))).toBe(false);
 // The bar is per cut: one re-read over three cuts is below 0.5; two over three reaches it.
 const once = branch(readCall('1'), result('1', 'x'), cut, readCall('2'), result('2', 'x'), cut, text, cut, text);
 expect(thrashing(once)).toBe(false);
 const twice = branch(readCall('1'), result('1', 'x'), cut, readCall('2'), result('2', 'x'), cut, readCall('3'), result('3', 'x'), cut, text);
 expect(thrashing(twice)).toBe(true);
});
