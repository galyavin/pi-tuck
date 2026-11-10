import { expect, test } from 'vitest';
import { SessionManager, type ExtensionContext, type SessionEntry } from '@earendil-works/pi-coding-agent';
import { measurableConversationTokens } from '../src/budget';
import { tuck, tuckObservedDraft } from '../src/tuck';
import { harness } from './budget-fixture';

// When does a refused tool round's result stop counting as fresh (kept whole because it has not reached the model)? Once its run has ended
// with a discarded reply and the session moves on: by a new prompt, an operator's /compact, or a run a custom message starts. A retry and
// the tool loop of a run do not move on, so there it stays fresh. One row per way a cut starts. This rule was patched twice (efb63e0: a
// later prompt; 31c9251: the prompt the cut is planned for, which Pi appends only after it).

// The refused round, as in small-room.test.ts: a fresh tool round larger than the room beside a prompt too large to leave room for it.
const WINDOW = 32768, RESPONSE = 16384;
const refused = { limits: { contextWindow: WINDOW, maxTokens: RESPONSE }, reserveTokens: RESPONSE, cutAtDefault: true, liveTools: true,
	compaction: { requestReserve: () => ({ response: RESPONSE, responseExact: true as const }) },
	// The recovery cut now activates history tools too, and every cut decision counts their schemas: leave room for them beside the protected input.
	system: 1500, host: 100, at: 'tool' as const, history: 1000, complete: 30700, fresh: 15000,
	replyTokens: (request: number) => request === 1 ? 1000 : 0 };
const isDiscarded = (entry: SessionEntry) => entry.type === 'message' && entry.message.role === 'assistant' && ['error', 'aborted'].includes((entry.message as { stopReason?: string }).stopReason ?? '');
const isPrompt = (entry: SessionEntry) => entry.type === 'message' && entry.message.role === 'user';

const throughPi: Record<string, (h: Awaited<ReturnType<typeof harness>>) => Promise<unknown>> = {
	'a new prompt': h => h.session.prompt('Next task'),
	'an operator /compact': h => h.session.compact(),
	'a run a custom message starts': h => h.session.sendCustomMessage({ customType: 'report', content: 'A report that starts a turn', display: false }, { triggerTurn: true }),
};
for (const [start, go] of Object.entries(throughPi))
	test(`after a refused fresh round, ${start} cuts it away and goes on`, async () => {
		const tails: string[][] = [];
		// Where the cut is planned: an operator's /compact goes through Pi; a prompt's cut is pi-tuck's own, planned on `input`.
		const tail = (entries: SessionEntry[]) => { tails.push(entries.slice(-3).map(e => isDiscarded(e) ? 'discarded' : isPrompt(e) ? 'prompt' : e.type === 'message' ? e.message.role : e.type)); };
		const h = await harness({ ...refused, onBeforeCompact: event => tail(event.branchEntries), onPrompt: ctx => tail(ctx.sessionManager.getBranch()) });
		try {
			const first = await h.run();
			expect(first.faults.join(' '), first.probe).toContain('Prompt check failed: the whole starting prompt cannot fit');
			const ended = h.manager.getBranch();
			expect(isDiscarded(ended.at(-1)!), first.probe).toBe(true);
			const marks = { faults: h.faults.length, cuts: h.compactions().length, requests: h.state.requests, tails: tails.length };
			await go(h);
			expect(h.faults.slice(marks.faults), JSON.stringify(tails)).toEqual([]);
			expect(h.compactions().length - marks.cuts, first.probe).toBe(1);
			// The exact order: the cut is planned while the session ends with the discarded reply; no prompt has been appended after it yet.
			if (start === 'a new prompt') expect(tails[marks.tails]!.at(-1), JSON.stringify(tails)).toBe('discarded');
			if (start !== 'an operator /compact') expect(h.state.requests - marks.requests, first.probe).toBeGreaterThan(0);
		} finally { await h.cleanup(); }
	}, 120000);

// A tool-loop cut and a retry are planned inside the run, with no new prompt: compaction.ts calls the draft without `newPrompt` there. The
// discarded reply alone does not move on; a prompt after it does (efb63e0).
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const reply = (content: unknown[], stopReason: string, at: number) => ({ role: 'assistant', content, api: 'openai-completions', provider: 'p', model: 'p', usage, stopReason, timestamp: at }) as never;
const words = (n: number, seed: number) => Array.from({ length: n }, (_, i) => `w${(i * 7 + seed) % 101}`).join(' ');
function draft(afterDiscarded: 'nothing' | 'a prompt' | 'hidden', newPrompt: boolean) {
	let clock = 1_700_000_000_000;
	const manager = SessionManager.inMemory('/testbed');
	manager.appendMessage({ role: 'user', content: `Task 1: ${words(60, 1)}`, timestamp: clock += 1000 });
	for (let round = 0; round < 12; round++) {
		manager.appendMessage(reply([{ type: 'toolCall', id: `r${round}`, name: 'read', arguments: { path: `f${round}` } }], 'toolUse', clock += 1000));
		manager.appendMessage({ role: 'toolResult', toolCallId: `r${round}`, toolName: 'read', content: [{ type: 'text', text: words(300, round) }], isError: false, timestamp: clock += 1000 });
	}
	manager.appendMessage(reply([{ type: 'toolCall', id: 'big', name: 'bash', arguments: { command: 'x' } }], 'toolUse', clock += 1000));
	manager.appendMessage({ role: 'toolResult', toolCallId: 'big', toolName: 'bash', content: [{ type: 'text', text: words(13000, 3) }], isError: false, timestamp: clock += 1000 });
	const discarded = manager.appendMessage(reply([], 'error', clock += 1000));
	// Pi hides a failed attempt it recovers from (an overflow, or a retry cancelled while it waits) with a context edit that replaces it with nothing.
	if (afterDiscarded === 'hidden') manager.appendContextEdit(discarded, null);
	if (afterDiscarded === 'a prompt') manager.appendMessage({ role: 'user', content: 'Task 2', timestamp: clock += 1000 });
	const ctx = { sessionManager: manager, cwd: '/testbed', model: { contextWindow: WINDOW, maxTokens: RESPONSE, provider: 'p', id: 'p', api: 'openai-completions' } } as unknown as ExtensionContext;
	const measure = (messages: never[]) => measurableConversationTokens(messages, ctx);
	return tuckObservedDraft(tuck, { branchEntries: manager.getBranch(), tokensBefore: measure(manager.buildSessionProjection().messages as never), newPrompt }, ctx, 20000, measure as never, {}, true);
}
const inRun: [string, 'nothing' | 'a prompt' | 'hidden', boolean, 'fresh' | 'history'][] = [
	['a retry (Pi retries the request; no new prompt)', 'nothing', false, 'fresh'],
	['a tool-loop cut with no prompt since the discarded reply', 'nothing', false, 'fresh'],
	['a tool-loop cut with a prompt since the discarded reply', 'a prompt', false, 'history'],
	['the cut for an incoming prompt (newPrompt, as compaction.ts passes it)', 'nothing', true, 'history'],
	['the cut for the next run after Pi hid the failed reply (overflow recovery, a cancelled retry)', 'hidden', true, 'history'],
	['a retry after Pi hid the failed reply', 'hidden', false, 'fresh'],
];
test.each(inRun)('%s', (_start, after, newPrompt, expected) => {
	const result = draft(after, newPrompt);
	if (expected === 'fresh') expect(result.unavailable).toBe("pi-tuck's mandatory context cannot fit or reduce the request budget");
	else expect(result.unavailable).toBeUndefined();
});
