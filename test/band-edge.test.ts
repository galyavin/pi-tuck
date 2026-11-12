import { test, expect } from 'vitest';
import { BAND, HOST, ROOM, expectParity, harness, receiptOf, scenario } from './budget-fixture';

const PROMPT = 2; // 'Continue'

// Prompts cut at the band, 2% before the room; tool boundaries wait for the room. Walk both edges token by token.
// At a prompt, a cut inside the band is opportunistic: it is taken when it can reach the band; when it cannot, nothing happens and the request
// goes to the guard, which admits it. Above the room nothing changes: the request is cut or the attempt fails closed.
const AROUND = [-30, -20, -10, -5, -3, -2, -1, 0, 1, 2, 3, 5, 10, 20, 30];

for (const at of ['prompt', 'tool'] as const)
test(`${at} boundary: only a prompt cuts from the first token inside the band`, async () => {
 const seen: { d: number; cuts: number }[] = [];
 for (const d of AROUND) {
  const r = await scenario({ at, complete: BAND + d, host: HOST });
  expect(r.measured!.complete, r.probe).toBe(BAND + d);
  expect(r.faults, r.probe).toEqual([]);
  expect(r.requests, r.probe).toBe(at === 'tool' ? 2 : 1);
  for (const guarded of r.guard) expect(guarded, r.probe).toBeLessThan(ROOM);
  // The cut lands below the band, with the same arithmetic the guard sees.
  for (const entry of r.entries) expect(receiptOf(entry).tokensAfter + receiptOf(entry).mandatoryInputTokens!, r.probe).toBeLessThan(BAND);
  expectParity(r, { host: HOST, incoming: at === 'prompt' ? PROMPT : 0 });
  seen.push({ d, cuts: r.cuts });
 }
 const probe = JSON.stringify(seen);
 for (const s of seen) expect(s.cuts > 0, probe).toBe(at === 'prompt' && s.d >= 0);
});

for (const at of ['prompt', 'tool'] as const)
test(`${at} boundary: around the room the request is cut and sent, never rejected`, async () => {
 for (const d of AROUND) {
  const r = await scenario({ at, complete: ROOM + d, host: HOST });
  expect(r.measured!.complete, r.probe).toBe(ROOM + d);
  expect(r.faults, r.probe).toEqual([]);
  expect(r.cuts, r.probe).toBe(at === 'prompt' || d >= 0 ? 1 : 0);
  expect(r.requests, r.probe).toBe(at === 'tool' ? 2 : 1);
  for (const guarded of r.guard) expect(guarded, r.probe).toBeLessThan(ROOM);
  expectParity(r, { host: HOST, incoming: at === 'prompt' ? PROMPT : 0 });
 }
});

// An irreducible request: a large prompt (protected from every cut), a little old history, a tiny tool result. The best cut removes
// only the old history, so it reaches the band only when the request is within that reduction of it.
const IRREDUCIBLE = { at: 'tool' as const, host: HOST, history: 1500, fresh: 100 };

test('inside the band, a cut that can reach the band is taken; one that cannot is no cut and no fault, and the request is sent', async () => {
 // Find, by bisection, how deep into the band a cut is still taken: it removes the old history, and it is taken only while the exact room
 // could plan a cut with the same summary view. Beyond that depth nothing is done and nothing must happen.
 const run = async (d: number) => {
  const h = await harness({ at: 'prompt', host: HOST, history: IRREDUCIBLE.history, complete: BAND + d });
  try { return { ...await h.run(), incoming: h.promptTokens() }; } finally { await h.cleanup(); }
 };
 let reach = 0, beyond = ROOM - BAND - 1;
 expect((await run(reach)).cuts).toBe(1);
 expect((await run(beyond)).cuts).toBe(0);
 while (beyond - reach > 1) { const middle = Math.floor((reach + beyond) / 2); if ((await run(middle)).cuts) reach = middle; else beyond = middle; }
 expect(reach, 'depth of the best cut').toBeGreaterThan(500);
 expect(beyond, 'depth of the best cut').toBeLessThan(2500);
 const seen: { d: number; cuts: number }[] = [];
 for (const d of [0, 100, reach - 1, reach, beyond, beyond + 1, beyond + 100, 2000, 2800, ROOM - BAND - 1]) {
  const r = await run(d);
  expect(r.measured!.complete, r.probe).toBe(BAND + d);
  expect(r.faults, r.probe).toEqual([]);
  expect(r.requests, r.probe).toBe(1); expect(r.effects, r.probe).toBe(0);
  // Sent as it stands or cut to below the band: either way the guard admitted every request.
  for (const guarded of r.guard) expect(guarded, r.probe).toBeLessThan(ROOM);
  for (const entry of r.entries) expect(receiptOf(entry).tokensAfter + receiptOf(entry).mandatoryInputTokens!, r.probe).toBeLessThan(BAND);
  for (const entry of r.entries) expect(receiptOf(entry).reason, r.probe).toBe('prompt');
  expectParity(r, { host: HOST, incoming: r.incoming });
  seen.push({ d, cuts: r.cuts });
 }
 const probe = JSON.stringify({ reach, beyond, seen });
 for (const s of seen) expect(s.cuts > 0, probe).toBe(s.d <= reach);
});

