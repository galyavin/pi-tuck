import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect } from 'vitest';
import { BAND_EXACT, EXACT_RESERVE, HOST, ROOM_EXACT, WINDOW, harness, receiptOf, scenario } from './budget-fixture';

// Pi's own usage threshold (shouldCompact) fires when the last reply's reported usage, its output tokens (reasoning included) among them,
// plus the messages after it, exceeds the window less compaction.reserveTokens. It is checked at the end of a run and before every next
// turn. The compactor plans on its own estimate, calibrated on input usage only, so Pi can ask for a cut on a request the compactor
// admits, and a cut that cannot shrink the request would latch a fault. The compactor therefore answers a "threshold" call with its own
// gate: nothing below the band (a plain cancel, which Pi reports as aborted), an opportunistic cut inside it, a due cut at or above the
// room. These are real Pi sessions with scripted replies that carry output tokens; the exact reply reserve and reserveTokens 0 are what
// AB1 configures (the threshold then lies at the whole window, so only large outputs reach it).
const RECORDED_MAX_OUTPUT = 12729; // the largest reply output in the five recorded trial roots (828 replies)
// The reply that ends a run adds a few tokens to the conversation before Pi's end-of-run check, so "below the band" keeps a little clear of it.
const CLEAR = 20;
const base = { host: HOST, reserveTokens: 0, compaction: EXACT_RESERVE, usageRatio: 0.998 };

/** A scenario that also records every reason Pi asked the compactor for a cut with, before the compactor answered. */
async function observed(options: Parameters<typeof scenario>[0]) {
 const asked: string[] = [];
 const r = await scenario({ ...options, onBeforeCompact: event => { asked.push(event.reason); } });
 return { ...r, asked };
}
const same = (r: { cuts: number; requests: number; effects: number; guard: number[] }) => ({ cuts: r.cuts, requests: r.requests, effects: r.effects, guard: r.guard });

test('a large fresh result after a reply with 50,000 output tokens: Pi asks for a cut, the compactor declines, no fault, and the guard decides as it would without the output', async () => {
 // 225,000 estimated tokens, below the band of 234,447, of which 215,000 are the fresh tool result. The reply before it reported 50,000 output
 // tokens, so Pi counts 50,000 + about 10,000 + 215,000 = 275,000, above the window; the fresh round cannot be cut.
 const options = { ...base, at: 'tool' as const, complete: 225000, fresh: 215000 };
 const quiet = await observed({ ...options, outputTokens: 0 });
 const loud = await observed({ ...options, outputTokens: 50000 });
 const probe = loud.probe;
 expect(quiet.asked, quiet.probe).toEqual([]);
 expect(loud.asked, probe).toContain('threshold');
 for (const r of [quiet, loud]) { expect(r.faults, r.probe).toEqual([]); expect(r.aborts, r.probe).toBe(0); expect(r.cuts, r.probe).toBe(0); }
 expect(loud.requests, probe).toBe(2);
 expect(loud.effects, probe).toBe(1);
 expect(loud.last, probe).toMatchObject({ stopReason: 'stop' });
 for (const guarded of loud.guard) expect(guarded, probe).toBeLessThan(ROOM_EXACT);
 // The request and the guard's verdict are those of the run in which Pi never asked.
 expect(same(loud)).toEqual(same(quiet));
});

for (const shape of [
 { name: 'at the prompt', at: 'prompt' as const, complete: BAND_EXACT - CLEAR },
 { name: 'at a tool boundary', at: 'tool' as const, complete: BAND_EXACT - CLEAR, fresh: 100000 },
])
test(`Pi's threshold fires on a request just below the band, ${shape.name}: no cut, no fault, the request is sent`, async () => {
 const r = await observed({ ...base, ...shape, outputTokens: 50000 });
 const probe = r.probe;
 expect(r.asked, probe).toContain('threshold');
 expect(r.faults, probe).toEqual([]);
 expect(r.aborts, probe).toBe(0);
 expect(r.cuts, probe).toBe(0);
 expect(r.requests, probe).toBe(shape.at === 'tool' ? 2 : 1);
 expect(r.measured!.complete, probe).toBe(shape.complete);
 for (const guarded of r.guard) expect(guarded, probe).toBeLessThan(ROOM_EXACT);
});

