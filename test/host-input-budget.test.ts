import { test, expect } from 'vitest';
import { BAND, HOST, ROOM, expectParity, scenario } from './budget-fixture';

const PROMPT = 2; // 'Continue'

// Triggers and the complete-context guard count one request: the same arithmetic for host input, summary wrapper and queued messages
// (in a synthetic host scenario the guard rejected a request by 26 estimated tokens after the tool-boundary trigger
// judged it to fit). A host (AB1) adds input to every request that is not in the saved conversation: its role view and guidance. It
// hands the package the exact messages its `context` hook injects (`hostMessages`), and the package counts them with the same function
// that counts the request in the guard, so a request the guard would reject is cut first, never rejected with no cut. The system prompt
// here is larger than the host input, as in AB1 (32.8k against 2.9k). Window 272,000 and response reserve max(32,768, model.maxTokens
// 128,000) leave an input room of 144,000 estimated tokens. A cut is triggered 2% of the room early (the band); inside the band it is
// opportunistic, so these sweeps are walked around the band as well as around the room.
//
// `complete` is the reference measure of the request (host input included, queued messages not), computed by the fixture from Pi's own
// functions, and the fixture lands it exactly. Host input is HOST tokens: a trigger that left it out would believe the request
// is HOST tokens smaller than the guard counts it.
const cases: { name: string; at: 'prompt' | 'tool'; complete: number; cut: boolean }[] = [];
for (const at of ['prompt', 'tool'] as const) cases.push(
 { name: `${at}, far below the band`, at, complete: BAND - 25000, cut: false },
 { name: `${at}, one token below the band`, at, complete: BAND - 1, cut: false },
 { name: `${at}, the first token inside the band`, at, complete: BAND, cut: true },
 { name: `${at}, the middle of the band`, at, complete: Math.floor((BAND + ROOM) / 2), cut: true },
 { name: `${at}, one token below the room`, at, complete: ROOM - 1, cut: true },
 { name: `${at}, at the room`, at, complete: ROOM, cut: true },
 { name: `${at}, above the room`, at, complete: ROOM + 3000, cut: true },
);

for (const c of cases)
test(`cut triggers and the complete-context guard count the same request, host input included: ${c.name}`, async () => {
 const r = await scenario({ at: c.at, complete: c.complete, host: HOST });
 // Calibration: the case really sits where it says, by the request as the guard counts it.
 expect(r.measured, r.probe).toBeDefined();
 expect(r.measured!.complete, r.probe).toBe(c.complete);
 // A request the guard would reject is cut first and then sent; one it admits below the band is sent as it stands. Never a rejection.
 expect(r.faults, r.probe).toEqual([]);
 expect(r.cuts > 0, r.probe).toBe(c.cut);
 expect(r.requests, r.probe).toBe(c.at === 'tool' ? 2 : 1);
 if (c.at === 'tool') expect(r.effects, r.probe).toBe(1);
 // Every request the guard saw fits the room, cut or not.
 for (const guarded of r.guard) expect(guarded, r.probe).toBeLessThan(ROOM);
 // And the cut was planned on the very number the guard then counted.
 expectParity(r, { host: HOST, incoming: c.at === 'prompt' ? PROMPT : 0 });
});

test('mandatory input that cannot fit even with no history fails closed at the guard, with no cut and no request', async () => {
 // System prompt and tools plus host input exceed the room by themselves: no cut can help, and the guard is untouched.
 const r = await scenario({ at: 'impossible', complete: 20000, host: ROOM + 20000 });
 expect(r.faults.join(' '), r.probe).toContain('Complete Pi context and response reserve exceed the estimated request budget');
 expect(r.requests, r.probe).toBe(0); expect(r.effects, r.probe).toBe(0); expect(r.cuts, r.probe).toBe(0);
});

test('mandatory input that outgrows the room during a run fails closed at the guard of the next request, with no cut', async () => {
 // Host input grows past the room after the first round (as attempt effects accumulate in AB1's view). At the tool boundary no
 // cut can help, so the trigger defers; the guard rejects the second request. The first request and its effect already happened.
 const r = await scenario({ at: 'tool-impossible', complete: 20000, host: HOST });
 expect(r.faults.join(' '), r.probe).toContain('Complete Pi context and response reserve exceed the estimated request budget');
 expect(r.requests, r.probe).toBe(1); expect(r.effects, r.probe).toBe(1); expect(r.cuts, r.probe).toBe(0);
});

