import { test, expect } from 'vitest';
import { BAND, HOST, ROOM, harness, scenario } from './budget-fixture';

// One snapshot per decision: the host messages, the system part and the queued messages are taken once and reused for the whole
// decision (the trigger, the planner, the post-cut check). The incoming prompt re-takes the snapshot after its awaited cut, because
// the cut ran in between. The counter is a spy on the host builder.
const cases: { name: string; at: 'prompt' | 'tool'; complete: number; calls: number }[] = [
 { name: 'prompt, no cut: one decision', at: 'prompt', complete: BAND - 5000, calls: 1 },
 { name: 'prompt, opportunistic cut: the decision and the snapshot after the cut', at: 'prompt', complete: BAND + 100, calls: 2 },
 { name: 'prompt, forced cut: the decision and the snapshot after the cut', at: 'prompt', complete: ROOM + 500, calls: 2 },
 { name: 'tool boundary, no cut: the prompt and the tool boundary, one each', at: 'tool', complete: BAND - 5000, calls: 2 },
 { name: 'tool boundary, opportunistic cut: planning and the post-cut check use the same snapshot', at: 'tool', complete: BAND + 100, calls: 2 },
 { name: 'tool boundary, forced cut', at: 'tool', complete: ROOM + 500, calls: 2 },
];
for (const c of cases)
test(`the host builder is called once per decision: ${c.name}`, async () => {
 const r = await scenario({ at: c.at, complete: c.complete, host: HOST });
 expect(r.faults, r.probe).toEqual([]);
 expect(r.hostCalls, r.probe).toBe(c.calls);
});

test('the host builder is called once for a tool boundary where the cut falls back from the band to the room (two plans, one snapshot)', async () => {
 const r = await scenario({ at: 'tool', host: HOST, history: 1500, fresh: 3500, complete: ROOM + 200 });
 expect(r.cuts, r.probe).toBe(1);
 expect(r.hostCalls, r.probe).toBe(2);
});

test('an operator cut takes one snapshot', async () => {
 const h = await harness({ at: 'prompt', complete: 60000, host: HOST });
 try {
  await h.session.compact();
  expect(h.compactions()).toHaveLength(1);
  expect(h.state.hostCalls).toBe(1);
 } finally { await h.cleanup(); }
});

test('a snapshot is not reused across decisions: host input that grows between boundaries is counted at the next one', async () => {
 // Below the band at the first boundary; the view then grows past the band by itself before the next one (effects recorded in it).
 // The second request is answered with a tool call again, and its boundary is where the grown view is counted.
 const r = await scenario({ at: 'tool', complete: BAND - 3000, host: HOST, rounds: 2, laterResult: 100, onRequest: (request, { setHost }) => { if (request === 2) setHost(HOST + 4000); } });
 expect(r.faults, r.probe).toEqual([]);
 expect(r.cuts, r.probe).toBe(1);
 expect(r.entries.map(e => (e.details as { diagnosticReceipt: { settings: { hostInputTokens: number } } }).diagnosticReceipt.settings.hostInputTokens), r.probe).toEqual([HOST + 4000]);
 expect(r.hostCalls, r.probe).toBe(3); // the prompt, and one for each tool boundary
});

test('standalone Pi: without hostMessages the triggers count no host input, and the guard still counts the request as it is', async () => {
 // The host's context hook still injects a view in this fixture; a standalone installation has none, so a trigger cannot know of it.
 const r = await scenario({ at: 'tool', complete: BAND + 100, host: HOST, compaction: { hostMessages: undefined } });
 expect(r.faults, r.probe).toEqual([]);
 expect(r.cuts, r.probe).toBe(0); // the host-free measure is HOST tokens below the band
 expect(r.requests, r.probe).toBe(2);
 expect(r.guard.at(-1)!, r.probe).toBeGreaterThanOrEqual(BAND);
 expect(r.guard.at(-1)!, r.probe).toBeLessThan(ROOM);
});
