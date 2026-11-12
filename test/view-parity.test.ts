import { test, expect } from 'vitest';
import { BAND, HOST, ROOM, WINDOW, harness, receiptOf, referenceSystemPart } from './budget-fixture';
import { measurableConversationTokens, planningReserve } from '../src/budget';
import { tuck, tuckDraft, tuckObservedDraft, type DraftMode } from '../src/tuck';

// Compare saved cuts with independently compiled plans at the numeric targets.
// The band always goes first; a due cut uses the room only if the band has no
// draft. Form labels are checked only as diagnostic output after selection.
interface Planned { mode: DraftMode; after: number; summary: string }
type Plan = Planned | null;
const planned = (d: { compaction?: { summary: string }; after?: number; mode?: DraftMode }): Plan => d.compaction ? { mode: d.mode!, after: d.after!, summary: d.compaction.summary } : null;
type Expected = { kind: 'none' } | { kind: 'fault' } | { kind: 'cut'; target: 'band' | 'room'; plan: Planned };
function rule(room: Plan, band: Plan, before: number, mandatory: number, total: number, at: 'prompt' | 'tool' = 'prompt'): Expected {
	if (at === 'tool' && total < ROOM) return { kind: 'none' };
	const fitsBand = (p: Planned) => p.after < before && p.after + mandatory < BAND;
	if (total < ROOM) return band && fitsBand(band) ? { kind: 'cut', target: 'band', plan: band } : { kind: 'none' };
	if (!band && !room) return { kind: 'fault' };
	return band ? { kind: 'cut', target: 'band', plan: band } : { kind: 'cut', target: 'room', plan: room! };
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

test('an operator cut takes a band draft before any room fallback', async () => {
	const seen = { 'band': 0, 'room only': 0, refused: 0 };
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
		if (expected.target === 'room') seen['room only']++;
		else seen.band++;
	}
	// The sweep covers a band draft, a missing-band fallback and a refusal.
	const stats = JSON.stringify(seen);
	expect(seen.band, stats).toBeGreaterThan(5);
	expect(seen['room only'], stats).toBeGreaterThan(2); expect(seen.refused, stats).toBeGreaterThan(0);
});

// At a tool boundary the compactor plans the cut itself; the same two plans, from the same state, are computed in a hook that runs first.
async function boundary(options: { history: number; oneTurn: boolean; complete: number; fresh?: number }) {
	const found: { band: Plan; room: Plan; before: number; mandatory: number; total: number }[] = [];
	const h = await harness({ at: 'tool', host: HOST, ...options, fresh: options.fresh ?? 100, onBoundary: (event: { context: { contextMessages: Parameters<typeof measurableConversationTokens>[0] } }, ctx) => {
		const measure = (messages: Parameters<typeof measurableConversationTokens>[0]) => measurableConversationTokens(messages, ctx);
		const saved = event.context.contextMessages, pi = h.extension();
		const toolsJson = JSON.stringify(pi.getAllTools().filter(t => pi.getActiveTools().includes(t.name)).map(t => ({ name: t.name, description: t.description, parameters: t.parameters })));
		const mandatory = referenceSystemPart(saved, ctx.getSystemPrompt(), toolsJson) + HOST, before = measure(saved);
		const plan = (limit: number): Plan => planned(tuckObservedDraft(tuck, { branchEntries: ctx.sessionManager.getBranch(), tokensBefore: before }, ctx, planningReserve(WINDOW, limit, 1, mandatory), measure, {}, true));
		found.push({ room: plan(ROOM), band: plan(BAND), before, mandatory, total: before + mandatory });
	} });
	try {
		const r = await h.run();
		// The tool boundary's own cut; the same boundary also saves a cut the prompt needed, which the reference above cannot see.
		const own = r.entries.filter(entry => receiptOf(entry).reason === 'tool-loop');
		return { r, found, promptCut: r.entries.some(entry => receiptOf(entry).reason === 'prompt'), tool: { cut: own.length, entry: own.at(-1) } };
	} finally { await h.cleanup(); }
}

