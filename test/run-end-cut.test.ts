import { test, expect } from 'vitest';
import { BAND, HOST, harness, receiptOf, scenario } from './budget-fixture';

// When a run ends at or above the band, the compactor cuts there, so the next prompt starts below it. The prompt's own cut is Pi's, bound
// by keepRecentTokens: right after a cut Pi has nothing to compact, and a large prompt could then be refused.

test('a run that ends below the band is not cut', async () => {
 const r = await scenario({ at: 'prompt', complete: BAND - 2000, host: HOST });
 expect(r.faults, r.probe).toEqual([]);
 expect(r.cuts, r.probe).toBe(0);
 expect(r.runEnd, r.probe).toEqual([]);
});

test('a run that ends inside the band where Pi had nothing to compact is cut at its end, below the band', async () => {
 const h = await harness({ at: 'prompt', complete: BAND + 500, host: HOST, compactedLast: true });
 try {
  const r = await h.run();
  expect(r.faults, r.probe).toEqual([]);
  expect(r.cuts, r.probe).toBe(0); // Pi had nothing to compact for the prompt
  expect(r.runEnd.length, r.probe).toBe(1);
  const receipt = receiptOf(r.runEnd[0]!);
  expect(receipt.reason).toBe('run-end');
  expect(receipt.tokensAfter + receipt.mandatoryInputTokens!, r.probe).toBeLessThan(BAND);
  // The cut is committed: it is the session's latest compaction, and what follows it fits under the band.
  expect(h.manager.getEntries().findLast(e => e.type === 'compaction')?.id).toBe(r.runEnd[0]!.id);
 } finally { await h.cleanup(); }
});

test('a run-end cut that cannot reach the band is no cut and no fault', async () => {
 // An irreducible request inside the band: the prompt, protected from every cut, holds nearly all of it.
 const r = await scenario({ at: 'tool', complete: BAND + 2000, host: HOST, history: 1500, fresh: 100 });
 expect(r.faults, r.probe).toEqual([]);
 expect(r.runEnd, r.probe).toEqual([]);
});
