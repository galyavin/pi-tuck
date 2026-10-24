import { test, expect } from 'vitest';
import { BAND, HOST, ROOM, scenario, type Options } from './budget-fixture';

// "The trigger says it fits, so the guard passes." A Pi session with a scripted model runs randomized message mixes near the edge of the
// room: summary wrappers, queued steering, tool rounds of random size, and growth the trigger cannot see (the host's view grows, a
// tool is switched on or off, a steer arrives after the boundary), each smaller than the margin between the band and the room.
// What the property forbids is a guard rejection after a trigger decision that said the request fits (or that cut it), and any fault that
// the margin could add. Fail-closed requests must still fail closed.
function prng(seed: number) {
	let a = seed >>> 0;
	return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const MARGIN = ROOM - BAND;
const GUARD = 'Complete Pi context and response reserve exceed the estimated request budget';

/** Unseen growth per decision: host input up to 1,200 tokens, a tool of 1,000 tokens switched on or off, a steer of up to 500: at most 2,700. */
function unseen(rng: () => number, rounds: number): NonNullable<Options['afterDecision']> {
	let dormantOn = false;
	return async (index, api) => {
		api.growHost(Math.floor(rng() * 1200));
		if (rng() < 0.4) { dormantOn = !dormantOn; api.setTools(dormantOn); }
		// A steer after the last tool boundary would start a request that no boundary precedes.
		if (index < rounds && rng() < 0.3) await api.steer(100 + Math.floor(rng() * 400));
	};
}
const growthBound = 1200 + 1000 + 500 + 20; // plus a few tokens of rounding between the observed and the guard's formulas
test('the unseen growth of the property fixture stays under the margin', () => { expect(growthBound).toBeLessThan(MARGIN); });

function feasible(seed: number): Options {
	const rng = prng(seed), int = (n: number) => Math.floor(rng() * n);
	const rounds = 1 + int(3);
	return {
		at: 'tool', host: HOST, complete: BAND - 5000 + int(5500), fresh: 1500 + int(3500), rounds, laterResult: 50 + int(2500),
		summary: rng() < 0.4, queued: [0, 0, 500, 2500][int(4)]!, dormant: 1000, afterDecision: unseen(rng, rounds),
	};
}

test('feasible cuts: whenever the trigger says a request fits, or cuts it, the guard passes it, and nothing faults', async () => {
	let cuts = 0, fits = 0;
	for (let seed = 1; seed <= 60; seed++) {
		const options = feasible(seed);
		const r = await scenario(options);
		const why = `seed ${seed} ` + r.probe;
		expect(r.faults, why).toEqual([]);
		// Every boundary was followed by its request; steered messages left over at the end each add a turn that no boundary precedes.
		expect(r.requests, why).toBeGreaterThanOrEqual((options.rounds ?? 1) + 1);
		for (const guarded of r.guard) expect(guarded, why).toBeLessThan(ROOM);
		// Decision by decision: what the trigger measured, what it did, and what the guard then saw.
		for (let i = 0; i < r.probes.length; i++) {
			const measured = r.probes[i]!.complete + r.probes[i]!.queued;
			const cutHere = r.cutsAtRequest[i]! - r.cutsAtProbe[i]!;
			expect(cutHere > 0, why + ` decision ${i}: ${measured}`).toBe(measured >= BAND);
			if (cutHere > 0) cuts++; else fits++;
		}
	}
	// Both kinds of decision were made, many times.
	expect(cuts).toBeGreaterThan(20);
	expect(fits).toBeGreaterThan(60);
});

test('irreducible requests: an in-band request that cannot be cut is no fault; only a request really over the room is rejected', async () => {
	let inBand = 0, rejected = 0, declined = 0;
	for (let seed = 1; seed <= 40; seed++) {
		const rng = prng(1000 + seed), int = (n: number) => Math.floor(rng() * n);
		const rounds = 1 + int(3);
		const options: Options = { at: 'tool', host: HOST, history: 1500, fresh: 100, complete: BAND + 1500 + int(1300), rounds, laterResult: 50 + int(250), dormant: 1000, afterDecision: unseen(rng, rounds) };
		const r = await scenario(options);
		const why = `seed ${seed} ` + r.probe;
		const measure = (i: number) => r.probes[i]!.complete + r.probes[i]!.queued;
		// The margin adds no fault class: the compactor's own faults are only the old ones, and only for a request really over the room.
		for (const fault of r.faults) expect(fault.includes(GUARD) || fault.includes("pi-tuck's mandatory context cannot fit"), why).toBe(true);
		expect(r.faults.join(' '), why).not.toContain('did not reduce');
		if (r.faults.some(f => f.includes("pi-tuck's mandatory"))) expect(measure(r.probes.length - 1), why).toBeGreaterThanOrEqual(ROOM);
		// A guard rejection only for a request the guard counts over the room.
		const rejectedAt = r.guard.findIndex(g => g >= ROOM);
		if (rejectedAt >= 0) { rejected++; expect(r.faults.join(' '), why).toContain(GUARD); expect(r.requests, why).toBe(rejectedAt); }
		else if (!r.faults.length) expect(r.requests, why).toBeGreaterThanOrEqual(rounds + 1);
		for (let i = 0; i < r.probes.length; i++) {
			const m = measure(i), cutHere = (r.cutsAtRequest[i] ?? r.cuts) - r.cutsAtProbe[i]!;
			if (m >= BAND && m < ROOM) { inBand++; if (!cutHere) declined++; }
			// In the band a decision never faults on its own: it cut, or it did nothing and the request went to the guard.
			if (m < ROOM && i < r.requests) expect(r.faults.filter(f => f.includes("pi-tuck's")), why).toEqual([]);
		}
	}
	expect(inBand).toBeGreaterThan(30);
	expect(declined).toBeGreaterThan(10);
});

test('fail-closed requests still fail closed: mandatory input over the room is rejected by the guard with no cut and no request', async () => {
	for (let seed = 1; seed <= 6; seed++) {
		const rng = prng(2000 + seed);
		const r = await scenario({ at: 'impossible', complete: 20000, host: ROOM + 1000 + Math.floor(rng() * 20000), summary: seed % 2 === 0 });
		expect(r.faults.join(' '), r.probe).toContain(GUARD);
		expect(r.cuts, r.probe).toBe(0); expect(r.requests, r.probe).toBe(0); expect(r.effects, r.probe).toBe(0);
	}
});