test('at a tool boundary a cut follows the rule', async () => {
	const seen = { 'waited: band reachable': 0, 'waited: out of reach': 0, 'forced band plan': 0, 'forced room plan only': 0 };
	// A fresh result of 6,000 tokens brings the request over the band only at the tool boundary, so the prompt makes no cut of its own.
	for (const fresh of [100, 6000]) for (const oneTurn of [false, true]) for (const history of [1500, 3000, 6000]) for (const d of [100, 600, 1200, 1800, 2400, 2800, 3200, 4000]) {
		const { r, found, tool, promptCut } = await boundary({ history, oneTurn, complete: BAND + d, fresh });
		// A request over the room at the prompt that nothing can cut fails closed there, before any tool boundary.
		if (!found.length) { expect(r.requests, r.probe).toBe(0); continue; }
		// The prompt's own cut is held to the rule at the prompt (below); here every request it carried fits.
		if (promptCut) { expect(r.faults, r.probe).toEqual([]); for (const guarded of r.guard) expect(guarded, r.probe).toBeLessThan(ROOM); continue; }
		const f = found[0]!, why = JSON.stringify({ oneTurn, history, d, room: f.room && [f.room.mode, f.room.after], band: f.band && [f.band.mode, f.band.after], total: f.total, cut: tool.cut });
		expect(found, why).toHaveLength(1);
		const receipt = tool.entry && tool.cut ? receiptOf(tool.entry) : undefined;
		if (f.total < BAND) { expect(tool.cut, why).toBe(0); continue; }
		const expected = rule(f.room, f.band, f.before, f.mandatory, f.total, 'tool');
		if (expected.kind === 'fault') continue; // fails closed, as before the margin
		if (expected.kind === 'none') {
			expect(tool.cut, why).toBe(0); expect(r.faults, why).toEqual([]);
			expect(r.requests, why).toBe(2);
			for (const guarded of r.guard) expect(guarded, why).toBeLessThan(ROOM);
			seen[f.band && f.band.after + f.mandatory < BAND ? 'waited: band reachable' : 'waited: out of reach']++;
			continue;
		}
		expect([tool.cut, receipt?.target, receipt?.mode, receipt?.tokensAfter], why).toEqual([1, expected.target, expected.plan.mode, expected.plan.after]);
		expect(tool.entry!.summary === expected.plan.summary, why).toBe(true);
		if (expected.target === 'room') seen['forced room plan only']++;
		else seen['forced band plan']++;
	}
	// Numeric landing and fallback branches remain covered by real tool rounds.
	const stats = JSON.stringify(seen);
	expect(seen['waited: out of reach'], stats).toBeGreaterThan(0);
	expect(seen['waited: band reachable'], stats).toBeGreaterThan(0);
	expect(seen['forced band plan'], stats).toBeGreaterThan(0);
	expect(seen['forced room plan only'], stats).toBeGreaterThan(0);
}, 120000);

test('a tool boundary with different plan forms follows the amount-only rule', async () => {
	// The independently observed offers may have different forms or no band
	// draft; the numeric landing, rather than form parity, decides the cut.
	const { r, found, tool } = await boundary({ history: 2500, oneTurn: false, complete: BAND + 2800 });
	const f = found[0]!;
	expect(f.room?.mode, r.probe).toBe('dialogue');
	expect(f.band === null || f.band.mode !== f.room!.mode, r.probe).toBe(true);
	const expected = rule(f.room, f.band, f.before, f.mandatory, f.total, 'tool');
	expect(tool.cut, r.probe).toBe(expected.kind === 'cut' ? 1 : 0);
	expect(r.faults, r.probe).toEqual([]);
	expect(r.requests, r.probe).toBe(2);
	expect(r.guard.at(-1)!, r.probe).toBeLessThan(ROOM);
});

