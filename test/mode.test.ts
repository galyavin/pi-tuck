import { test, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { BAND, HOST, ROOM, harness, receiptOf, scenario } from './budget-fixture';
import { conversationTokens, measurableConversationTokens, projectedConversationTokens } from '../src/budget';
import { piTuck, piTuckObservedDraft, type DraftMode, type PiTuck } from '../src/pi-tuck';

// Each cut records which summary view produced it: the compiler's ladder (bounded, masked, full, dialogue-only) or the ranked fallback.
// Before this, every complete view was labelled "complete-dialogue", so a regression from a summary with tool actions to a dialogue-only
// one was invisible.
const MODES: DraftMode[] = ['bounded', 'masked', 'full', 'dialogue', 'ranked'];
const OMITTED_ACTIONS = 'Historical tool actions and observations omitted';
const OMITTED_BODY = 'Historical observation body omitted';
const BODY = 'Observed mechanical test data.';

function session(rounds = 12) {
	const dir = mkdtempSync(join(tmpdir(), 'pi-mode-'));
	const manager = SessionManager.inMemory(dir);
	const answer = (content: never[] | { type: 'text'; text: string }[] | { type: 'toolCall'; id: string; name: string; arguments: object }[], stopReason: 'stop' | 'toolUse' = 'stop') => ({ role: 'assistant' as const, content, stopReason, api: 'openai-responses', provider: 'openai', model: 'm', timestamp: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } } });
	// Alternate bulky receipts (over the 8,000-character bound: never in a summary) and small ones (quoted whole when the view allows).
	const size = (i: number) => i % 2 ? 400 : 3000;
	for (let i = 0; i < rounds; i++) {
		manager.appendMessage({ role: 'user', content: `Earlier request ${i}`, timestamp: 0 });
		manager.appendMessage(answer([{ type: 'toolCall', id: `c${i}`, name: 'read', arguments: { path: `f${i}` } }] as never, 'toolUse') as never);
		manager.appendMessage({ role: 'toolResult', toolCallId: `c${i}`, toolName: 'read', isError: false, timestamp: 0, content: [{ type: 'text', text: (BODY + ' ').repeat(Math.ceil(size(i) * 4 / (BODY.length + 1))).slice(0, size(i) * 4) }] });
		manager.appendMessage(answer([{ type: 'text', text: `Observed result ${i}` }]) as never);
	}
	manager.appendMessage({ role: 'user', content: 'Latest request', timestamp: 0 });
	const ctx = { sessionManager: manager, cwd: dir, model: { contextWindow: 272000, maxTokens: 128000 } } as unknown as ExtensionContext;
	return { manager, ctx, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

// Force the ladder to one mode: every other mode's offer is too large to be admitted.
const forcing = (target: DraftMode): PiTuck => ({ ...piTuck, compileResidual: (input, bodies, ceiling, dialogue) => {
	const mode = dialogue ? 'dialogue' : ceiling !== undefined ? 'bounded' : bodies ? 'full' : 'masked';
	return mode === target ? piTuck.compileResidual!(input, bodies, ceiling, dialogue) : 'z'.repeat(3 * input.ranking.maxBriefChars + 1);
} });

for (const target of MODES)
test(`the mode recorded is the view that produced the summary: ${target}`, () => {
	const s = session();
	try {
		const measure = (messages: Parameters<typeof conversationTokens>[0]) => measurableConversationTokens(messages, s.ctx);
		const draft = piTuckObservedDraft(forcing(target), { branchEntries: s.manager.getBranch(), tokensBefore: measure(s.manager.buildSessionProjection().messages) }, s.ctx, 272000 - 120000, measure, {}, true);
		if (!draft.compaction) throw new Error(draft.unavailable);
		const details = draft.compaction.details as { mode: string; view: string; tokensAfter: number };
		expect(details.mode).toBe(target);
		expect(details.view).toBe(target === 'ranked' ? 'ranked' : 'complete-dialogue');
		const summary = draft.compaction.summary;
		// The summary has the content of its view.
		if (target === 'dialogue') { expect(summary).toContain(OMITTED_ACTIONS); expect(summary).not.toContain(BODY); }
		if (target === 'masked') { expect(summary).toContain(OMITTED_BODY); expect(summary).not.toContain(BODY); expect(summary).not.toContain(OMITTED_ACTIONS); }
		if (target === 'bounded' || target === 'full') { expect(summary).toContain(BODY); expect(summary).not.toContain(OMITTED_ACTIONS); }
	} finally { s.dispose(); }
});

test('the planner counts the draft with the supplied measure: the same function the triggers use, wrapper and all', () => {
	const s = session();
	try {
		const calls: number[] = [];
		// A measure that is not Pi's raw estimate: the converted conversation plus a constant. The draft must report exactly it.
		const measure = (messages: Parameters<typeof conversationTokens>[0]) => { const n = measurableConversationTokens(messages, s.ctx) + 1000; calls.push(n); return n; };
		const before = measure(s.manager.buildSessionProjection().messages);
		const draft = piTuckObservedDraft(piTuck, { branchEntries: s.manager.getBranch(), tokensBefore: before }, s.ctx, 272000 - 120000, measure, {}, true);
		if (!draft.compaction) throw new Error(draft.unavailable);
		// Independent reference: the new summary in a native preview, converted by Pi (it is wrapped), counted by Pi, plus the constant.
		const header = s.manager.getHeader()!;
		const preview = SessionManager.inMemory(s.ctx.cwd, undefined, [header, ...s.manager.getBranch()]);
		preview.appendCompaction(draft.compaction.summary, draft.compaction.firstKeptEntryId, before, draft.compaction.details, true);
		const expected = conversationTokens(preview.buildSessionProjection().messages) + 1000;
		expect(draft.after).toBe(expected);
		expect((draft.compaction.details as { tokensAfter: number }).tokensAfter).toBe(expected);
		// And it is more than the raw message alone would be: the wrapper is counted.
		const raw = preview.buildSessionProjection().messages.reduce((n, m) => n + (m.role === 'compactionSummary' ? Math.ceil(m.summary.length / 4) : 0), 0);
		expect(conversationTokens(preview.buildSessionProjection().messages)).toBeGreaterThanOrEqual(raw + 20);
		expect(calls.length).toBeGreaterThanOrEqual(3); // before, base and at least one candidate
	} finally { s.dispose(); }
});

test('an empty summary is refused as "extracted no summary" before its preview is built or counted, even by a strict measure', () => {
	const s = session();
	try {
		// The strict measure would throw on an empty summary ("unsupported compaction summary"); it is never asked to count one.
		const measure = (messages: Parameters<typeof conversationTokens>[0]) => projectedConversationTokens(messages, s.ctx);
		const empty: PiTuck = { ...piTuck, compileResidual: undefined, compileRanked: () => '' };
		const draft = piTuckObservedDraft(empty, { branchEntries: s.manager.getBranch(), tokensBefore: measure(s.manager.buildSessionProjection().messages) }, s.ctx, 272000 - 120000, measure, {}, true);
		expect(draft.compaction).toBeUndefined();
		expect(draft.unavailable).toBe('pi-tuck extracted no summary from this history');
	} finally { s.dispose(); }
});

test('real cuts record a mode that matches their view and content', async () => {
	const seen = new Set<string>();
	// Walk a protected latest input up to the room: the planner has to choose ever poorer views of the old history to make a cut.
	for (let latest = 100000; latest <= 125500; latest += 500) {
		const h = await harness({ at: 'prompt', complete: 60000, host: HOST });
		try {
			h.manager.appendMessage({ role: 'user', content: 'q'.repeat(4 * latest), timestamp: 0 });
			try { await h.session.compact(); } catch { /* refused near the room */ }
			for (const entry of h.compactions()) {
				const r = receiptOf(entry);
				expect(MODES, `mode ${r.mode}`).toContain(r.mode);
				expect(r.view === 'ranked', `${latest}: ${r.mode} ${r.view}`).toBe(r.mode === 'ranked');
				if (r.mode === 'dialogue') expect(entry.summary).toContain(OMITTED_ACTIONS);
				if (r.mode === 'bounded' || r.mode === 'full') expect(entry.summary).not.toContain(OMITTED_ACTIONS);
				seen.add(r.mode);
			}
		} finally { await h.cleanup(); }
	}
	// The walk really passed through the ladder into the dialogue-only view and the ranked fallback.
	expect([...seen].sort()).toEqual(expect.arrayContaining(['bounded', 'dialogue', 'ranked']));
});

test('a cut at the tool boundary records its mode', async () => {
	const r = await scenario({ at: 'tool', complete: BAND + 100, host: HOST });
	expect(r.cuts, r.probe).toBe(1);
	expect(MODES).toContain(receiptOf(r.entries[0]!).mode);
});

test('a tool-heavy history is cut to a dialogue-only summary, and the record says so', async () => {
	// Hundreds of small tool calls: the action record outgrows its allowance, so the compiler keeps only the dialogue (the steady state of a
	// long tool-heavy session). Before the mode was recorded, this was invisible: every complete view was labelled "complete-dialogue".
	const r = await scenario({ at: 'prompt', complete: ROOM + 500, host: HOST, cycleSize: 150 });
	expect(r.faults, r.probe).toEqual([]);
	expect(r.cuts, r.probe).toBe(1);
	const entry = r.entries[0]!;
	expect(receiptOf(entry).mode, r.probe).toBe('dialogue');
	expect(receiptOf(entry).view, r.probe).toBe('complete-dialogue');
	expect(entry.summary).toContain(OMITTED_ACTIONS);
});
