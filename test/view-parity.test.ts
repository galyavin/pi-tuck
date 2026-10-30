import { test, expect } from 'vitest';
import { BAND, HOST, ROOM, WINDOW, harness, receiptOf, referenceSystemPart } from './budget-fixture';
import { measurableConversationTokens, planningReserve } from '../src/budget';
import { tuck, tuckDraft, tuckObservedDraft, type DraftMode } from '../src/tuck';

// The margin changes when a cut happens, not what a cut keeps. The exact room is planned first: when its plan already lands below the band
// it is taken as it is (every allowance of the planner derives from the reserve, so the band's plan can carry less of the same view). Only
// otherwise is the band planned. Inside the band, where the exact room would cut nothing, a band cut is taken only when the room plan exists
// and has the same mode; at or above the room a band plan of another mode gives way to the room plan, and a band plan stands where the room
// has none (a cut instead of a fault).
// The two plans are computed here independently, with the same functions and the same state as the compactor's, and the compactor's cut
// (target, mode, size and the summary itself) is compared with this rule.
interface Planned { mode: DraftMode; after: number; summary: string }
type Plan = Planned | null;
const planned = (d: { compaction?: { summary: string }; after?: number; mode?: DraftMode }): Plan => d.compaction ? { mode: d.mode!, after: d.after!, summary: d.compaction.summary } : null;
type Expected = { kind: 'none' } | { kind: 'fault' } | { kind: 'cut'; target: 'band' | 'room'; plan: Planned };
function rule(room: Plan, band: Plan, before: number, mandatory: number, total: number): Expected {
	const fitsBand = (p: Planned) => p.after < before && p.after + mandatory < BAND;
	if (room && fitsBand(room)) return { kind: 'cut', target: 'room', plan: room };
	if (total < ROOM) return band && fitsBand(band) && room && room.mode === band.mode ? { kind: 'cut', target: 'band', plan: band } : { kind: 'none' };
	if (!band && !room) return { kind: 'fault' };
	return band && (!room || room.mode === band.mode) ? { kind: 'cut', target: 'band', plan: band } : { kind: 'cut', target: 'room', plan: room! };
}
const MANDATORY_MANUAL = 12052 + HOST;

async function manualCut(latest: number) {
	let found: { band: Plan; room: Plan; before: number } | undefined;
	const h = await harness({ at: 'prompt', complete: 60000, host: HOST, onBeforeCompact: (event, ctx) => {
		const measure = (messages: Parameters<typeof measurableConversationTokens>[0]) => measurableConversationTokens(messages, ctx);
		const plan = (limit: number): Plan => planned(tuckDraft(tuck, event, ctx, planningReserve(WINDOW, limit, 1, MANDATORY_MANUAL), measure, {}, true, true));
		found = { room: plan(ROOM), band: plan(BAND), before: measure(ctx.sessionManager.buildSessionProjection().messages) };
	} });
	try {
		h.manager.appendMessage({ role: 'user', content: 'q'.repeat(4 * latest), timestamp: 0 });
		let compacted = true;
		try { await h.session.compact(); } catch { compacted = false; }
		return { ...found!, compacted, entries: h.compactions(), faults: [...h.faults] };
	} finally { await h.cleanup(); }
}