test('a plan-bound cut inside the band: no commit and no fault at the boundary, and none at the boundaries after it (nothing thrashes)', async () => {
 // The request sits 2000 tokens inside the band and the best cut cannot bring it under the band. Three more tool rounds each add
 // about a hundred tokens and stay inside the band. Not one is a cut, a fault or a rejection.
 const r = await scenario({ ...IRREDUCIBLE, complete: BAND + 2000, rounds: 3, laterResult: 100 });
 expect(r.measured!.complete, r.probe).toBe(BAND + 2000);
 expect(r.cuts, r.probe).toBe(0);
 expect(r.faults, r.probe).toEqual([]);
 expect(r.requests, r.probe).toBe(4); expect(r.effects, r.probe).toBe(3);
 // Every request was in the band, below the tool due line, and the guard passed it.
 expect(r.guard.length, r.probe).toBe(4);
 for (const guarded of r.guard) { expect(guarded, r.probe).toBeGreaterThanOrEqual(BAND); expect(guarded, r.probe).toBeLessThan(ROOM); }
});

test('above the room, with the band plan failing and the room plan succeeding, the cut falls back to the room and is no fault', async () => {
 // The same irreducible request, 200 tokens over the room: the best cut cannot reach the band but reaches the room.
 const r = await scenario({ ...IRREDUCIBLE, fresh: 3500, complete: ROOM + 200 });
 expect(r.measured!.complete, r.probe).toBe(ROOM + 200);
 expect(r.faults, r.probe).toEqual([]);
 expect(r.cuts, r.probe).toBe(1);
 const entry = receiptOf(r.entries[0]!);
 expect(entry.target, r.probe).toBe('room');
 // It lands in [band, room): that is why the band plan failed, and why the next boundary does nothing (see the test above).
 expect(entry.tokensAfter + entry.mandatoryInputTokens!, r.probe).toBeGreaterThanOrEqual(BAND);
 expect(entry.tokensAfter + entry.mandatoryInputTokens!, r.probe).toBeLessThan(ROOM);
 expect(r.requests, r.probe).toBe(2);
 expect(r.guard.at(-1)!, r.probe).toBeLessThan(ROOM);
 expectParity(r, { host: HOST });
});

// Right after a cut, Pi has nothing to compact ("Already compacted"). A prompt's cut is pi-tuck's own, so a prompt there is cut like any other.
test('a prompt right after a cut inside the band: no fault, and the request is sent within the room', async () => {
 const r = await scenario({ at: 'prompt', complete: BAND + 500, host: HOST, compactedLast: true });
 expect(r.measured!.complete, r.probe).toBe(BAND + 500);
 expect(r.faults, r.probe).toEqual([]);
 expect(r.requests, r.probe).toBe(1);
 expect(r.guard[0], r.probe).toBeLessThan(ROOM);
});

// Before 1.0.10 Pi's "nothing to compact" refused a request that needed a cut right after one (R&D's clip replay of eval live32 t03-B: a
// 6k-token prompt after short exchanges). pi-tuck now makes that cut: the request and the next prompt are answered.
test('a cut needed right after a cut is made: the request is answered, and so is the next prompt', async () => {
	const h = await harness({ at: 'prompt', complete: ROOM + 500, host: HOST, compactedLast: true });
	try {
		const over = await h.run();
		expect(over.faults, over.probe).toEqual([]);
		expect(over.requests, over.probe).toBe(1);
		for (const guarded of over.guard) expect(guarded, over.probe).toBeLessThan(ROOM);
		const requests = h.state.requests;
		await h.session.prompt('A short prompt');
		expect(h.faults, over.probe).toEqual([]);
		expect(h.state.requests - requests, over.probe).toBe(1);
	} finally { await h.cleanup(); }
}, 120000);