// The same request, once as the compactor's own trigger meets it and once as Pi's threshold call meets it. The conversation and the host input
// are identical (the history is the same and so is the fresh tool result): in one run the host view grows before the boundary (the trigger
// sees it), in the other just after the trigger decided (only Pi's call, which comes later, sees it). The pair's `complete` and `fresh`
// differ by the growth so that both runs build the very same conversation. The growth is large enough that the boundary, which does not see
// it, always finds the request below the band.
const GROWTH = 12000;
for (const where of [
 { name: 'just below the band', complete: BAND_EXACT - CLEAR },
 { name: 'the first token inside the band', complete: BAND_EXACT },
 { name: 'at the room', complete: ROOM_EXACT },
])
test(`at or above the band Pi's threshold call yields the compactor's own decision: ${where.name}`, async () => {
 const options = { ...base, at: 'tool' as const, outputTokens: 50000 };
 // Own trigger: the host view grows at the first decision (before the prompt's request); the boundary then meets the full request.
 const own = await observed({ ...options, complete: where.complete, fresh: 100000, afterDecision: (index, api) => { if (index === 0) api.growHost(GROWTH); } });
 // Pi's call: the view grows after the boundary's decision, so the boundary sees the request without it and the threshold call sees all of it.
 const pi = await observed({ ...options, complete: where.complete - GROWTH, fresh: 100000 - GROWTH, afterDecision: (index, api) => { if (index === 1) api.growHost(GROWTH); } });
 const probe = JSON.stringify({ own: own.probe, pi: pi.probe });
 expect(pi.asked, probe).toContain('threshold');
 for (const r of [own, pi]) { expect(r.faults, r.probe).toEqual([]); expect(r.aborts, r.probe).toBe(0); expect(r.requests, r.probe).toBe(2); for (const guarded of r.guard) expect(guarded, r.probe).toBeLessThan(ROOM_EXACT); }
 // The same number of cuts, and each the same decision: its target, view, size and the arithmetic it reserved.
 expect(pi.cuts, probe).toBe(own.cuts);
 expect(pi.cuts > 0, probe).toBe(where.complete >= BAND_EXACT);
 const decision = (entry: (typeof own.entries)[number]) => { const r = receiptOf(entry); return { target: r.target, mode: r.mode, view: r.view, tokensAfter: r.tokensAfter, mandatory: r.mandatoryInputTokens, host: r.hostInputTokens, reserved: r.draftReservedTokens, margin: r.triggerMarginTokens, factor: r.calibrationFactor }; };
 expect(pi.entries.map(decision), probe).toEqual(own.entries.map(decision));
 for (const entry of own.entries) expect(receiptOf(entry).reason, probe).toBe('tool-loop');
 for (const entry of pi.entries) expect(receiptOf(entry).reason, probe).toBe('threshold');
 // Only the first request differs (it carries the growth in one run); the request after the boundary is the same, cut or not.
 expect(pi.guard.at(-1), probe).toBe(own.guard.at(-1));
});

test("at the room, a cut that reaches the room but not the band is taken by Pi's threshold call as the compactor's own trigger takes it", async () => {
 // A fresh tool round of 217,000 tokens is protected and only 2,000 tokens of old history before it can be cut: from 239,332 tokens the
 // best cut lands inside the band, below the room. The cut is due (the request does not fit), so it is taken, not declined as an
 // opportunistic one would be.
 const options = { ...base, at: 'tool' as const, cycleSize: 2000, outputTokens: 50000 };
 const complete = ROOM_EXACT + 100;
 const own = await observed({ ...options, complete, fresh: 217000, afterDecision: (index, api) => { if (index === 0) api.growHost(GROWTH); } });
 const pi = await observed({ ...options, complete: complete - GROWTH, fresh: 217000 - GROWTH, afterDecision: (index, api) => { if (index === 1) api.growHost(GROWTH); } });
 const probe = JSON.stringify({ own: own.probe, pi: pi.probe });
 expect(pi.asked, probe).toContain('threshold');
 for (const r of [own, pi]) { expect(r.faults, r.probe).toEqual([]); expect(r.aborts, r.probe).toBe(0); expect(r.requests, r.probe).toBe(2); expect(r.cuts, r.probe).toBe(1); expect(r.guard.at(-1)!, r.probe).toBeLessThan(ROOM_EXACT); }
 const landing = (r: typeof own) => receiptOf(r.entries[0]!).tokensAfter + receiptOf(r.entries[0]!).mandatoryInputTokens!;
 expect(landing(own), probe).toBeGreaterThanOrEqual(BAND_EXACT);
 expect(landing(own), probe).toBeLessThan(ROOM_EXACT);
 expect(receiptOf(pi.entries[0]!), probe).toMatchObject({ reason: 'threshold', target: receiptOf(own.entries[0]!).target, tokensAfter: receiptOf(own.entries[0]!).tokensAfter });
 expect(receiptOf(own.entries[0]!).reason, probe).toBe('tool-loop');
});

