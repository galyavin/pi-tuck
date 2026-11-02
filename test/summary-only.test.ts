import { test, expect } from 'vitest';
import { SessionManager, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { measurableConversationTokens } from '../src/budget';
import { tuck, tuckObservedDraft } from '../src/tuck';

// A cut that kept nothing leaves its summary alone as the conversation. A large prompt then needs a cut, and nothing after the summary is left
// to cut away (eval live32 t03 task 24, 2026-11-01: a 25,160-character prompt after a run-end cut that kept only its summary; the prompt was
// dropped). A summary is compiled from the original sources, so the cut takes the whole history again and renders it smaller.
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const reply = (content: unknown[], stopReason: string, at: number) => ({ role: 'assistant', content, api: 'openai-completions', provider: 'p', model: 'p', usage, stopReason, timestamp: at }) as never;
const words = (n: number, seed: number) => Array.from({ length: n }, (_, i) => `w${(i * 7 + seed) % 997}x${i % 13}`).join(' ');
test('nothing since a cut that kept only its summary: a cut renders the whole history again, smaller, instead of finding nothing to cut', () => {
	let clock = 1_700_000_000_000;
	const manager = SessionManager.inMemory('/summary-only');
	for (let task = 0; task < 6; task++) {
		manager.appendMessage({ role: 'user', content: `Task ${task}: ${words(80, task)}`, timestamp: clock += 1000 });
		for (let round = 0; round < 4; round++) {
			manager.appendMessage(reply([{ type: 'toolCall', id: `r${task}-${round}`, name: 'read', arguments: { path: `f${task}-${round}` } }], 'toolUse', clock += 1000));
			manager.appendMessage({ role: 'toolResult', toolCallId: `r${task}-${round}`, toolName: 'read', content: [{ type: 'text', text: words(400, task * 10 + round) }], isError: false, timestamp: clock += 1000 });
		}
		manager.appendMessage(reply([{ type: 'text', text: `Done with task ${task}: ${words(60, task + 50)}` }], 'stop', clock += 1000));
	}
	const ctx = { sessionManager: manager, cwd: '/summary-only', model: { contextWindow: 32768, maxTokens: 16384, provider: 'p', id: 'p', api: 'openai-completions' } } as unknown as ExtensionContext;
	const measure = (messages: never[]) => measurableConversationTokens(messages, ctx);
	const draft = (reserve: number) => tuckObservedDraft(tuck, { branchEntries: manager.getBranch(), tokensBefore: measure(manager.buildSessionProjection().messages as never),
		previousSummary: manager.buildSessionProjection().messages.find(m => m.role === 'compactionSummary')?.summary, newPrompt: true }, ctx, reserve, measure as never, {}, false);
	// The first cut, at a generous allowance, saved as a cut that keeps nothing.
	const first = draft(20000);
	expect(first.compaction, first.unavailable).toBeDefined();
	manager.appendCompaction(first.compaction!.summary, '', 0, first.compaction!.details, true);
	expect(manager.buildSessionProjection().messages.map(m => m.role)).toEqual(['compactionSummary']);
	// The next cut, at a smaller allowance, with nothing after the summary.
	const second = draft(26000);
	expect(second.unavailable).toBeUndefined();
	expect(second.compaction!.firstKeptEntryId).toBe('');
	const after = (d: object) => (d as { after?: number }).after!;
	expect(after(second), JSON.stringify({ first: after(first), second: after(second) })).toBeLessThan(after(first));
});
