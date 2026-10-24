import { test, expect } from 'vitest';
import { BAND, HOST, ROOM, scenario } from './budget-fixture';

// The system part is charged as the larger of two formulas, and the calibration factor scales every consumer alike. Both are walked
// token by token across the edge they decide. `complete` is the fixture's reference for the request, computed from Pi's own functions.
const AROUND = [-3, -2, -1, 0, 1, 2, 3];

for (const pad of [0, 1, 2, 3])
for (const at of ['prompt', 'tool'] as const)
test(`the observed prompt and tools are charged at the edge to the token, whatever the rounding of the prompt: ${at}, ${pad} extra characters`, async () => {
 const seen: { d: number; cuts: number }[] = [];
 for (const d of AROUND) {
  const r = await scenario({ at, complete: BAND + d, host: HOST, pad });
  expect(r.measured!.complete, r.probe).toBe(BAND + d);
  expect(r.faults, r.probe).toEqual([]);
  seen.push({ d, cuts: r.cuts });
 }
 const probe = JSON.stringify(seen);
 for (const s of seen) expect(s.cuts > 0, probe).toBe(s.d >= 0);
});

test('the guard formula over the saved system message is charged when it is larger than the observed prompt and tools', async () => {
 // A tool is dropped after the last request: the saved system message still declares it, so the next request is counted with it (the
 // observed prompt and tools are never allowed to discount it), however much larger than the observed measure that is.
 const seen: { d: number; cuts: number }[] = [];
 for (const d of AROUND) {
  const r = await scenario({ at: 'tool', complete: BAND + d, host: HOST, ballast: 2000 });
  expect(r.measured!.complete, r.probe).toBe(BAND + d);
  expect(r.faults, r.probe).toEqual([]);
  // The request that is then sent no longer carries the tool: the count was conservative by about its size.
  if (!r.cuts) expect(r.guard.at(-1)!, r.probe).toBeLessThan(r.measured!.complete - 1500);
  seen.push({ d, cuts: r.cuts });
 }
 const probe = JSON.stringify(seen);
 for (const s of seen) expect(s.cuts > 0, probe).toBe(s.d >= 0);
});

test('the guard admits a request exactly while it is below the room', async () => {
 // Triggers are off, so only the guard decides. A margin that leaked into the guard (or into the calibration) would reject requests
 // below the room.
 for (const d of [-30, -10, -3, -2, -1, 0, 1, 2, 3, 10]) {
  const r = await scenario({ at: 'prompt', complete: ROOM + d, host: HOST, compactionEnabled: false });
  expect(r.measured!.complete, r.probe).toBe(ROOM + d);
  expect(r.guard[0], r.probe).toBe(ROOM + d);
  if (d < 0) { expect(r.faults, r.probe).toEqual([]); expect(r.requests, r.probe).toBe(1); }
  else { expect(r.faults.join(' '), r.probe).toContain('Complete Pi context and response reserve exceed the estimated request budget'); expect(r.requests, r.probe).toBe(0); }
 }
});

// The calibration factor ratchets from a request whose reported input exceeds the estimate; the same factor applies to the trigger, the
// planner and the guard. It is the reported ratio exactly: no margin is added to it.
const RATIO = 1.1;
const factorOf = (guarded: number) => Math.ceil(guarded * RATIO) / guarded; // the scripted reply reports ceil(guard * ratio) input tokens
const calibrated = (raw: number, factor: number) => Math.ceil(raw * factor);

test('the calibration factor scales the trigger at the band to the token, and the margin does not enter it', async () => {
 const seen: { raw: number; calibrated: number; cuts: number }[] = [];
 for (let d = -6; d <= 6; d++) {
  const r = await scenario({ at: 'tool', complete: Math.floor(BAND / RATIO) + d, host: HOST, usageRatio: RATIO });
  expect(r.faults, r.probe).toEqual([]);
  const factor = factorOf(r.guard[0]!);
  expect(factor, r.probe).toBeGreaterThan(RATIO);
  expect(factor, r.probe).toBeLessThan(RATIO + 1e-4); // the ratio itself, to the rounding of the reported tokens
  const raw = r.measured!.complete;
  seen.push({ raw, calibrated: calibrated(raw, factor), cuts: r.cuts });
 }
 const probe = JSON.stringify(seen);
 for (const s of seen) expect(s.cuts > 0, probe).toBe(s.calibrated >= BAND);
 expect(seen.some(s => s.cuts > 0) && seen.some(s => s.cuts === 0), probe).toBe(true);
});

test('the calibration factor scales the guard at the room to the token', async () => {
 const seen: { raw: number; calibrated: number; admitted: boolean }[] = [];
 for (let d = -6; d <= 6; d++) {
  const r = await scenario({ at: 'tool', complete: Math.floor(ROOM / RATIO) + d, host: HOST, usageRatio: RATIO, compactionEnabled: false });
  const factor = factorOf(r.guard[0]!);
  const raw = r.measured!.complete;
  // The first request is far below the room; the second is the one at the edge.
  expect(r.requests >= 1, r.probe).toBe(true);
  seen.push({ raw, calibrated: calibrated(raw, factor), admitted: r.requests === 2 });
 }
 const probe = JSON.stringify(seen);
 for (const s of seen) expect(s.admitted, probe).toBe(s.calibrated < ROOM);
 expect(seen.some(s => s.admitted) && seen.some(s => !s.admitted), probe).toBe(true);
});

test('the calibration factor never goes below one: a reply that reports fewer tokens than estimated does not loosen anything', async () => {
 const seen: { d: number; cuts: number }[] = [];
 for (const d of [-2, -1, 0, 1, 2]) {
  const r = await scenario({ at: 'tool', complete: BAND + d, host: HOST, usageRatio: 0.8 });
  expect(r.faults, r.probe).toEqual([]);
  seen.push({ d, cuts: r.cuts });
 }
 const probe = JSON.stringify(seen);
 for (const s of seen) expect(s.cuts > 0, probe).toBe(s.d >= 0);
});

test('a summary with a record omitted by a native context edit is counted as the model receives it, by the trigger and the planner alike', async () => {
	// The saved summary quotes a source that a native edit has since omitted; the model is sent the summary without that record (10,000
	// tokens less than the saved one). The reference is the real request: find the size at which the request the guard sees is exactly
	// where the case wants it, with triggers off, then run the same session with triggers on.
	const base = { at: 'tool' as const, host: HOST, summary: true, omitted: 40000 };
	const off = (complete: number) => scenario({ ...base, complete, compactionEnabled: false });
	const first = await off(BAND);
	const shift = BAND - first.guard[1]!;
	expect(shift).toBeGreaterThan(5000); // the saved summary really is larger than what is sent
	const seen: { d: number; cuts: number }[] = [];
	for (const d of AROUND) {
		const complete = BAND + shift + d;
		const real = await off(complete);
		expect(real.guard[1], real.probe).toBe(BAND + d); // the request the guard counts, token for token
		const r = await scenario({ ...base, complete });
		expect(r.faults, r.probe).toEqual([]);
		seen.push({ d, cuts: r.cuts });
	}
	const probe = JSON.stringify(seen);
	for (const s of seen) expect(s.cuts > 0, probe).toBe(s.d >= 0);
});