test('an operator cut takes the room plan when it lands below the band, else the band plan of the room plan\'s view, else the room plan', async () => {
	const seen = { 'room below the band': 0, 'band, same view': 0, 'room over a band plan': 0, 'room only': 0, refused: 0 };
	for (let latest = 112000; latest <= 126000; latest += 500) {
		const { room, band, before, compacted, entries, faults } = await manualCut(latest);
		const why = JSON.stringify({ latest, room: room && [room.mode, room.after], band: band && [band.mode, band.after], entries: entries.map(receiptOf), faults });
		expect(faults, why).toEqual([]);
		// Total of an operator cut: nothing waits on the request, so a cut is always due.
		const expected = rule(room, band, before, MANDATORY_MANUAL, ROOM);
		if (expected.kind === 'fault') { seen.refused++; expect(compacted, why).toBe(false); continue; }
		expect(expected.kind, why).toBe('cut');
		if (expected.kind !== 'cut') continue;
		expect(compacted, why).toBe(true);
		expect(entries, why).toHaveLength(1);
		const receipt = receiptOf(entries[0]!);
		expect([receipt.target, receipt.mode, receipt.tokensAfter], why).toEqual([expected.target, expected.plan.mode, expected.plan.after]);
		// The summary is the planned one, to the byte.
		expect(entries[0]!.summary === expected.plan.summary, why).toBe(true);
		if (expected.target === 'room') seen[band && room && room.after + MANDATORY_MANUAL < BAND ? 'room below the band' : band ? 'room over a band plan' : 'room only']++;
		else seen['band, same view']++;
	}
	// The sweep passes through every case the two views produce here. A room plan over a band plan needed a view whose size follows the
	// allowance (the retired bounded view); decide-cut-property.test.ts covers that branch of the unchanged rule.
	const stats = JSON.stringify(seen);
	expect(seen['room below the band'], stats).toBeGreaterThan(5);
	expect(seen['room only'], stats).toBeGreaterThan(2); expect(seen.refused, stats).toBeGreaterThan(0);
});

// At a tool boundary the compactor plans the cut itself; the same two plans, from the same state, are computed in a hook that runs first.
async function boundary(options: { history: number; oneTurn: boolean; complete: number }) {
	const found: { band: Plan; room: Plan; before: number; mandatory: number; total: number }[] = [];
	const h = await harness({ at: 'tool', host: HOST, fresh: 100, ...options, onBoundary: (event: { context: { contextMessages: Parameters<typeof measurableConversationTokens>[0] } }, ctx) => {
		const measure = (messages: Parameters<typeof measurableConversationTokens>[0]) => measurableConversationTokens(messages, ctx);
		const saved = event.context.contextMessages, pi = h.extension();
		const toolsJson = JSON.stringify(pi.getAllTools().filter(t => pi.getActiveTools().includes(t.name)).map(t => ({ name: t.name, description: t.description, parameters: t.parameters })));
		const mandatory = referenceSystemPart(saved, ctx.getSystemPrompt(), toolsJson) + HOST, before = measure(saved);
		const plan = (limit: number): Plan => planned(tuckObservedDraft(tuck, { branchEntries: ctx.sessionManager.getBranch(), tokensBefore: before }, ctx, planningReserve(WINDOW, limit, 1, mandatory), measure, {}, true));
		found.push({ room: plan(ROOM), band: plan(BAND), before, mandatory, total: before + mandatory });
	} });
	try {
		const r = await h.run();
		return { r, found, tool: { cut: r.cutsAtRequest[1]! - r.cutsAtProbe[1]!, entry: r.entries.at(-1) } };
	} finally { await h.cleanup(); }
}

