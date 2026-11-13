import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { bandOf, conversationTokens, DEFAULT_CUT_AT } from '../src/budget';
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

 test(`growth past the hard line carries one guard cut and saves it at the next boundary (${label})`, async () => {
  // An omitted summary quote makes the request's saved conversation differ from its raw session projection.
  for (const summary of [false, true]) {
   const wire: string[] = [];
   const h = await harness({ ...options, at: 'tool', complete: ROOM - 500, fresh, rounds: 2, laterResult: 100,
    summary, ...(summary ? { omitted: 400 } : {}), persist: true,
    afterDecision: (index, api) => { if (index === 1) api.growHost(1000); },
    onWire: context => { wire.push(JSON.stringify(context)); },
   });
   try {
    const r = await h.run();
    expect(r.measured!.complete, r.probe).toBe(ROOM - 500);
    expect(r.probes[0]!.complete, r.probe).toBeLessThan(band);
    expect(r.cuts, r.probe).toBe(1);
    expect(r.cutsAtRequest, r.probe).toEqual([0, 0, 1].map(n => n + Number(summary)));
    expect(r.requests, r.probe).toBe(3);
    expect(r.effects, r.probe).toBe(2);
    expect(r.faults, r.probe).toEqual([]);
    expect(r.last?.stopReason, r.probe).toBe('stop');
    expect(wire[1], r.probe).toContain('TUCK-TRANSCRIPT/2');
    const entry = r.entries[0]!, receipt = receiptOf(entry);
    expect(receipt.reason, r.probe).toBe('tool-loop');
    expect(receipt.hostInputTokens, r.probe).toBe(HOST + 1000);
    const before = (entry.details as { diagnosticReceipt: { before: { value: number } } }).diagnosticReceipt.before.value;
    expect(before + receipt.mandatoryInputTokens!, r.probe).toBeGreaterThanOrEqual(ROOM);
    expect(receipt.tokensAfter + receipt.mandatoryInputTokens!, r.probe).toBe(r.guard[1]);
    for (const guarded of r.guard) expect(guarded, r.probe).toBeLessThan(ROOM);
    expect(h.manager.getBranch().some(e => e.type === 'compaction' && e.id === entry.id), r.probe).toBe(true);
    const persisted = readFileSync(h.manager.getSessionFile()!, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(persisted.find(e => e.id === entry.id)?.details, r.probe).toEqual(entry.details);
   } finally { await h.cleanup(); }
  }
 });

 test(`growth past the hard line keeps the original refusal when no cut can fit (${label})`, async () => {
  const r = await scenario({ ...options, at: 'tool', complete: ROOM - 500, fresh,
   afterDecision: (index, api) => { if (index === 1) api.growHost(ROOM); },
  });
  expect(r.measured!.complete, r.probe).toBe(ROOM - 500);
  expect(r.cuts, r.probe).toBe(0);
  expect(r.cutsAtRequest, r.probe).toEqual([0, 0]);
  expect(r.requests, r.probe).toBe(1);
  expect(r.effects, r.probe).toBe(1);
  expect(r.faults, r.probe).toEqual(['Error: Complete Pi context and response reserve exceed the estimated request budget']);
  expect(r.guard[1], r.probe).toBeGreaterThanOrEqual(ROOM);
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

test('a guard cut above the standalone room preserves the real Pi reply floor', async () => {
 let before = 0;
 const h = await harness({ at: 'tool', complete: 16000, systemTokens: 6000, host: 200, history: 4000, fresh: 5000,
  rounds: 2, laterResult: 100, limits: { contextWindow: 32768, maxTokens: 8192 }, reserveTokens: 16384,
  usageRatio: 0.873, piRequestPath: true, compaction: { requestReserve: undefined },
  afterDecision: (index, api) => { if (index === 1) api.growHost(12000); },
  onBoundary: event => { if (!before) before = conversationTokens(event.context.contextMessages); },
 });
 try {
  const r = await h.run();
  expect(r.measured!.complete, r.probe).toBe(16000);
  expect(r.cutsAtRequest.slice(0, 2), r.probe).toEqual([0, 0]);
  const entry = r.entries.find(entry => receiptOf(entry).reason === 'tool-loop');
  expect(entry, r.probe).toBeDefined();
  expect((entry!.details as { diagnosticReceipt: { before: { value: number } } }).diagnosticReceipt.before.value, r.probe).toBe(before);
  expect(h.state.clips, r.probe).toBeGreaterThan(0);
  expect(r.guard[1], r.probe).toBeGreaterThan(16384);
  expect(r.requests, r.probe).toBe(3);
  expect(r.faults, r.probe).toEqual([]);
  for (const request of h.state.requestOptions) {
   expect(request.baseMaxTokens, r.probe).toBeGreaterThanOrEqual(3584);
   expect(request.maxTokens, r.probe).toBeGreaterThanOrEqual(3584);
  }
  expect(h.state.clampStops, r.probe).toBe(0);
  expect(r.last?.stopReason, r.probe).toBe('stop');
 } finally { await h.cleanup(); }
});
