import { test, expect } from 'vitest';
import { SessionManager, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { measurableConversationTokens } from '../src/budget';
import { tuck, tuckObservedDraft } from '../src/tuck';
import { BAND, HOST, scenario } from './budget-fixture';

// A cut that kept nothing leaves its summary alone as the conversation. A large prompt then needs a cut, and nothing after the summary is left
// to cut away (eval live32 t03 task 24, 2026-11-01: a 25,160-character prompt after a run-end cut that kept only its summary; the prompt was
// dropped). A summary is compiled from the original sources, so a due cut takes the whole history again and renders it smaller.
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const reply = (content: unknown[], stopReason: string, at: number) => ({ role: 'assistant', content, api: 'openai-completions', provider: 'p', model: 'p', usage, stopReason, timestamp: at }) as never;
const words = (n: number, seed: number) => Array.from({ length: n }, (_, i) => `w${(i * 7 + seed) % 997}x${i % 13}`).join(' ');
/** Six tasks of tool rounds, then a cut that keeps nothing, so the summary alone is the conversation. */
function summaryOnly(cwd: string) {
	let clock = 1_700_000_000_000;
	const manager = SessionManager.inMemory(cwd);
	for (let task = 0; task < 6; task++) {
		manager.appendMessage({ role: 'user', content: `Task ${task}: ${words(80, task)}`, timestamp: clock += 1000 });
		for (let round = 0; round < 4; round++) {
			manager.appendMessage(reply([{ type: 'toolCall', id: `r${task}-${round}`, name: 'read', arguments: { path: `f${task}-${round}` } }], 'toolUse', clock += 1000));
			manager.appendMessage({ role: 'toolResult', toolCallId: `r${task}-${round}`, toolName: 'read', content: [{ type: 'text', text: words(400, task * 10 + round) }], isError: false, timestamp: clock += 1000 });
		}
		manager.appendMessage(reply([{ type: 'text', text: `Done with task ${task}: ${words(60, task + 50)}` }], 'stop', clock += 1000));
	}
	const ctx = { sessionManager: manager, cwd, model: { contextWindow: 32768, maxTokens: 16384, provider: 'p', id: 'p', api: 'openai-completions' } } as unknown as ExtensionContext;
	const measure = (messages: never[]) => measurableConversationTokens(messages, ctx);
	const draft = (reserve: number, reRenderSummary?: boolean) => tuckObservedDraft(tuck, { branchEntries: manager.getBranch(), tokensBefore: measure(manager.buildSessionProjection().messages as never),
		previousSummary: manager.buildSessionProjection().messages.find(m => m.role === 'compactionSummary')?.summary, newPrompt: true, reRenderSummary }, ctx, reserve, measure as never, {}, false);
	// The first cut, at a generous allowance, saved as a cut that keeps nothing.
	const first = draft(20000);
	expect(first.compaction, first.unavailable).toBeDefined();
	manager.appendCompaction(first.compaction!.summary, '', 0, first.compaction!.details, true);
	expect(manager.buildSessionProjection().messages.map(m => m.role)).toEqual(['compactionSummary']);
	return { ctx, manager, draft, first };
}

test('nothing since a cut that kept only its summary: a due cut renders the whole history again, smaller, instead of finding nothing to cut', () => {
	const { draft, first } = summaryOnly('/summary-only');
	// The next cut, at a smaller allowance, with nothing after the summary, and due: the summary is re-rendered.
	const second = draft(26000, true);
	expect(second.unavailable).toBeUndefined();
	expect(second.compaction!.firstKeptEntryId).toBe('');
	const after = (d: object) => (d as { after?: number }).after!;
	expect(after(second), JSON.stringify({ first: after(first), second: after(second) })).toBeLessThan(after(first));
});

// Re-rendering a summary that sits alone costs history: on a prompt inside the band whose request already fits the room as it stands it shrank a
// 13,008-token first request to 3,336 (replays s04-B task 13 and s08-B task 23). Only a cut that is due asks for it, and the planner is the caller
// that says so; without the flag the same state refuses as it did before the summary re-render existed.
test('nothing since a cut that kept only its summary, and the cut is not due: the draft refuses instead of re-rendering the summary', () => {
	const { draft } = summaryOnly('/summary-only-not-due');
	const notDue = draft(26000);
	expect(notDue.compaction).toBeUndefined();
	expect(notDue.unavailable, JSON.stringify(notDue)).toBe('pi-tuck cannot select a cut: no_live_messages');
	// And with the flag the same state is cuttable, so the refusal is the flag's doing and nothing else.
	expect(draft(26000, true).unavailable).toBeUndefined();
});

// The same state through the planner: a prompt inside the band on a summary-only session asks for an opportunistic cut, which the draft refuses,
// so the request goes out exactly as it stands. Before the narrowing this prompt cut: the summary alone was re-rendered smaller and the session
// lost history for nothing (replays s04-B task 13, s08-B task 23).
test('a prompt inside the band on a summary-only session: no cut, and the prompt is sent as it stands', async () => {
	const r = await scenario({ at: 'prompt', complete: BAND + 100, host: HOST, summary: true, summaryOnly: true });
	expect(r.faults, r.probe).toEqual([]);
	expect(r.cuts, r.probe).toBe(0);
	expect(r.requests, r.probe).toBe(1);
	expect(r.notices.join(' '), r.probe).toBe('');
	// The one request is the prompt beside the summary, as the trigger measured it: nothing was re-rendered to make room, and the saved
	// conversation still carries the whole prompt beside the summary.
	expect(Math.abs(r.guard[0]! - (BAND + 100)), r.probe).toBeLessThanOrEqual(2);
	expect(r.kept, r.probe).toBeGreaterThanOrEqual(r.guard[0]! - r.system - HOST - 2);
});
