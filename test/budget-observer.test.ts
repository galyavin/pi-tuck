import { expect, test } from 'vitest';
import { harness } from './budget-fixture';

test('the budget observer does not change prepared request bytes or host input calls', async () => {
 const run = async (observe: boolean) => {
  const requests: unknown[] = []; let checks = 0;
  const h = await harness({ at: 'prompt', complete: 0, noHistory: true, noOpening: true, stableHost: true, host: 200, systemTokens: 800,
   limits: { contextWindow: 65536, maxTokens: 8192 }, reserveTokens: 16384,
   toolCalls: n => n === 1, toolResultTokens: () => 200, onWire: ctx => requests.push(structuredClone(ctx)),
   compaction: { requestReserve: undefined, observeBudget: observe ? m => { checks++; expect(m.tokens).toBe(Math.ceil(m.rawTokens * m.factor)); } : undefined } });
  try {
   await h.session.prompt('Whole prompt with a complete task');
   expect(h.faults).toEqual([]);
   expect(checks > 0).toBe(observe);
   return { requests: requests.map(r => JSON.stringify(r, (k,v) => k === 'timestamp' || k === 'durationMs' ? undefined : v).replaceAll(h.dir, '<session>')), hostCalls: h.state.hostCalls };
  } finally { await h.cleanup(); }
 };
 expect(await run(true)).toEqual(await run(false));
});