test('at a tool boundary a cut follows the rule', async () => {
	const seen = { 'declined: another view': 0, 'band cut: same view': 0, 'declined: out of reach': 0, 'declined: no room plan': 0, 'room below the band': 0, 'room over a band plan': 0, 'forced band plan': 0, 'forced room plan only': 0 };
	for (const oneTurn of [false, true]) for (const history of [1500, 3000, 6000]) for (const d of [100, 600, 1200, 1800, 2400, 2800, 3200, 4000]) {
		const { r, found, tool } = await boundary({ history, oneTurn, complete: BAND + d });
		// A request over the room at the prompt that nothing can cut fails closed there, before any tool boundary.
		if (!found.length) { expect(r.requests, r.probe).toBe(0); continue; }
		const f = found[0]!, why = JSON.stringify({ oneTurn, history, d, room: f.room && [f.room.mode, f.room.after], band: f.band && [f.band.mode, f.band.after], total: f.total, cut: tool.cut });
		expect(found, why).toHaveLength(1);
		const receipt = tool.entry && tool.cut ? receiptOf(tool.entry) : undefined;
		if (f.total < BAND) { expect(tool.cut, why).toBe(0); continue; }
		const expected = rule(f.room, f.band, f.before, f.mandatory, f.total);
		if (expected.kind === 'fault') continue; // fails closed, as before the margin
		if (expected.kind === 'none') {
			expect(tool.cut, why).toBe(0); expect(r.faults, why).toEqual([]);
			seen[!f.band || !(f.band.after < f.before && f.band.after + f.mandatory < BAND) ? 'declined: out of reach' : f.room ? 'declined: another view' : 'declined: no room plan']++;
			continue;
		}
		expect([tool.cut, receipt?.target, receipt?.mode, receipt?.tokensAfter], why).toEqual([1, expected.target, expected.plan.mode, expected.plan.after]);
		expect(tool.entry!.summary === expected.plan.summary, why).toBe(true);
		if (expected.target === 'room' && f.room && f.room.after < f.before && f.room.after + f.mandatory < BAND) seen['room below the band']++;
		else if (expected.target === 'room') seen[f.band ? 'room over a band plan' : 'forced room plan only']++;
		else seen[f.total < ROOM ? 'band cut: same view' : 'forced band plan']++;
	}
	// A declined band plan of another view and a band-target cut needed a view whose size follows the allowance (the retired bounded
	// view): the dialogue view is the same at both limits. decide-cut-property.test.ts covers those branches of the unchanged rule.
	const stats = JSON.stringify(seen);
	expect(seen['declined: out of reach'], stats).toBeGreaterThan(0);
	expect(seen['room below the band'], stats).toBeGreaterThan(0);
	expect(seen['forced room plan only'], stats).toBeGreaterThan(0);
});

test('the request that the margin would have cut to a poorer view is sent as it stands', async () => {
	// Inside the band (2,800 tokens in), the room plan keeps the whole dialogue but does not reach the band, and the band has no plan of
	// that view. Before the amendment such a request was cut to a poorer band view; the exact room would have cut nothing.
	// History 2,500 meets the precondition from 2,400 to 2,850 tokens into the band; the scenario sits inside that range, since summary
	// sizes from earlier cuts shift the run's estimate calibration.
	const { r, found, tool } = await boundary({ history: 2500, oneTurn: false, complete: BAND + 2800 });
	const f = found[0]!;
	expect(f.room?.mode, r.probe).toBe('dialogue');
	expect(f.band === null || f.band.mode !== f.room!.mode, r.probe).toBe(true);
	expect(tool.cut, r.probe).toBe(0);
	expect(r.faults, r.probe).toEqual([]);
	expect(r.requests, r.probe).toBe(2);
	expect(r.guard.at(-1)!, r.probe).toBeLessThan(ROOM);
});

// At the prompt the cut goes through Pi (session_before_compact); the incoming prompt is mandatory input. Same two plans, from the same state.
async function prompt(options: { history: number; complete: number }) {
	const found: { band: Plan; room: Plan; before: number; mandatory: number; total: number }[] = [];
	const h = await harness({ at: 'prompt', host: HOST, ...options, onBeforeCompact: (event, ctx) => {
		const measure = (messages: Parameters<typeof measurableConversationTokens>[0]) => measurableConversationTokens(messages, ctx);
		const mandatory = h.promptTokens() + h.mandatory + HOST, before = measure(ctx.sessionManager.buildSessionProjection().messages);
		const plan = (limit: number): Plan => planned(tuckDraft(tuck, event, ctx, planningReserve(WINDOW, limit, 1, mandatory), measure, {}, false, false));
		found.push({ room: plan(ROOM), band: plan(BAND), before, mandatory, total: before + mandatory });
	} });
	try { const r = await h.run(); return { r, found, cut: r.cutsAtRequest[0]! - r.cutsAtProbe[0]!, entry: r.entries[0] }; } finally { await h.cleanup(); }
}