// At the prompt the compactor plans the cut itself, as at a tool boundary; the incoming prompt is mandatory input. Same two plans, from the
// same state, computed in a hook that runs first. The run's first request carries the cut, and its first boundary saves it.
async function prompt(options: { history: number; complete: number }) {
	const found: { band: Plan; room: Plan; before: number; mandatory: number; total: number }[] = [];
	const h = await harness({ at: 'prompt', host: HOST, ...options, onPrompt: ctx => {
		const measure = (messages: Parameters<typeof measurableConversationTokens>[0]) => measurableConversationTokens(messages, ctx);
		const mandatory = h.promptTokens() + h.mandatory + HOST, before = measure(ctx.sessionManager.buildSessionProjection().messages);
		if (before + mandatory < BAND) return;
		const plan = (limit: number): Plan => planned(tuckObservedDraft(tuck, { branchEntries: ctx.sessionManager.getBranch(), tokensBefore: before, newPrompt: true }, ctx, planningReserve(WINDOW, limit, 1, mandatory), measure, {}, false));
		found.push({ room: plan(ROOM), band: plan(BAND), before, mandatory, total: before + mandatory });
	} });
	try { const r = await h.run(); const entries = r.entries.filter(entry => receiptOf(entry).reason === 'prompt'); return { r, found, cut: entries.length, entry: entries[0] }; } finally { await h.cleanup(); }
}

test('at the prompt a cut follows the same rule', async () => {
	const seen = { 'declined: out of reach': 0, 'band cut': 0, 'room fallback': 0, 'forced band plan': 0 };
	for (const history of [1500, 2500, 4000, 8000, 20000]) for (const d of [100, 800, 1600, 2400, 2800, 2900, 3400, 4500]) {
		const { r, found, cut, entry } = await prompt({ history, complete: BAND + d });
		const why = JSON.stringify({ history, d, found: found[0] && { room: found[0].room && [found[0].room.mode, found[0].room.after], band: found[0].band && [found[0].band.mode, found[0].band.after], total: found[0].total }, cut, probe: r.probe });
		if (!found.length) { expect(cut, why).toBe(0); continue; } // below the band: no cut was asked for
		const f = found[0]!, receipt = entry && cut ? receiptOf(entry) : undefined;
		const expected = rule(f.room, f.band, f.before, f.mandatory, f.total);
		if (expected.kind === 'fault') continue; // fails closed, as before the margin
		if (expected.kind === 'none') {
			expect(cut, why).toBe(0); expect(r.faults, why).toEqual([]);
			seen['declined: out of reach']++;
			continue;
		}
		expect([cut, receipt?.target, receipt?.mode, receipt?.tokensAfter], why).toEqual([1, expected.target, expected.plan.mode, expected.plan.after]);
		expect(entry!.summary === expected.plan.summary, why).toBe(true);
		if (expected.target === 'room') seen['room fallback']++;
		else seen[f.total < ROOM ? 'band cut' : 'forced band plan']++;
	}
	const stats = JSON.stringify(seen);
	expect(seen['band cut'], stats).toBeGreaterThan(0);
	expect(seen['band cut'] + seen['forced band plan'] + seen['room fallback'], stats).toBeGreaterThan(0);
});


test('a due tool cut takes the band draft to the byte even when the room plan also lands below the band', async () => {
	// Even when both targets produce the same diagnostic form and fit the band,
	// the saved bytes must come from the band draft.
	for (const history of [60000, 90000, 110000, 125000]) {
		const { r, found, tool } = await boundary({ history, oneTurn: true, complete: ROOM + 100, fresh: 3000 });
		const f = found[0]!, why = JSON.stringify({ history, room: f.room && [f.room.mode, f.room.after, f.room.summary.length], band: f.band && [f.band.mode, f.band.after, f.band.summary.length], probe: r.probe });
		expect(f.room && f.band, why).toBeTruthy();
		// The precondition: the same mode and a room plan far below the band.
		expect(f.room!.mode, why).toBe(f.band!.mode);
		expect(f.room!.after + f.mandatory, why).toBeLessThan(BAND);
		// The cut is the band plan, byte for byte.
		expect(tool.cut, why).toBe(1);
		expect(receiptOf(tool.entry!).target, why).toBe('band');
		expect(tool.entry!.summary === f.band!.summary, why).toBe(true);
		expect(receiptOf(tool.entry!).tokensAfter, why).toBe(f.band!.after);
	}
});