test("inside the band, Pi's threshold call is opportunistic like the compactor's own trigger: a cut that cannot reach the band is no cut and no fault", async () => {
 // A protected prompt takes almost the whole request and only a little old history can be cut, so no cut reaches the band from here.
 const options = { ...base, at: 'tool' as const, complete: BAND_EXACT + 2800, history: 1500, fresh: 100 };
 const quiet = await observed({ ...options, outputTokens: 0 });
 const loud = await observed({ ...options, outputTokens: 50000 });
 // (The compactor's own opportunistic cut at the prompt reaches Pi as a "manual" cut; only a "threshold" ask comes from Pi's usage.)
 expect(quiet.asked, quiet.probe).not.toContain('threshold');
 expect(loud.asked, loud.probe).toContain('threshold');
 for (const r of [quiet, loud]) { expect(r.faults, r.probe).toEqual([]); expect(r.aborts, r.probe).toBe(0); expect(r.cuts, r.probe).toBe(0); expect(r.requests, r.probe).toBe(2); }
 expect(same(loud)).toEqual(same(quiet));
});

// Dormancy, with the output tokens a reply really has. Pi asks when the reply's reported usage exceeds the window; the compactor then
// cuts if and only if its own measure of that request, on the calibration factor the reply taught it, is inside the band.
test.each([0, RECORDED_MAX_OUTPUT, 50000])('dormancy with reserveTokens 0 and the exact reserve: replies with %i output tokens start a cut only where the compactor\'s own measure says one is due', async output => {
 for (const ratio of [0.998, 1.1]) {
  const r = await observed({ ...base, at: 'prompt', complete: 225000, usageRatio: ratio, outputTokens: output });
  const probe = `ratio ${ratio}: ${r.probe}`;
  const reported = Math.ceil(225000 * ratio) + output;
  const asks = reported > WINDOW;
  const due = Math.ceil(225000 * Math.max(1, ratio)) >= BAND_EXACT;
  expect(r.guard[0], probe).toBe(225000);
  expect(r.asked.includes('threshold'), probe).toBe(asks);
  expect(r.faults, probe).toEqual([]);
  expect(r.aborts, probe).toBe(0);
  expect(r.requests, probe).toBe(1);
  expect(r.cuts > 0, probe).toBe(asks && due);
  for (const entry of r.entries) expect(receiptOf(entry).reason, probe).toBe('threshold');
 }
});

test('negative control: with the setting AB1 used before, reserveTokens equal to the reserve, Pi asks at 247,500 reported tokens and the compactor, calibrated on that reply, takes the cut', async () => {
 const r = await observed({ ...base, at: 'prompt', complete: 225000, reserveTokens: 32768, usageRatio: 1.1 });
 expect(r.asked, r.probe).toEqual(['threshold']);
 expect(r.faults, r.probe).toEqual([]);
 expect(r.entries.map(e => receiptOf(e).reason), r.probe).toEqual(['threshold']);});

test("when the mandatory input alone no longer fits, Pi's threshold call is declined and the complete-context guard fails the request closed, as for the compactor's own trigger", async () => {
 // The fresh result and a reply with 50,000 output tokens make Pi ask; just after the compactor's boundary decision the host view grows past the
 // room, so no cut could help. The compactor declines; the guard alone refuses the next request, once, with its own message.
 const r = await observed({ ...base, at: 'tool', complete: 225000, fresh: 215000, outputTokens: 50000, afterDecision: (index, api) => { if (index === 1) api.growHost(ROOM_EXACT + 20000); } });
 const probe = r.probe;
 expect(r.asked, probe).toContain('threshold');
 expect(r.cuts, probe).toBe(0);
 expect(r.requests, probe).toBe(1);
 expect(r.effects, probe).toBe(1);
 expect(r.faults.length, probe).toBeGreaterThan(0);
 for (const fault of r.faults) expect(fault, probe).toContain('Complete Pi context and response reserve exceed the estimated request budget');
});

test("a declined threshold ask does not end an operator's running incident recording", async () => {
 const directory = mkdtempSync(join(tmpdir(), 'pi-recorder-'));
 const h = await harness({ ...base, at: 'tool', complete: 225000, fresh: 215000, outputTokens: 50000, compaction: { ...EXACT_RESERVE, diagnostics: { directory } } });
 try {
  await h.session.prompt('/compaction-incident on');
  const r = await h.run();
  await h.session.prompt('/compaction-incident status');
  expect(r.cuts, r.probe).toBe(0);
  expect(JSON.parse(h.notices.at(-1)!).state, r.probe).toBe('recording');
 } finally { await h.cleanup(); await new Promise(resolve => setTimeout(resolve, 100)); rmSync(directory, { recursive: true, force: true }); }
});
