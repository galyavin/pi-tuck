import { test, expect } from 'vitest';
import { bandOf, decideCut, type Decision, type Plan, type Target } from '../src/budget';

// Monotone safety of the trigger margin. A margin applied to the triggers alone could create faults that do not exist without it
// (a cut that lands in [band, room) and fails to reduce at the next boundary). The decision procedure is built so that it cannot:
// inside the band a cut is opportunistic and never a fault; from the room up the band plan falls back to the room plan.
// Deterministic pseudo-random cases (mulberry32); a plan model that is consistent the way the real planner is: whatever limit the
// planner can reach, it can reach with a larger limit, and every draft reduces and fits the limit it was asked for.

function prng(seed: number) {
	let a = seed >>> 0;
	return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const FACTORS = [1, 1, 1, 1.05, 1.13, 1.25, 1.5];

const LADDER = ['bounded', 'masked', 'full', 'dialogue', 'shrunk'] as const;
interface Case {
	room: number; band0: number; band: number; fits: (t: number, l: number) => boolean; reach: (limit: number) => number;
	mandatory: number; before: number; floor: number | undefined; costs: number[]; trims: number[]; seed: number; blocked: boolean;
}
function makeCase(seed: number, cutAt = 1): Case {
	const rng = prng(seed), int = (n: number) => Math.floor(rng() * n);
	const factor = FACTORS[int(FACTORS.length)]!;
	const room = 2000 + int(300000);
	const fits = (t: number, l: number) => Math.ceil(t * factor) < l;
	const band = bandOf(room, cutAt);
	// The largest raw token count that fits a limit.
	const reach = (limit: number) => { let t = Math.floor(limit / factor) + 2; while (t > 0 && !fits(t, limit)) t--; return t; };
	const mandatory = rng() < 0.08 ? reach(room) - int(5) + 1 : int(Math.floor(room * (rng() < 0.7 ? 0.3 : 1.1)));
	// Where the request sits: well below, around the band edge, in the band, around the room edge, above.
	const edge = [reach(band), reach(room)][int(2)]!;
	const region = int(6);
	const wanted = region === 0 ? int(reach(band)) : region === 1 ? edge - 3 + int(7) : region === 2 ? reach(band) + int(Math.max(1, reach(room) - reach(band))) : region === 3 ? reach(room) - 3 + int(7) : int(Math.floor(room * 0.8)) + reach(room);
	const before = Math.max(1, wanted - mandatory);
	// The cut floor: the least conversation any cut can leave (the shrunk view), or no cut at all.
	const floor = rng() < 0.12 ? undefined : rng() < 0.4 ? Math.max(0, [reach(band), reach(room)][int(2)]! - mandatory - 2 + int(5)) : int(before);
	// What each richer view of the history would leave: any size at or above the floor, near the edges as often as not.
	const costs = LADDER.map((_, k) => {
		if (floor === undefined) return Infinity;
		if (k === LADDER.length - 1) return floor;
		const target = [reach(band) - mandatory, reach(room) - mandatory][int(2)]!;
		return rng() < 0.5 ? Math.max(floor, target - 2 + int(5)) : floor + int(Math.max(1, Math.floor(before * 0.8)));
	});
	// The real planner is not monotone in the limit: a larger limit keeps a larger native tail and allows a larger shrunk summary, either of which
	// can fail the admission that a smaller limit passes. So the exact room sometimes has no plan where the band has one.
	const blocked = rng() < 0.12;
	// Within a mode a smaller limit can leave less: the bounded and shrunk allowances are derived from the reserve, and the band's is 2% smaller.
	const trims = costs.map((cost, k) => (k === 0 || k === LADDER.length - 1) && Number.isFinite(cost) && rng() < 0.6 ? 1 + int(Math.max(1, Math.floor(cost * 0.15))) : 0);
	return { room, band0: room, band, fits, reach, mandatory, before, floor, costs, trims, seed, blocked };
}
/**
 * A plan model that is consistent the way the real planner is, and a pure function of the limit: the first view of the ladder that reduces
 * and fits the limit wins (so a richer view needs a larger limit), the shrunk view being the last resort. Whatever limit it can reach, it
 * can reach with a larger one (except where `blocked`, see above). Within a mode the band plan can leave less than the room plan (`trims`). The sizes of the views are unrelated, so a band plan may leave more or less than the room plan.
 */
function planner(c: Case, band: number, calls: Target[]) {
	return (target: Target): Plan => {
		calls.push(target);
		const limit = target === 'band' ? band : c.room;
		const after = (k: number) => c.costs[k]! - (limit === c.room ? 0 : c.trims[k]!);
		const k = c.blocked && limit === c.room ? -1 : c.costs.findIndex((_, i) => after(i) < c.before && c.fits(after(i) + c.mandatory, limit));
		if (k < 0) return { draft: false, capacityRejected: ((c.seed * 31 + limit) & 1) === 1, reason: 'no draft for ' + target };
		return { draft: true, after: after(k), mode: LADDER[k]! };
	};
}
const decide = (c: Case, band: number, calls: Target[] = []) =>
	decideCut({ total: c.before + c.mandatory, mandatory: c.mandatory, before: c.before, room: c.room, band, fits: c.fits, plan: planner(c, band, calls), unreduced: 'did not reduce' });

// The properties hold for any cut point: none of them uses the width of the band, only that the band is below the room. The default cut
// point 1 leaves the band 2% under the room; 0.6 puts it 40% under, so the band cases lie well apart from the room cases.
for (const cutAt of [1, 0.6]) {
const label = cutAt === 1 ? '' : ` (cut point ${cutAt})`;
test(`monotone safety: a margin adds no fault, changes no view, every cut lands below the room, an opportunistic cut below the band, and nothing thrashes${label}`, () => {
	const kinds: Record<string, number> = { none: 0, defer: 0, cut: 0, fault: 0 };
	const cuts: Record<string, number> = { opportunistic: 0, band: 0, fallback: 0, other: 0, declined: 0, declinedNoRoom: 0, forcedNoRoom: 0, roomFirstInBand: 0, roomFirstDue: 0 };
	let cases = 0;
	for (let seed = 1; seed <= 24000; seed++) {
		const c = makeCase(seed, cutAt);
		const total = c.before + c.mandatory;
		const withMargin = decide(c, c.band, []);
		const withoutMargin = decide(c, c.band0, []);
		kinds[withMargin.kind]!++;
		cases++;
		const why = JSON.stringify({ seed, room: c.room, band: c.band, mandatory: c.mandatory, before: c.before, floor: c.floor, costs: c.costs, withMargin, withoutMargin });
		// Every case that is not a fault without the margin is not a fault with it.
		if (withoutMargin.kind !== 'fault') expect(withMargin.kind, why).not.toBe('fault');
		// A request that fits the room is never a fault.
		if (c.fits(total, c.room)) expect(withMargin.kind, why).not.toBe('fault');
		// Rules 1 and 3 plan nothing; otherwise the room is planned first, and the band only when the room plan does not settle it.
		const calls: Target[] = [];
		const again = decide(c, c.band, calls);
		if (c.fits(total, c.band)) { expect(again, why).toEqual({ kind: 'none' }); expect(calls, why).toEqual([]); }
		else if (!c.fits(c.mandatory, c.room)) { expect(again.kind, why).toBe('defer'); expect(calls, why).toEqual([]); }
		else expect(calls[0], why).toBe('room');
		const exact = planner(c, c.band0, [])('room');
		// A room plan that already lands below the band is taken as it is, in the band and from the room up alike: the content of the room plan, the band not planned.
		const roomFits = exact.draft && exact.after < c.before && c.fits(exact.after + c.mandatory, c.band);
		if (!c.fits(total, c.band) && c.fits(c.mandatory, c.room) && roomFits) {
			expect(withMargin, why).toMatchObject({ kind: 'cut', target: 'room', plan: { after: exact.after, mode: exact.mode } });
			expect(calls, why).toEqual(['room']);
			cuts[c.fits(total, c.room) ? 'roomFirstInBand' : 'roomFirstDue']!++;
		}
		for (const d of [withMargin, withoutMargin] as Decision[]) {
			if (d.kind !== 'cut') continue;
			// Every cut reduces and lands below the room; an opportunistic one lands below the band.
			expect(d.plan.after, why).toBeLessThan(c.before);
			expect(c.fits(d.plan.after + c.mandatory, c.room), why).toBe(true);
			// The margin never changes the view: whenever the room has a plan, a cut has the room plan's view.
			if (exact.draft) expect(d.plan.mode, why).toBe(exact.mode);
			// Inside the band, where the exact room cuts nothing, a cut needs a room plan of the same view.
			if (d === withMargin && c.fits(total, c.room)) { expect(c.fits(d.plan.after + c.mandatory, c.band), why).toBe(true); expect(exact.draft, why).toBe(true); if (!roomFits) cuts.opportunistic!++; }
			// At or above the room a band plan stands when the room has none: a cut instead of a fault.
			if (d === withMargin && !c.fits(total, c.room) && !exact.draft) { expect(d.target, why).toBe('band'); cuts.forcedNoRoom!++; }
			if (d === withMargin && !c.fits(total, c.room) && !roomFits) cuts[exact.draft && d.target === 'band' ? 'band' : d.target === 'room' && exact.draft && planner(c, c.band, [])('band').draft ? 'other' : 'fallback']!++;
		}
		// A cut above the room has the very view it has without the margin.
		if (withMargin.kind === 'cut' && withoutMargin.kind === 'cut') expect(withMargin.plan.mode, why).toBe(withoutMargin.plan.mode);
		// An opportunistic cut that the room's view stands in the way of, or the room cannot plan at all, is a decision to do nothing, not a fault.
		if (withMargin.kind === 'none' && c.fits(total, c.room) && !c.fits(total, c.band) && c.fits(c.mandatory, c.room)) {
			const preferred = planner(c, c.band, [])('band');
			if (preferred.draft && preferred.after < c.before && c.fits(preferred.after + c.mandatory, c.band)) { if (!exact.draft) cuts.declinedNoRoom!++; else if (exact.mode !== preferred.mode) cuts.declined!++; }
		}
		// No thrash: after a cut the next boundaries (same mandatory input, the same views) never fault, each cut that follows leaves strictly
		// less, and the sequence ends with a decision to do nothing.
		if (withMargin.kind === 'cut') {
			let state: Case = { ...c, before: withMargin.plan.after }, last = withMargin.plan.after, ended = false;
			for (let step = 0; step < 6 && !ended; step++) {
				const next = decide(state, c.band, []);
				expect(next.kind, why + ` step ${step}`).not.toBe('fault');
				expect(next.kind, why + ` step ${step}`).not.toBe('defer');
				if (next.kind === 'none') { ended = true; break; }
				if (next.kind === 'cut') { expect(next.plan.after, why).toBeLessThan(last); last = next.plan.after; state = { ...state, before: next.plan.after }; }
			}
			expect(ended, why).toBe(true);
		}
	}
	expect(cases).toBeGreaterThanOrEqual(10000);
	// The cases really cover every outcome, the kinds of cut, and the opportunistic cut that the room's view declines.
	const stats = JSON.stringify({ kinds, cuts });
	for (const kind of Object.keys(kinds)) expect(kinds[kind], stats).toBeGreaterThan(200);
	for (const kind of Object.keys(cuts)) expect(cuts[kind], stats).toBeGreaterThan(100);
});

test(`the cases reach what a margin on the triggers alone would turn into faults, so the property above is not vacuous${label}`, () => {
	// Inside the band, with mandatory input that fits and no cut that reaches the band: a naive margin would fault; this procedure does nothing.
	let naive = 0;
	for (let seed = 1; seed <= 6000; seed++) {
		const c = makeCase(seed, cutAt), total = c.before + c.mandatory;
		if (c.fits(total, c.room) && !c.fits(total, c.band) && c.fits(c.mandatory, c.room) && !planner(c, c.band, [])('band').draft) naive++;
	}
	expect(naive).toBeGreaterThan(100);
});
}
