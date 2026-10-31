import { test, expect } from 'vitest';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { BAND, BAND_EXACT, EXACT_RESERVE, HOST, ROOM, ROOM_EXACT, expectParity, harness, nonSystem, receiptOf, scenario } from './budget-fixture';
import { DEFAULT_CUT_AT, TRIGGER_MARGIN_FRACTION, bandOf, decideCut, validCutAt, type Plan } from '../src/budget';
import { installCompaction } from '../src/compaction';

// The cut point `cutAt` (F): a cut is triggered at, and preferably planned to, the band min(room - margin, floor(F * room)). The exact room
// stays the limit of every throw, fault and the guard. F = 1 is the default and leaves every decision as it was.
// The settings file is read by index.ts (cut-at-settings.test.ts). decide-cut-property.test.ts, trigger-guard-property.test.ts and
// cut-yield.test.ts run their properties at F = 0.6 as well.
const F = 0.6, LEAN = bandOf(ROOM, F);
const PROMPT = 2; // 'Continue'
const AROUND = [-30, -20, -10, -5, -3, -2, -1, 0, 1, 2, 3, 5, 10, 20, 30];
const legacy = (room: number) => room - Math.ceil(Math.max(0, room) * 0.02);

function prng(seed: number) {
	let a = seed >>> 0;
	return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

test('the band: F = 1, the default, is the room less the margin exactly as before, for every room', () => {
	expect(TRIGGER_MARGIN_FRACTION).toBe(0.02);
	const rooms = [-50, -0.5, 0, 0.3, 1, 2, 49.5, 50, 51, 101, 144000, 239232, 1e9, 2 ** 31];
	for (let room = -3; room <= 5000; room++) rooms.push(room);
	const rng = prng(5);
	for (let i = 0; i < 20000; i++) rooms.push(Math.floor(rng() * 4e6), rng() * 1e5);
	for (const room of rooms) {
		expect(bandOf(room), `${room}`).toBe(legacy(room));
		expect(bandOf(room, 1), `${room}`).toBe(legacy(room));
	}
	expect(bandOf(144000)).toBe(141120);
	expect(BAND).toBe(141120);
	expect(BAND_EXACT).toBe(234447);
});

test('the band: a lower F puts it at floor(F * room), and the margin still caps it', () => {
	expect(bandOf(144000, 0.6)).toBe(86400);
	expect(bandOf(239232, 0.6)).toBe(143539); // floor(143539.2)
	expect(bandOf(144000, 0.97)).toBe(139680);
	expect(bandOf(144000, 0.98)).toBe(141120);
	expect(bandOf(144000, 0.99)).toBe(141120); // the margin is lower than 0.99 of the room
	expect(bandOf(100, 0.5)).toBe(50);
	expect(bandOf(101, 0.5)).toBe(50);
	expect(bandOf(0, 0.5)).toBe(0);
	expect(bandOf(-50, 0.5)).toBe(-50);
	const rng = prng(9);
	for (let i = 0; i < 20000; i++) {
		const room = Math.floor(rng() * 4e6), cutAt = rng();
		if (cutAt <= 0) continue;
		const band = bandOf(room, cutAt);
		// Never above the room less the margin, never above F of the room, and never above the room.
		expect(band, `${room} ${cutAt}`).toBeLessThanOrEqual(legacy(room));
		expect(band, `${room} ${cutAt}`).toBeLessThanOrEqual(Math.floor(room * cutAt));
		expect(band, `${room} ${cutAt}`).toBeLessThan(Math.max(room, 1));
		// A higher F never lowers it, and from 0.99 up the margin alone decides.
		expect(bandOf(room, Math.min(1, cutAt + 0.1)), `${room} ${cutAt}`).toBeGreaterThanOrEqual(band);
		expect(bandOf(room, 0.99), `${room}`).toBe(legacy(room));
	}
});

test('a cut point is a number above 0 and at most 1', () => {
	for (const good of [1, 0.6, 0.999, 0.0001, Number.MIN_VALUE]) expect(validCutAt(good), String(good)).toBe(true);
	for (const bad of [0, -0.5, -1, 1.0000001, 2, 100, NaN, Infinity, -Infinity, '0.6', '1', null, undefined, true, false, [], [0.6], {}]) expect(validCutAt(bad), String(bad)).toBe(false);
});

test('installCompaction takes a valid cutAt and refuses any other before it registers anything', async () => {
	for (const cutAt of [undefined, 1, 0.6, 0.0001]) {
		const registered: string[] = [];
		const pi = { on: (name: string) => { registered.push(name); }, registerCommand: () => {}, registerTool: () => {} } as unknown as ExtensionAPI;
		const handle = await installCompaction(pi, { cutAt });
		expect(registered.length, String(cutAt)).toBeGreaterThan(0);
		await handle.close();
	}
	for (const cutAt of [0, -1, 1.5, NaN, Infinity, '0.6' as unknown as number]) {
		const registered: string[] = [];
		const pi = { on: (name: string) => { registered.push(name); }, registerCommand: () => {}, registerTool: () => {} } as unknown as ExtensionAPI;
		await expect(installCompaction(pi, { cutAt }), String(cutAt)).rejects.toThrow('cutAt must be a number above 0 and at most 1');
		expect(registered, String(cutAt)).toEqual([]);
	}
});

// A lean band is one the cut point binds (band < bandOf(room)). There the band is planned first and the room plan is not taken for landing
// below it; it is planned only to compare the view, and taken only where a cut is due and the band has no plan or one of another view.
// Room 1,000, lean band 600, mandatory input 100: a plan lands below the band when its `after` is at most 499.
type Target = 'band' | 'room';
type Tagged = Plan<{ tag: string }>;
const plan = (plans: Partial<Record<Target, Tagged>>, calls: Target[]) => (target: Target): Tagged => { calls.push(target); const p = plans[target]; if (!p) throw new Error('unexpected plan ' + target); return p; };
const draft = (after: number, tag: string, mode = 'bounded'): Tagged => ({ draft: true, after, mode, tag });
const nothing = (reason = 'no cut', capacityRejected = false): Tagged => ({ draft: false, capacityRejected, reason });
const fitsBelow = (tokens: number, limit: number) => tokens < limit;
const choose = (cutAt: number, total: number, plans: Partial<Record<Target, Tagged>>, calls: Target[] = [], before = 2000) =>
	decideCut({ total, mandatory: 100, before, room: 1000, band: bandOf(1000, cutAt), fits: fitsBelow, plan: plan(plans, calls), unreduced: 'did not reduce' });

test('a lean band is planned first and the room plan landing below it is not taken for that', () => {
	expect(bandOf(1000, 0.6)).toBe(600);
	// Inside the band: a band plan that lands is the cut, though the room plan lands below the band too; the room is planned only to compare the view.
	for (const total of [600, 999]) {
		const calls: Target[] = [];
		expect(choose(0.6, total, { band: draft(300, 'band'), room: draft(450, 'room') }, calls)).toEqual({ kind: 'cut', target: 'band', plan: { draft: true, after: 300, mode: 'bounded', tag: 'band' } });
		expect(calls).toEqual(['band', 'room']);
	}
	// A room plan that lands below the band does not rescue a band that has no plan, or whose plan does not land, or whose view differs: inside the band, nothing is cut.
	for (const [name, band] of [['no plan', nothing()], ['does not land', draft(500, 'band')], ['does not reduce', draft(2000, 'band')]] as const) {
		const calls: Target[] = [];
		expect(choose(0.6, 999, { band, room: draft(450, 'room') }, calls), name).toEqual({ kind: 'none' });
		expect(calls, name).toEqual(['band']);
	}
	const calls: Target[] = [];
	expect(choose(0.6, 999, { band: draft(300, 'band', 'shrunk'), room: draft(450, 'room', 'dialogue') }, calls)).toEqual({ kind: 'none' });
	expect(calls).toEqual(['band', 'room']);
	// At or above the room a cut is due: the band plan stands when the room has the same view or no plan; the room plan stands when the band has none or another view.
	for (const total of [1000, 5000]) {
		expect(choose(0.6, total, { band: draft(300, 'band'), room: draft(450, 'room') })).toMatchObject({ kind: 'cut', target: 'band', plan: { tag: 'band' } });
		expect(choose(0.6, total, { band: draft(300, 'band'), room: nothing() })).toMatchObject({ kind: 'cut', target: 'band' });
		expect(choose(0.6, total, { band: nothing(), room: draft(450, 'room') })).toMatchObject({ kind: 'cut', target: 'room', plan: { tag: 'room' } });
		expect(choose(0.6, total, { band: nothing(), room: draft(850, 'room') })).toMatchObject({ kind: 'cut', target: 'room' }); // fits the room, not the band
		expect(choose(0.6, total, { band: draft(300, 'band', 'shrunk'), room: draft(450, 'room', 'dialogue') })).toMatchObject({ kind: 'cut', target: 'room', plan: { tag: 'room' } });
	}
	// The exact room still owns every fault: no plan, no reduction, or a plan that does not fit the room.
	expect(choose(0.6, 1000, { band: nothing('band reason'), room: nothing('room reason', true) })).toEqual({ kind: 'fault', capacity: true, message: 'room reason' });
	expect(choose(0.6, 1000, { band: nothing(), room: draft(900, 'room') })).toEqual({ kind: 'fault', capacity: true, message: 'did not reduce' });
	expect(choose(0.6, 1000, { band: draft(300, 'band'), room: nothing() }, [], 300)).toEqual({ kind: 'fault', capacity: false, message: 'did not reduce' });
});

test('a band the cut point does not bind is not lean: the room is planned first and a room plan below the band is taken as before', () => {
	// F = 0.98 and above leave the band at the room less the margin (980), whatever F is.
	for (const cutAt of [1, 0.99, 0.98]) {
		expect(bandOf(1000, cutAt)).toBe(980);
		const calls: Target[] = [];
		expect(choose(cutAt, 999, { band: draft(300, 'band'), room: draft(450, 'room') }, calls)).toMatchObject({ kind: 'cut', target: 'room', plan: { tag: 'room' } });
		expect(calls).toEqual(['room']);
	}
	// F = 0.97 binds (the band is 970): lean.
	const calls: Target[] = [];
	expect(choose(0.97, 999, { band: draft(300, 'band'), room: draft(450, 'room') }, calls)).toMatchObject({ kind: 'cut', target: 'band' });
	expect(calls).toEqual(['band', 'room']);
});

// F = 0.6: the lean band is 86,400 of the room of 144,000 (the default band is 141,120).
test('the lean band is what the test below walks across', () => { expect(LEAN).toBe(86400); expect(LEAN).toBeLessThan(BAND); });

for (const at of ['prompt', 'tool'] as const)
test(`${at} boundary, cutAt 0.6: a request is cut from the first token at the lean band and not before`, async () => {
	const seen: { d: number; cuts: number }[] = [];
	for (const d of AROUND) {
		const r = await scenario({ at, complete: LEAN + d, host: HOST, compaction: { cutAt: F } });
		expect(r.measured!.complete, r.probe).toBe(LEAN + d);
		expect(r.faults, r.probe).toEqual([]);
		expect(r.requests, r.probe).toBe(at === 'tool' ? 2 : 1);
		for (const guarded of r.guard) expect(guarded, r.probe).toBeLessThan(ROOM);
		// The cut lands below the lean band, with the same arithmetic the guard sees, and records what it was made with.
		for (const entry of r.entries) {
			const receipt = receiptOf(entry);
			expect(receipt.tokensAfter + receipt.mandatoryInputTokens!, r.probe).toBeLessThan(LEAN);
			expect(receipt.cutAt, r.probe).toBe(F);
		}
		expectParity(r, { host: HOST, incoming: at === 'prompt' ? PROMPT : 0 }, { room: ROOM, band: LEAN });
		seen.push({ d, cuts: r.cuts });
	}
	const probe = JSON.stringify(seen);
	for (const s of seen) expect(s.cuts > 0, probe).toBe(s.d >= 0);
});

for (const at of ['prompt', 'tool'] as const)
test(`${at} boundary: a request inside the lean band is cut at cutAt 0.6 and left alone by the default`, async () => {
	// 100,000 is inside the lean band and far below the default one.
	const lean = await scenario({ at, complete: 100000, host: HOST, compaction: { cutAt: F } });
	const standard = await scenario({ at, complete: 100000, host: HOST });
	expect(lean.faults, lean.probe).toEqual([]);
	expect(standard.faults, standard.probe).toEqual([]);
	expect(lean.cuts, lean.probe).toBeGreaterThanOrEqual(1);
	expect(standard.cuts, standard.probe).toBe(0);
});

test('cutAt 0.6, Pi\'s own threshold ask: below the lean band it is declined, from the lean band up it yields the compactor\'s own decision', async () => {
	// Pi's usage threshold (window less compaction.reserveTokens) counts the last reply's output tokens too, so a large output makes it
	// ask for a cut on a request the compactor measures lower. The compactor answers with the same gate as its own triggers.
	const lean = bandOf(ROOM, F), GROWTH = 12000, CLEAR = 20;
	const base = { host: HOST, usageRatio: 0.998, outputTokens: 200000, fresh: 40000, at: 'tool' as const, compaction: { cutAt: F } };
	const observed = async (options: Parameters<typeof scenario>[0]) => {
		const asked: string[] = [];
		const r = await scenario({ ...options, onBeforeCompact: event => { asked.push(event.reason); } });
		return { ...r, asked };
	};
	// Below the lean band: Pi asks, the compactor declines (a plain cancel), and nothing else happens.
	const below = await observed({ ...base, complete: lean - CLEAR });
	expect(below.asked, below.probe).toContain('threshold');
	expect(below.faults, below.probe).toEqual([]); expect(below.aborts, below.probe).toBe(0); expect(below.cuts, below.probe).toBe(0);
	expect(below.requests, below.probe).toBe(2);
	for (const guarded of below.guard) expect(guarded, below.probe).toBeLessThan(ROOM);
	// At the first token of the lean band: the compactor's own trigger (the host view grows before the boundary) and Pi's call (it grows just
	// after the boundary's decision, so only Pi's later call sees all of it) make the same cut, down to the arithmetic it reserved. The two
	// conversations are built to the same size from differently sized tool results, so the size left may differ by a few tokens of rounding.
	const own = await observed({ ...base, complete: lean, afterDecision: (index, api) => { if (index === 0) api.growHost(GROWTH); } });
	const pi = await observed({ ...base, complete: lean - GROWTH, fresh: base.fresh - GROWTH, afterDecision: (index, api) => { if (index === 1) api.growHost(GROWTH); } });
	const probe = JSON.stringify({ own: own.probe, pi: pi.probe });
	expect(pi.asked, probe).toContain('threshold');
	for (const r of [own, pi]) { expect(r.faults, r.probe).toEqual([]); expect(r.aborts, r.probe).toBe(0); expect(r.requests, r.probe).toBe(2); for (const guarded of r.guard) expect(guarded, r.probe).toBeLessThan(ROOM); }
	expect(own.cuts, probe).toBeGreaterThan(0);
	expect(pi.cuts, probe).toBe(own.cuts);
	const decision = (entry: (typeof own.entries)[number]) => { const r = receiptOf(entry); return { target: r.target, mode: r.mode, view: r.view, mandatory: r.mandatoryInputTokens, host: r.hostInputTokens, reserved: r.draftReservedTokens, margin: r.triggerMarginTokens, cutAt: r.cutAt }; };
	expect(pi.entries.map(decision), probe).toEqual(own.entries.map(decision));
	for (let i = 0; i < own.entries.length; i++) expect(Math.abs(receiptOf(pi.entries[i]!).tokensAfter - receiptOf(own.entries[i]!).tokensAfter), probe).toBeLessThanOrEqual(20);
	for (const entry of own.entries) expect(receiptOf(entry).reason, probe).toBe('tool-loop');
	for (const entry of pi.entries) expect(receiptOf(entry).reason, probe).toBe('threshold');
});

test('cutAt 0.6, exact reply reserve: the band follows the exact room of the host (143,539 of 239,232)', async () => {
	const band = bandOf(ROOM_EXACT, F);
	expect(band).toBe(143539);
	for (const [d, cuts] of [[-1, 0], [0, 1]] as const) {
		const r = await scenario({ at: 'prompt', complete: band + d, host: HOST, reserveTokens: 0, compaction: { ...EXACT_RESERVE, cutAt: F } });
		expect(r.faults, r.probe).toEqual([]);
		expect(r.cuts, r.probe).toBe(cuts);
		for (const guarded of r.guard) expect(guarded, r.probe).toBeLessThan(ROOM_EXACT);
		expectParity(r, { host: HOST, incoming: PROMPT }, { room: ROOM_EXACT, band });
	}
});

// An irreducible request: a large prompt (protected from every cut), a little old history, a tiny tool result. The best cut removes only
// the old history, so it reaches the band only when the request is within that reduction of it.
const IRREDUCIBLE = { at: 'tool' as const, host: HOST, history: 1500, fresh: 100 };
const CAPACITY = "pi-tuck's mandatory context cannot fit or reduce the request budget";

test('cutAt 0.6, the guard is the exact room: between the lean band and the room a request that no cut can reduce is no fault; over the room it is', async () => {
	const depth = async (cutAt: number | undefined, ds: number[]) => {
		const band = bandOf(ROOM, cutAt), seen: { d: number; cuts: number }[] = [];
		for (const d of ds) {
			const r = await scenario({ ...IRREDUCIBLE, complete: band + d, compaction: { cutAt } });
			expect(r.measured!.complete, r.probe).toBe(band + d);
			// Sent as it stands, or cut to below the band: never a fault and never a rejection, up to the very last token below the room.
			expect(r.faults, r.probe).toEqual([]);
			expect(r.requests, r.probe).toBe(2); expect(r.effects, r.probe).toBe(1);
			for (const guarded of r.guard) expect(guarded, r.probe).toBeLessThan(ROOM);
			for (const entry of r.entries) expect(receiptOf(entry).tokensAfter + receiptOf(entry).mandatoryInputTokens!, r.probe).toBeLessThan(band);
			seen.push({ d, cuts: r.cuts });
		}
		return seen;
	};
	// The old history is all a cut can take. A lean cut must land below the band by a plan made for it, so it is taken no deeper into the band than
	// the default cut is (that one can take a room plan that happens to land below its band); neither is taken where the history cannot reach the band.
	const ds = [0, 100, 500, 1000, 2000, 2800];
	const lean = await depth(F, [...ds, ROOM - LEAN - 1, ROOM - LEAN - 100]);
	const standard = await depth(undefined, ds);
	for (let i = 0; i < ds.length; i++) expect(lean[i]!.cuts, JSON.stringify({ lean: lean[i], standard: standard[i] })).toBeLessThanOrEqual(standard[i]!.cuts);
	expect(lean.slice(0, 3).map(s => s.cuts), JSON.stringify(lean)).toEqual([1, 1, 1]);
	for (const s of [...lean.slice(4, ds.length), ...standard.slice(4)]) expect(s.cuts, JSON.stringify(s)).toBe(0);
	for (const s of lean.slice(ds.length)) expect(s.cuts, JSON.stringify(s)).toBe(0);
	// Over the room the very request fails closed, as it does at the default cut point: no request is made.
	for (const cutAt of [F, undefined]) {
		const r = await scenario({ ...IRREDUCIBLE, complete: ROOM + 1500, compaction: { cutAt } });
		expect(r.faults.length, r.probe).toBeGreaterThan(0);
		for (const fault of r.faults) expect(fault, r.probe).toContain(CAPACITY);
		expect(r.requests, r.probe).toBe(0); expect(r.effects, r.probe).toBe(0);
	}
});

test('a request that fits the room is never rejected, however low the cut point; one over it still fails closed', async () => {
	for (const cutAt of [0.001, 0.05, 0.3, 0.6, 0.9, 0.99, 1]) {
		for (const at of ['prompt', 'tool'] as const) {
			const fits = await scenario({ at, host: HOST, complete: ROOM - 1, compaction: { cutAt } });
			expect(fits.faults, `${cutAt} ${fits.probe}`).toEqual([]);
			expect(fits.requests, `${cutAt} ${fits.probe}`).toBe(at === 'tool' ? 2 : 1);
			for (const guarded of fits.guard) expect(guarded, `${cutAt} ${fits.probe}`).toBeLessThan(ROOM);
			// Over the room a cut is due and is made: a lean band takes nothing from that.
			const over = await scenario({ at, host: HOST, complete: ROOM + 1000, compaction: { cutAt } });
			expect(over.faults, `${cutAt} ${over.probe}`).toEqual([]);
			expect(over.cuts, `${cutAt} ${over.probe}`).toBeGreaterThanOrEqual(1);
			for (const guarded of over.guard) expect(guarded, `${cutAt} ${over.probe}`).toBeLessThan(ROOM);
		}
		const impossible = await scenario({ at: 'impossible', complete: 20000, host: ROOM + 5000, compaction: { cutAt } });
		expect(impossible.faults.join(' '), `${cutAt}`).toContain('Complete Pi context and response reserve exceed the estimated request budget');
	}
});

// A long prose history, which a summary cannot make small: with a low cut point the room plan no longer lands below the band, so the band is planned.
async function proseSession(cutAt: number | undefined, total: number) {
	const h = await harness({ at: 'prompt', complete: 20000, host: HOST, compaction: { cutAt } });
	try {
		let n = 0;
		const prose = (words: number) => Array.from({ length: words }, () => `word${(++n).toString(36)}`).join(' ');
		const requestSize = () => h.mandatory + nonSystem([h.hostInput()]) + nonSystem(h.saved()) + h.promptTokens();
		while (requestSize() < total) { h.manager.appendMessage({ role: 'user', content: prose(400), timestamp: 0 }); h.manager.appendMessage(h.answer([{ type: 'text', text: prose(400) }])); }
		const size = requestSize();
		return { size, ...await h.run() };
	} finally { await h.cleanup(); }
}

test('cutAt 0.3: the planner targets the lean band, and the cut leaves far less than the default cut leaves', async () => {
	const band = bandOf(ROOM, 0.3);
	expect(band).toBe(43200);
	// 101,000 tokens: inside the lean band, far below the default one.
	const lean = await proseSession(0.3, 101000), standard = await proseSession(undefined, 101000);
	expect(lean.faults, lean.probe).toEqual([]);
	expect(standard.cuts, standard.probe).toBe(0);
	expect(lean.cuts, lean.probe).toBe(1);
	const receipt = receiptOf(lean.entries[0]!);
	// The room plan does not land below the lean band, so the band was planned: its reserve is the window less the band, plus the mandatory input.
	expect(receipt.target, lean.probe).toBe('band');
	expect(receipt.cutAt, lean.probe).toBe(0.3);
	expect(receipt.tokensAfter + receipt.mandatoryInputTokens!, lean.probe).toBeLessThan(band);
	expectParity(lean, { host: HOST, incoming: PROMPT }, { room: ROOM, band });
	// Over the room both cut; the lean cut keeps less.
	const leanDue = await proseSession(0.3, ROOM + 500), standardDue = await proseSession(undefined, ROOM + 500);
	expect(leanDue.cuts, leanDue.probe).toBe(1); expect(standardDue.cuts, standardDue.probe).toBe(1);
	expect(receiptOf(standardDue.entries[0]!).target, standardDue.probe).toBe('room');
	expect(receiptOf(leanDue.entries[0]!).tokensAfter, leanDue.probe).toBeLessThan(receiptOf(standardDue.entries[0]!).tokensAfter / 2);
	for (const r of [lean, leanDue, standard, standardDue]) for (const guarded of r.guard) expect(guarded, r.probe).toBeLessThan(ROOM);
});

test('receipts: cutAt is recorded when it is not 1, and a default receipt is as it always was', async () => {
	const keys = (entry: Parameters<typeof receiptOf>[0]) => Object.keys((entry.details as { diagnosticReceipt: { settings: object } }).diagnosticReceipt.settings).sort();
	const lean = await scenario({ at: 'prompt', complete: ROOM + 10, host: HOST, compaction: { cutAt: F } });
	const standard = await scenario({ at: 'prompt', complete: ROOM + 10, host: HOST });
	const explicit = await scenario({ at: 'prompt', complete: ROOM + 10, host: HOST, compaction: { cutAt: 1 } });
	for (const r of [lean, standard, explicit]) expect(r.entries.length, r.probe).toBe(1);
	const [leanKeys, standardKeys, explicitKeys] = [lean, standard, explicit].map(r => keys(r.entries[0]!)) as [string[], string[], string[]];
	expect(receiptOf(lean.entries[0]!).cutAt).toBe(F);
	expect(receiptOf(lean.entries[0]!).triggerMarginTokens).toBe(ROOM - LEAN); // still room less band
	expect(standardKeys).not.toContain('cutAt');
	expect(explicitKeys).toEqual(standardKeys);
	expect(leanKeys).toEqual([...standardKeys, 'cutAt'].sort());
	expect(receiptOf(standard.entries[0]!).triggerMarginTokens).toBe(2880);
});

test('the default cut point is 0.6: with no cutAt a request past 60% of the room is cut, and its receipt records the cut point', async () => {
	expect(DEFAULT_CUT_AT).toBe(0.6);
	for (const at of ['prompt', 'tool'] as const) {
		const lean = bandOf(ROOM, DEFAULT_CUT_AT);
		const below = await scenario({ at, complete: lean - 1, host: HOST, cutAtDefault: true });
		expect(below.cuts, below.probe).toBe(0);
		const inside = await scenario({ at, complete: Math.floor((lean + BAND) / 2), host: HOST, cutAtDefault: true });
		expect(inside.cuts, inside.probe).toBe(1);
		expect(inside.entries.map(receiptOf)[0]?.cutAt, inside.probe).toBe(DEFAULT_CUT_AT);
		expect(inside.faults, inside.probe).toEqual([]);
	}
});

test('cutAt 1 restores the earlier cut point: the same requests give the same decisions, receipts and guard counts as the harness pin', async () => {
	for (const at of ['prompt', 'tool'] as const) for (const d of [-1, 0, 1, 500, 5000]) for (const base of [BAND, ROOM]) {
		const complete = base + d;
		if (complete >= ROOM + 1500) continue;
		const standard = await scenario({ at, complete, host: HOST });
		const explicit = await scenario({ at, complete, host: HOST, compaction: { cutAt: 1 } });
		const outcome = (r: typeof standard) => ({ cuts: r.cuts, requests: r.requests, effects: r.effects, guard: r.guard, faults: r.faults, receipts: r.entries.map(receiptOf) });
		expect(outcome(explicit), `${at} ${complete}`).toEqual(outcome(standard));
	}
});
