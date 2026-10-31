import { expect, test } from 'vitest';
import { SessionManager, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { measurableConversationTokens } from '../src/budget';
import { tuck, tuckObservedDraft, tuckRecall } from '../src/tuck';

// A tool result too large for the room is refused while it is the round's answer: it must reach the model whole, and cannot. When that run
// ends (its reply discarded) and a new prompt follows, the result is history, and a cut summarizes it. Kept native as before, it refused every
// later prompt of the session (eval live32 t02-B: one 50,880-character bash result, then 20 tasks refused at once).
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const reply = (content: unknown[], stopReason: string, at: number) =>
	({ role: 'assistant', content, api: 'openai-completions', provider: 'p', model: 'p', usage, stopReason, timestamp: at, ...(stopReason === 'aborted' ? { errorMessage: 'This operation was aborted' } : {}) }) as never;
const words = (n: number, seed: number) => Array.from({ length: n }, (_, i) => `w${(i * 7 + seed) % 101}`).join(' ');

type After = 'nothing' | 'aborted' | 'aborted, then a prompt' | 'a prompt';
function session(after: After, newPrompt = false) {
	let clock = 1_700_000_000_000;
	const manager = SessionManager.inMemory('/testbed');
	const user = (text: string) => manager.appendMessage({ role: 'user', content: text, timestamp: clock += 1000 });
	user(`Task 1: ${words(60, 1)}`);
	for (let round = 0; round < 12; round++) {
		manager.appendMessage(reply([{ type: 'text', text: words(40, round) }, { type: 'toolCall', id: `r${round}`, name: 'read', arguments: { path: `src/f${round}.py` } }], 'toolUse', clock += 1000));
		manager.appendMessage({ role: 'toolResult', toolCallId: `r${round}`, toolName: 'read', content: [{ type: 'text', text: words(300, round) }], isError: false, timestamp: clock += 1000 });
	}
	manager.appendMessage(reply([{ type: 'toolCall', id: 'big', name: 'bash', arguments: { command: 'grep -rn x .' } }], 'toolUse', clock += 1000));
	const receipt = manager.appendMessage({ role: 'toolResult', toolCallId: 'big', toolName: 'bash', content: [{ type: 'text', text: words(13000, 3) }], isError: false, timestamp: clock += 1000 });
	if (after.startsWith('aborted')) manager.appendMessage(reply([], 'aborted', clock += 1000));
	if (after.endsWith('prompt')) user(`Task 2: ${words(60, 2)}`);
	const ctx = { sessionManager: manager, cwd: '/testbed', model: { contextWindow: 32768, maxTokens: 16384, provider: 'p', id: 'p', api: 'openai-completions' } } as unknown as ExtensionContext;
	const measure = (messages: never[]) => measurableConversationTokens(messages, ctx);
	const before = measure(manager.buildSessionProjection().messages as never);
	return { draft: tuckObservedDraft(tuck, { branchEntries: manager.getBranch(), tokensBefore: before, newPrompt }, ctx, 20000, measure as never, {}, true), manager, receipt, before };
}

// Within its run (a retry, or a tool-loop cut, with no prompt since), the receipt is still the answer the next request carries.
test.each<After>(['nothing', 'aborted'])('a receipt that is still the round\'s answer stays native and the cut is refused (after: %s)', after => {
	const { draft, before } = session(after);
	expect(before).toBeGreaterThan(32768 - 20000);
	expect(draft.compaction).toBeUndefined();
	expect(draft.unavailable).toBe("pi-tuck's mandatory context cannot fit or reduce the request budget");
});

// A prompt since the receipt means its run is over, however that run ended.
test.each<After>(['aborted, then a prompt', 'a prompt'])('a receipt left behind by a prompt since is summarized, and the cut fits (after: %s)', after => {
	const { draft, manager, receipt } = session(after);
	expect(draft.unavailable).toBeUndefined();
	const branch = manager.getBranch().map(entry => entry.id);
	expect(branch.indexOf(draft.compaction!.firstKeptEntryId)).toBeGreaterThan(branch.indexOf(receipt));
	expect((draft.compaction!.details as { tokensAfter: number }).tokensAfter + 20000).toBeLessThan(32768);
});

test('the summarized receipt stays readable through tuck_recall', () => {
	const { draft, manager, receipt } = session('aborted, then a prompt');
	manager.appendCompaction(draft.compaction!.summary, draft.compaction!.firstKeptEntryId, 0, draft.compaction!.details, true);
	const read = tuckRecall(tuck, manager.getEntries(), manager.getBranch(), { entryId: receipt, offset: 40000, limit: 16000 }) as { status: string; entries: { text?: string }[] };
	expect(JSON.stringify(read)).toContain(words(13000, 3).slice(-200, -100));
});

test('a prompt too large for the room is refused once; the next prompt cuts it away', () => {
	let clock = 1_700_000_000_000;
	const manager = SessionManager.inMemory('/testbed');
	const user = (text: string) => manager.appendMessage({ role: 'user', content: text, timestamp: clock += 1000 });
	const ctx = { sessionManager: manager, cwd: '/testbed', model: { contextWindow: 32768, maxTokens: 16384, provider: 'p', id: 'p', api: 'openai-completions' } } as unknown as ExtensionContext;
	const measure = (messages: never[]) => measurableConversationTokens(messages, ctx);
	const draft = () => tuckObservedDraft(tuck, { branchEntries: manager.getBranch(), tokensBefore: measure(manager.buildSessionProjection().messages as never) }, ctx, 20000, measure as never, {}, true);
	user(`Task 1: ${words(60, 1)}`);
	manager.appendMessage(reply([{ type: 'text', text: words(200, 4) }], 'stop', clock += 1000));
	user(`Paste: ${words(13000, 5)}`);
	expect(draft().compaction).toBeUndefined();
	manager.appendMessage(reply([], 'aborted', clock += 1000));
	user(`Task 2: ${words(60, 2)}`);
	const next = draft();
	expect(next.unavailable).toBeUndefined();
	expect((next.compaction!.details as { tokensAfter: number }).tokensAfter + 20000).toBeLessThan(32768);
});

// Pi appends a prompt only after the cut planned for it, so that cut sees the ended run and no prompt after it yet. eval live32 t01-C on
// efb63e0: the prompt right after each refused task was refused too (tasks 3 and 28), and only the one after that recovered.
test('the cut planned for a run that has not begun treats every unanswered receipt as left behind; a retry, inside its run, does not', () => {
	expect(session('aborted', true).draft.unavailable).toBeUndefined();
	expect(session('nothing', true).draft.unavailable).toBeUndefined();
	expect(session('aborted', false).draft.unavailable).toBe("pi-tuck's mandatory context cannot fit or reduce the request budget");
});
