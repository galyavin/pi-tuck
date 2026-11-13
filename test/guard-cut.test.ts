import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { bandOf, DEFAULT_CUT_AT } from '../src/budget';
import { HOST, ROOM, harness, receiptOf, scenario } from './budget-fixture';

// Input that lands after a tool boundary has decided (a host injection, a steering message) is invisible to that decision. When it lifts the
// next request over the hard line, the final guard cuts instead of refusing, carries the cut in that request, and the next boundary saves it.
// The boundary here sits below the band, so even the early band cut does not fire: this is the abort 1.0.29 had whenever late input was
// larger than the gap between its band and the room.
for (const cutAt of [1, 0.6, undefined]) {
 const label = cutAt === undefined ? 'installed default' : `cutAt ${cutAt}`;
 const options = cutAt === undefined ? { cutAtDefault: true } : { compaction: { cutAt } };
 const band = bandOf(ROOM, cutAt ?? DEFAULT_CUT_AT);
 const fresh = 2000, late = ROOM - band + 1500; // late input past the gap between the band and the room

 test(`late growth past the hard line carries one guard cut, saved at the next boundary (${label})`, async () => {
  for (const summary of [false, true]) {
   const h = await harness({ ...options, at: 'tool', host: HOST, complete: band - 300, fresh, rounds: 2, laterResult: 100,
    summary, ...(summary ? { omitted: 400 } : {}), persist: true,
    afterDecision: (index, api) => { if (index === 1) api.growHost(late); },
   });
   try {
    const r = await h.run();
    expect(r.probes[0]!.complete, r.probe).toBeLessThan(band);
    expect(r.faults, r.probe).toEqual([]);
    expect(r.cuts, r.probe).toBe(1);
    expect(r.requests, r.probe).toBe(3);
    expect(r.last?.stopReason, r.probe).toBe('stop');
    const entry = r.entries[0]!, receipt = receiptOf(entry);
    expect(receipt.reason, r.probe).toBe('tool-loop');
    expect(receipt.tokensAfter + receipt.mandatoryInputTokens!, r.probe).toBe(r.guard[1]);
    for (const guarded of r.guard) expect(guarded, r.probe).toBeLessThan(ROOM);
    const persisted = readFileSync(h.manager.getSessionFile()!, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(persisted.find(e => e.id === entry.id)?.details, r.probe).toEqual(entry.details);
   } finally { await h.cleanup(); }
  }
 });

 test(`late growth that no cut can fit keeps the original refusal (${label})`, async () => {
  const r = await scenario({ ...options, at: 'tool', host: HOST, complete: band - 300, fresh,
   afterDecision: (index, api) => { if (index === 1) api.growHost(ROOM); },
  });
  expect(r.cuts, r.probe).toBe(0);
  expect(r.faults, r.probe).toEqual(['Error: Complete Pi context and response reserve exceed the estimated request budget']);
 });
}
