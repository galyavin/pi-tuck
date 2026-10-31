import { test, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { BAND, HOST, ROOM, harness, receiptOf, scenario } from './budget-fixture';
import { conversationTokens, measurableConversationTokens, projectedConversationTokens } from '../src/budget';
import { tuck, tuckObservedDraft, type DraftMode, type Tuck } from '../src/tuck';
import { CLOSING_INSTRUCTION } from '../src/tuck/core/format';

// Each cut records which summary view produced it: the whole pre-cut dialogue, or the same dialogue shrunk when it exceeds the
// allowance. Both views carry the file ledger and end with the closing instruction.
const MODES: DraftMode[] = ['dialogue', 'shrunk'];
// A section record of the file ledger: its heading is the line that begins "Files:" (TUCK-TRANSCRIPT/2).
const LEDGER = '\nFiles: Files touched by read, write and edit';
const OMITTED_ACTIONS = 'Historical tool actions and observations omitted';
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

// Force one view: for the shrunk view, the dialogue offer is too large to be admitted.
const forcing = (target: DraftMode): Tuck => ({ ...tuck, compileDialogue: input =>
	target === 'dialogue' ? tuck.compileDialogue(input) : 'z'.repeat(input.ranking.maxBriefChars + 1) });

for (const target of MODES)
test(`the mode recorded is the view that produced the summary: ${target}`, () => {
	const s = session();
	try {
		const measure = (messages: Parameters<typeof conversationTokens>[0]) => measurableConversationTokens(messages, s.ctx);
		const draft = tuckObservedDraft(forcing(target), { branchEntries: s.manager.getBranch(), tokensBefore: measure(s.manager.buildSessionProjection().messages) }, s.ctx, 272000 - 120000, measure, {}, true);
		if (!draft.compaction) throw new Error(draft.unavailable);
		const details = draft.compaction.details as { mode: string; view: string; tokensAfter: number };
		expect(details.mode).toBe(target);
		expect(details.view).toBe(target === 'shrunk' ? 'shrunk-dialogue' : 'complete-dialogue');
		const summary = draft.compaction.summary;
		// Both views are the dialogue: tool output is not in either. Both carry the file ledger (the read calls f0..f11) and the closing.
		expect(summary).toContain(OMITTED_ACTIONS);
		expect(summary).not.toContain(BODY);
		expect(summary).not.toContain('tool_receipt');
		expect(summary).toContain(LEDGER);
		expect(summary).toContain('- read f0');
		expect(summary.endsWith(CLOSING_INSTRUCTION)).toBe(true);
	} finally { s.dispose(); }
});

test('the planner counts the draft with the supplied measure: the same function the triggers use, wrapper and all', () => {
	const s = session();
	try {
		const calls: number[] = [];
		// A measure that is not Pi's raw estimate: the converted conversation plus a constant. The draft must report exactly it.
		const measure = (messages: Parameters<typeof conversationTokens>[0]) => { const n = measurableConversationTokens(messages, s.ctx) + 1000; calls.push(n); return n; };
		const before = measure(s.manager.buildSessionProjection().messages);
		const draft = tuckObservedDraft(tuck, { branchEntries: s.manager.getBranch(), tokensBefore: before }, s.ctx, 272000 - 120000, measure, {}, true);
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

test('an empty compiler offer still yields the mandatory floor (initiating prompt and file ledger), counted by the strict measure', () => {
	const s = session();
	try {
		// The strict measure would throw on an empty summary ("unsupported compaction summary"); the floor is never empty.
		const measure = (messages: Parameters<typeof conversationTokens>[0]) => projectedConversationTokens(messages, s.ctx);
		const empty: Tuck = { ...tuck, compileDialogue: () => '', compileShrunkDialogue: () => '' };
		const draft = tuckObservedDraft(empty, { branchEntries: s.manager.getBranch(), tokensBefore: measure(s.manager.buildSessionProjection().messages) }, s.ctx, 272000 - 120000, measure, {}, true);
		if (!draft.compaction) throw new Error(draft.unavailable);
		expect(draft.mode).toBe('shrunk');
		expect(draft.compaction.summary).toMatch(/^#\d+ user @\S+: Earlier request 0$/m);
		expect(draft.compaction.summary).toContain(LEDGER);
		expect(draft.compaction.summary).not.toContain('Earlier request 1\n');
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
				expect(r.view === 'shrunk-dialogue', `${latest}: ${r.mode} ${r.view}`).toBe(r.mode === 'shrunk');
				// Near the room the allowance is smaller than the least dialogue: the shrunk view is then the floor (task contract and ledger).
				if (r.mode === 'dialogue') expect(entry.summary).toContain(OMITTED_ACTIONS);
				expect(entry.summary).toContain(LEDGER);
				seen.add(r.mode);
			}
		} finally { await h.cleanup(); }
	}
	// The walk really passed through both views.
	expect([...seen].sort()).toEqual(['dialogue', 'shrunk']);
});

test('a cut at the tool boundary records its mode', async () => {
	const r = await scenario({ at: 'tool', complete: BAND + 100, host: HOST });
	expect(r.cuts, r.probe).toBe(1);
	expect(MODES).toContain(receiptOf(r.entries[0]!).mode);
});

test('a history whose dialogue exceeds the allowance is cut to the shrunk view, which still carries the file ledger', async () => {
	// Many hundreds of turns (cycles of 60 tokens): the whole dialogue outgrows the one allowance (there is no 3x multiplier), so the same dialogue is shrunk to it.
	// The shrunk view is never a view without tool history: the ledger and closing instruction are in it.
	const r = await scenario({ at: 'prompt', complete: ROOM + 500, host: HOST, cycleSize: 60 });
	expect(r.faults, r.probe).toEqual([]);
	expect(r.cuts, r.probe).toBe(1);
	const entry = r.entries[0]!;
	expect(receiptOf(entry).mode, r.probe).toBe('shrunk');
	expect(receiptOf(entry).view, r.probe).toBe('shrunk-dialogue');
	expect(entry.summary).toContain(LEDGER);
	expect(entry.summary.endsWith(CLOSING_INSTRUCTION)).toBe(true);
}, 60000); // hundreds of turns, drafted at the room