test('a compaction summary in the conversation: across the width of Pi\'s summary wrapper the trigger and the guard agree to the token', async () => {
 // Pi wraps a summary when it converts the conversation for the model, so the raw message is smaller than what is sent. A trigger that
 // counts the raw message (about 27 estimated tokens less) believes a request fits that the guard counts above the line. Walk the
 // request across the band, token by token near its edge: it is cut exactly from the band on, never later.
 const results: { distance: number; cuts: number }[] = [];
 for (const distance of [-48, -40, -32, -28, -27, -26, -20, -12, -8, -4, -3, -2, -1, 0, 1, 2, 3, 4, 8, 12]) {
  const r = await scenario({ at: 'tool', complete: BAND + distance, host: HOST, summary: true });
  expect(r.faults, r.probe).toEqual([]);
  expect(r.requests, r.probe).toBe(2); expect(r.effects, r.probe).toBe(1);
  expect(r.measured!.complete, r.probe).toBe(BAND + distance);
  results.push({ distance, cuts: r.cuts });
 }
 const probe = JSON.stringify(results);
 for (const r of results) expect(r.cuts > 0, probe).toBe(r.distance >= 0);
});

for (const c of [
 { name: 'fits with them: sent as it stands', complete: BAND - 3000 - 1, cut: false },
 { name: 'reaches the band with them: cut first, then sent', complete: BAND - 3000, cut: true },
 { name: 'does not fit with them: cut first, then sent', complete: ROOM - 1500, cut: true },
])
test(`messages queued at the tool boundary are part of the next request: ${c.name}`, async () => {
 const r = await scenario({ at: 'tool', complete: c.complete, host: HOST, queued: 3000 });
 // Calibration: without the queued message the request is below the band; the trigger counts the queued message as the guard does.
 expect(r.measured!.complete, r.probe).toBe(c.complete);
 expect(r.measured!.queued, r.probe).toBe(3000);
 expect(r.measured!.complete + r.measured!.queued >= BAND, r.probe).toBe(c.cut);
 expect(r.faults, r.probe).toEqual([]);
 expect(r.cuts > 0, r.probe).toBe(c.cut);
 expect(r.requests, r.probe).toBe(2); expect(r.effects, r.probe).toBe(1);
 // The queued message is never lost by the cut: the second request carries it.
 expect(r.delivered, r.probe).toBe(true);
 for (const guarded of r.guard) expect(guarded, r.probe).toBeLessThan(ROOM);
 expectParity(r, { host: HOST, queued: 3000 });
});

test('messages queued at the tool boundary leave room in the cut: a cut that keeps as much as the plan allows still lands the next request under the room', async () => {
 // One long user turn of distinct content, so the cut has no earlier turn to drop and keeps what the plan allows (about the room
 // minus mandatory input). Planned without the queued message, the kept conversation plus the queued message would not fit.
 const r = await scenario({ at: 'tool', complete: ROOM - 1500, host: HOST, queued: 3000, keepRecent: 100000, oneTurn: true, fresh: 117000 });
 expect(r.measured!.complete + r.measured!.queued, r.probe).toBeGreaterThanOrEqual(ROOM);
 expect(r.kept, r.probe).toBeGreaterThan(100000); // the cut was bound by the plan, not by a tiny tail
 expect(r.faults, r.probe).toEqual([]);
 expect(r.cuts, r.probe).toBeGreaterThan(0);
 expect(r.requests, r.probe).toBe(2); expect(r.effects, r.probe).toBe(1); expect(r.delivered, r.probe).toBe(true);
 for (const guarded of r.guard) expect(guarded, r.probe).toBeLessThan(ROOM);
 expectParity(r, { host: HOST, queued: 3000 });
});

test('queued messages that cannot fit even with no history fail closed at the guard, with no cut', async () => {
 // The queued input alone exceeds the room. A cut removes only saved conversation, so the trigger defers to the guard (as it does for
 // mandatory input at the prompt) instead of attempting a cut that cannot work and reporting its own error.
 const r = await scenario({ at: 'tool', complete: ROOM - 5000, host: HOST, queued: ROOM + 20000 });
 expect(r.faults.length, r.probe).toBeGreaterThan(0);
 for (const fault of r.faults) expect(fault, r.probe).toContain('Complete Pi context and response reserve exceed the estimated request budget');
 expect(r.requests, r.probe).toBe(1); expect(r.effects, r.probe).toBe(1); expect(r.cuts, r.probe).toBe(0);
});
