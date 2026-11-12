import { expect, test } from 'vitest';
import { bandOf, DEFAULT_CUT_AT } from '../src/budget';
import { HOST, ROOM, expectParity, harness, receiptOf, scenario } from './budget-fixture';

// Exercise both explicit cut points and the installed default. The first prompt stays below the band,
// so a tool test cannot accidentally pass because that prompt already compacted the history.
for (const cutAt of [1, 0.6, undefined]) {
 const band = bandOf(ROOM, cutAt ?? DEFAULT_CUT_AT);
 const options = { host: HOST, ...(cutAt === undefined ? { cutAtDefault: true } : { compaction: { cutAt } }) };
 const label = cutAt === undefined ? 'default' : `cutAt ${cutAt}`;
 const fresh = ROOM - band + 6000;

 test(`a tool boundary inside the band and under the room sends the whole request without cutting (${label})`, async () => {
  for (const complete of [band, Math.floor((band + ROOM) / 2), ROOM - 1]) {
   const r = await scenario({ ...options, at: 'tool', complete, fresh });
   expect(r.measured!.complete, r.probe).toBe(complete);
   expect(r.probes[0]!.complete, r.probe).toBeLessThan(band);
   expect(r.cuts, r.probe).toBe(0);
   expect(r.cutsAtRequest, r.probe).toEqual([0, 0]);
   expect(r.guard[1], r.probe).toBe(complete);
   expect(r.requests, r.probe).toBe(2);
   expect(r.effects, r.probe).toBe(1);
   expect(r.faults, r.probe).toEqual([]);
   expect(r.last?.stopReason, r.probe).toBe('stop');
  }
 });

 test(`a tool boundary at or over the room cuts before sending the request (${label})`, async () => {
  for (const complete of [ROOM, ROOM + 1, ROOM + 500]) {
   const r = await scenario({ ...options, at: 'tool', complete, fresh });
   expect(r.measured!.complete, r.probe).toBe(complete);
   expect(r.probes[0]!.complete, r.probe).toBeLessThan(band);
   expect(r.cuts, r.probe).toBe(1);
   expect(receiptOf(r.entries[0]!).reason, r.probe).toBe('tool-loop');
   expect(r.cutsAtRequest, r.probe).toEqual([0, 1]);
   expect(r.requests, r.probe).toBe(2);
   expect(r.effects, r.probe).toBe(1);
   expect(r.faults, r.probe).toEqual([]);
   for (const guarded of r.guard) expect(guarded, r.probe).toBeLessThan(ROOM);
   expectParity(r, { host: HOST }, { room: ROOM, band });
  }
 });

 test(`a prompt inside the band still cuts before its request (${label})`, async () => {
  const r = await scenario({ ...options, at: 'prompt', complete: band + 100 });
  expect(r.measured!.complete, r.probe).toBe(band + 100);
  expect(r.cuts, r.probe).toBe(1);
  expect(receiptOf(r.entries[0]!).reason, r.probe).toBe('prompt');
  expect(r.requests, r.probe).toBe(1);
  expect(r.faults, r.probe).toEqual([]);
  expectParity(r, { host: HOST, incoming: 2 }, { room: ROOM, band });
 });

 test(`run end inside the band still saves a cut after the final request (${label})`, async () => {
  const h = await harness({ ...options, at: 'tool', complete: band + 500, fresh: 6000, rounds: 2, laterResult: 100 });
  try {
   const r = await h.run();
   expect(r.measured!.complete, r.probe).toBe(band + 500);
   expect(r.probes[0]!.complete, r.probe).toBeLessThan(band);
   expect(r.cuts, r.probe).toBe(0);
   expect(r.cutsAtRequest, r.probe).toEqual([0, 0, 0]);
   expect(r.requests, r.probe).toBe(3);
   expect(r.effects, r.probe).toBe(2);
   expect(r.faults, r.probe).toEqual([]);
   for (const guarded of r.guard.slice(1)) {
    expect(guarded, r.probe).toBeGreaterThanOrEqual(band);
    expect(guarded, r.probe).toBeLessThan(ROOM);
   }
   expect(r.runEnd, r.probe).toHaveLength(1);
   const entry = r.runEnd[0]!, receipt = receiptOf(entry);
   expect(receipt.reason, r.probe).toBe('run-end');
   expect(receipt.target, r.probe).toBe('band');
   expect(receipt.tokensAfter + receipt.mandatoryInputTokens!, r.probe).toBeLessThan(band);
   expect(h.manager.getEntries().findLast(e => e.type === 'compaction')?.id, r.probe).toBe(entry.id);
  } finally { await h.cleanup(); }
 });
}