test('at the prompt a cut follows the same rule', async () => {
	const seen = { 'declined: no room plan': 0, 'declined: another view': 0, 'band cut: same view': 0, 'room below the band': 0, 'room over a band plan': 0, 'forced band plan': 0 };
	for (const history of [1500, 2500, 4000, 8000, 20000]) for (const d of [100, 800, 1600, 2400, 2800, 2900, 3400, 4500]) {
		const { r, found, cut, entry } = await prompt({ history, complete: BAND + d });
		const why = JSON.stringify({ history, d, found: found[0] && { room: found[0].room && [found[0].room.mode, found[0].room.after], band: found[0].band && [found[0].band.mode, found[0].band.after], total: found[0].total }, cut, probe: r.probe });
		if (!found.length) { expect(cut, why).toBe(0); continue; } // below the band: no cut was asked for
		const f = found[0]!, receipt = entry && cut ? receiptOf(entry) : undefined;
		const expected = rule(f.room, f.band, f.before, f.mandatory, f.total);
		if (expected.kind === 'fault') continue; // fails closed, as before the margin
		if (expected.kind === 'none') {
			expect(cut, why).toBe(0); expect(r.faults, why).toEqual([]);
			const reaches = f.band && f.band.after < f.before && f.band.after + f.mandatory < BAND;
			if (reaches) seen[f.room ? 'declined: another view' : 'declined: no room plan']++;
			continue;
		}
		expect([cut, receipt?.target, receipt?.mode, receipt?.tokensAfter], why).toEqual([1, expected.target, expected.plan.mode, expected.plan.after]);
		expect(entry!.summary === expected.plan.summary, why).toBe(true);
		if (expected.target === 'room' && f.room && f.room.after < f.before && f.room.after + f.mandatory < BAND) seen['room below the band']++;
		else if (expected.target === 'room') seen['room over a band plan']++;
		else seen[f.total < ROOM ? 'band cut: same view' : 'forced band plan']++;
	}
	const stats = JSON.stringify(seen);
	expect(seen['declined: no room plan'], stats).toBeGreaterThan(0);
	expect(seen['room below the band'] + seen['band cut: same view'], stats).toBeGreaterThan(0);
	expect(seen['band cut: same view'] + seen['forced band plan'] + seen['room over a band plan'], stats).toBeGreaterThan(0);
});

test('the lossy ranked band cut of the fixture is declined inside the band, where the exact room cannot plan, and kept when a cut is due', async () => {
	// 1,500 tokens of old history under a protected prompt: inside the band the band plan is a 212-token ranked summary, and the exact room
	// has no plan at all. Before the ruling this was cut to the ranked view; the exact room would have cut nothing.
	const inBand = await prompt({ history: 1500, complete: BAND + 1100 });
	expect(inBand.found[0]!.band?.mode, inBand.r.probe).toBe('ranked');
	expect(inBand.found[0]!.room, inBand.r.probe).toBeNull();
	expect(inBand.cut, inBand.r.probe).toBe(0);
	expect(inBand.r.faults, inBand.r.probe).toEqual([]);
	expect(inBand.r.requests, inBand.r.probe).toBe(1);
	expect(inBand.r.guard[0]!, inBand.r.probe).toBeLessThan(ROOM);
});

test('a room plan that already lands below the band is taken as it is, to the byte, although a band plan of the same view exists', async () => {
	// Every allowance of the planner derives from the reserve, and the band's is 2% smaller. The dialogue view does not depend on the
	// allowance, so the band plan of the same view is no smaller here; the rule still takes the room plan and keeps its content.
	for (const history of [60000, 90000, 110000, 125000]) {
		const { r, found, tool } = await boundary({ history, oneTurn: true, complete: BAND + 100 });
		const f = found[0]!, why = JSON.stringify({ history, room: f.room && [f.room.mode, f.room.after, f.room.summary.length], band: f.band && [f.band.mode, f.band.after, f.band.summary.length], probe: r.probe });
		expect(f.room && f.band, why).toBeTruthy();
		// The precondition: the same mode and a room plan far below the band.
		expect(f.room!.mode, why).toBe(f.band!.mode);
		expect(f.room!.after + f.mandatory, why).toBeLessThan(BAND);
		// The cut is the room plan, byte for byte.
		expect(tool.cut, why).toBe(1);
		expect(receiptOf(tool.entry!).target, why).toBe('room');
		expect(tool.entry!.summary === f.room!.summary, why).toBe(true);
		expect(receiptOf(tool.entry!).tokensAfter, why).toBe(f.room!.after);
	}
});
