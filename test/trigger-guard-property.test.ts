import { mulberry32 as prng } from './random-sessions';
import { test, expect } from 'vitest';
import { HOST, ROOM, receiptOf, scenario, type Options } from './budget-fixture';
import { bandOf } from '../src/budget';

// "The trigger says it fits, so the guard passes." A Pi session with a scripted model runs randomized message mixes near the edge of the
// room: summary wrappers, queued steering, tool rounds of random size, and growth the trigger cannot see (the host's view grows, a
// tool is switched on or off, a steer arrives after the boundary), each smaller than the margin between the band and the room.
// What the property forbids is a guard rejection after a trigger decision that said the request fits (or that cut it), and any fault that
// the margin could add. Fail-closed requests must still fail closed.
// The properties run at the default cut point and at 0.6 (a band 40% under the room). Nothing in them needs the band close to the room:
// the fixture's unseen growth stays under the band-to-room margin at either, and the exact room alone decides every guard rejection.
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

for (const cutAt of [1, 0.6]) {
const BAND = bandOf(ROOM, cutAt), MARGIN = ROOM - BAND, label = cutAt === 1 ? '' : ` (cut point ${cutAt})`;
const run = (options: Options) => scenario({ ...options, compaction: { ...options.compaction, cutAt } });
test(`the unseen growth of the property fixture stays under the margin${label}`, () => { expect(growthBound).toBeLessThan(MARGIN); });

function feasible(seed: number): Options {
	const rng = prng(seed), int = (n: number) => Math.floor(rng() * n);
	const rounds = 1 + int(3);
	const complete = BAND - 5000 + int(5500);
	return {
		at: 'tool', host: HOST, complete, fresh: 1500 + int(3500), rounds, laterResult: 50 + int(2500),
		summary: rng() < 0.4, queued: [0, 0, 500, 2500][int(4)]!, dormant: 1000, afterDecision: unseen(rng, rounds),
	};
}

test(`feasible cuts: whenever the trigger says a request fits, or cuts it, the guard passes it, and nothing faults${label}`, async () => {
	let cuts = 0, fits = 0, waited = 0;
	for (const due of [false, true]) for (let seed = 1; seed <= 60; seed++) {
		const options = feasible(seed);
		// Retain the original band grid and add due cuts, keeping the first prompt below the band.
		if (due) { options.complete += ROOM - BAND + 5000; options.fresh! += ROOM - BAND + 10000; }
		const r = await run(options);
		const why = `seed ${seed} ${due ? 'due' : 'band'} ` + r.probe;
		expect(r.faults, why).toEqual([]);
		// Every boundary was followed by its request; steered messages left over at the end each add a turn that no boundary precedes.
		expect(r.requests, why).toBeGreaterThanOrEqual((options.rounds ?? 1) + 1);
		for (const guarded of r.guard) expect(guarded, why).toBeLessThan(ROOM);
		// Later steering can trigger a prompt cut carried by a request before it is saved at the next boundary.
		// Its raw probe then predates that pending cut. Check every tool cut against its own recorded pre-cut view.
		for (const entry of r.entries) {
			const receipt = receiptOf(entry);
			if (receipt.reason !== 'tool-loop') continue;
			const before = (entry.details as { diagnosticReceipt: { before: { value: number } } }).diagnosticReceipt.before.value;
			expect(Math.ceil((before + receipt.mandatoryInputTokens!) * receipt.calibrationFactor!), why).toBeGreaterThanOrEqual(ROOM);
		}
		cuts += r.entries.length;
		for (let i = 0; i < r.probes.length; i++) {
			const probe = r.probes[i]!, measured = probe.complete + probe.queued;
			if (r.cutsAtRequest[probe.after] === r.cutsAtProbe[i]) {
				fits++;
				if (probe.at === 'tool' && measured >= BAND && measured < ROOM) waited++;
			}
		}
	}
	// Both kinds of decision were made, many times.
	expect(cuts).toBeGreaterThan(20);
	expect(fits).toBeGreaterThan(60);
	expect(waited).toBeGreaterThan(20);
});

test(`irreducible requests: an in-band request that cannot be cut is no fault; only a request really over the room is rejected${label}`, async () => {
	let inBand = 0, rejected = 0, declined = 0;
	for (let seed = 1; seed <= 40; seed++) {
		const rng = prng(1000 + seed), int = (n: number) => Math.floor(rng() * n);
		const rounds = 1 + int(3);
		const options: Options = { at: 'tool', host: HOST, history: 1500, fresh: 100, complete: BAND + 1500 + int(1300), rounds, laterResult: 50 + int(250), dormant: 1000, afterDecision: unseen(rng, rounds) };
		const r = await run(options);
		const why = `seed ${seed} ` + r.probe;
		const measure = (i: number) => r.probes[i]!.complete + r.probes[i]!.queued;
        // A steering input can make the compiler quote only part of this run's original prompt. The new prompt check must stop that build.
        if (r.faults.some(f => f.includes('Prompt check failed'))) {
            expect(r.wholePrompt.at(-1), why).toBe(false);
            expect(r.requests, why).toBe(r.guard.length - 1);
            continue;
        }
		// Capacity faults remain confined to requests over the room.
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

test(`fail-closed requests still fail closed: mandatory input over the room is rejected by the guard with no cut and no request${label}`, async () => {
	for (let seed = 1; seed <= 6; seed++) {
		const rng = prng(2000 + seed);
		const r = await run({ at: 'impossible', complete: 20000, host: ROOM + 1000 + Math.floor(rng() * 20000), summary: seed % 2 === 0 });
		expect(r.faults.join(' '), r.probe).toContain(GUARD);
		expect(r.cuts, r.probe).toBe(0); expect(r.requests, r.probe).toBe(0); expect(r.effects, r.probe).toBe(0);
	}
});
}
