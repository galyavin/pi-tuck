import { test, expect } from 'vitest';
import { SessionManager, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { DEFAULT_CUT_AT, bandOf, decideCut, measurableConversationTokens, planningReserve, type Plan } from '../src/budget';
import { tuck, tuckObservedDraft } from '../src/tuck';
import { harness } from './budget-fixture';

// A 32k window with a 16k reply reserve leaves an input room of 16,384 estimated tokens.

// The boundary where pi-tuck 1.0.1 refused in the eval's 32k smoke run (smoke32-old/reserve16k, task 2), with the inputs its own cut receipts
// recorded (details.diagnosticReceipt.settings): mandatory input 2,489 (the saved system message: 2,789 characters of prompt and 7,158 of schema
// for Pi's four tools and pi-tuck's two) and no host input, and calibrationFactor 2.425210674157303, which makes the room plan's reserve 28,502
// (the receipt's draftReservedTokens) and leaves 4,266 estimated tokens for the conversation. That factor is the first paired reply, where the
// provider counted 6,907 input tokens for a request estimated at 2,846. That run was served by one OpenRouter upstream (Wafer) that spends about
// twice the context other upstreams do on tool schemas, and really does: it rejects a request past its window by its own count. So the factor
// was true for that upstream, and the refusal it led to was correct there. The 1.0.3 re-run of the same chain (smoke32-r16) was served
// elsewhere, at a factor of 1.19, and refused on no code. This test pins the high-factor regime at that room.
// A user turn of about 1,900 characters has called two tools, and the second result is 11,880 characters that no reply has seen. The first
// request's 1,470-character prompt and the turn are quoted, the fresh round stays native, and the ledger keeps its headings: a floor of 4,207
// against 4,266 in the room. Replayed from the recorded session, 1.0.1's floor was 4,431 (summary wrapper 245, quotes 409 and 519, headings 119,
// round 3,148; with the turn kept native 4,380): the window half of the fit failed, `base < before` held. The shorter TUCK-TRANSCRIPT/2 lines
// took 229 tokens off the same boundary, which is all that separates a cut from a refusal here. The margin is thin (a factor above 2.446 refuses),
// so this pins the floor: a longer record would bring the refusal back. This synthetic session has that boundary's sizes; it is refused by the
// code of 1.0.1, the tail share (d3d53b9) and the shrunk dialogue (16a7d06), and cut from the commit that introduced TUCK-TRANSCRIPT/2 on.
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const WINDOW = 32768, RESPONSE = 16384, ROOM = WINDOW - RESPONSE, SYSTEM = 2489, FACTOR = 2.425210674157303, RECEIPT_RESERVE = 28502;
function recordedBoundary() {
	let clock = 1_700_000_000_000; const stamp = () => (clock += 1000);
	const filler = (chars: number, tag: string) => { let text = '', i = 0; while (text.length < chars) text += `${tag}${i++} lorem ipsum data; `; return text.slice(0, chars); };
	const manager = SessionManager.inMemory('/tmp/p');
	const user = (text: string) => manager.appendMessage({ role: 'user', content: text, timestamp: stamp() });
	const reply = (content: unknown[], stopReason = 'toolUse') => manager.appendMessage({ role: 'assistant', content, api: 'openai-completions', provider: 'p', model: 'p', usage, stopReason, timestamp: stamp() } as never);
	const result = (id: string, name: string, text: string) => manager.appendMessage({ role: 'toolResult', toolCallId: id, toolName: name, content: [{ type: 'text', text }], isError: false, timestamp: stamp() });
	user(filler(1470, 'opening'));
	let calls = 0;
	for (let i = 0; i < 3; i++) {
		const a = `c${++calls}`, b = `c${++calls}`;
		reply([{ type: 'text', text: filler(300, 'plan') }, { type: 'toolCall', id: a, name: 'read', arguments: { path: `src/m${i}.py` } }, { type: 'toolCall', id: b, name: 'bash', arguments: { command: `python -m pytest tests/test_${i}.py -x -q` } }]);
		result(a, 'read', filler(2400, 'file')); result(b, 'bash', filler(1200, 'out'));
		reply([{ type: 'text', text: filler(500, 'done') }], 'stop');
	}
	user(filler(1905, 'task'));
	const a = `c${++calls}`, b = `c${++calls}`;
	reply([{ type: 'text', text: filler(200, 'look') }, { type: 'toolCall', id: a, name: 'bash', arguments: { command: 'git status && cat tests/test_impute.py | head -100' } }, { type: 'toolCall', id: b, name: 'bash', arguments: { command: 'grep -rn fill_value sklearn/impute' } }]);
	result(a, 'bash', filler(416, 'a')); result(b, 'bash', filler(11880, 'big'));
	return manager;
}

test('a 16k room, a live system part and a slow tokenizer: the boundary 1.0.1 refused drafts a cut, as the tool-loop trigger decides it', () => {
	const manager = recordedBoundary();
	const ctx = { sessionManager: manager, cwd: '/tmp/p', model: { contextWindow: WINDOW, maxTokens: RESPONSE, provider: 'p', id: 'p', api: 'openai-completions' } } as unknown as ExtensionContext;
	const measure = (m: never[]) => measurableConversationTokens(m, ctx);
	const before = measure(manager.buildSessionProjection().messages as never[]);
	const band = bandOf(ROOM, DEFAULT_CUT_AT), fits = (tokens: number, limit: number) => Math.ceil(tokens * FACTOR) < limit;
	// The request is over the room: a cut is due, and the conversation may take what the room holds beyond the system part.
	expect(fits(before + SYSTEM, ROOM)).toBe(false);
	// The inputs are the receipt's: the same reserve for the room plan, and the same allowance after it.
	expect(planningReserve(WINDOW, ROOM, FACTOR, SYSTEM)).toBe(RECEIPT_RESERVE);
	const allowance = WINDOW - RECEIPT_RESERVE;
	expect(allowance).toBe(4266);
	const decision = decideCut({ total: before + SYSTEM, mandatory: SYSTEM, before, room: ROOM, band, fits, unreduced: 'unreduced',
		plan: (target): Plan<{ compaction: NonNullable<ReturnType<typeof tuckObservedDraft>['compaction']> }> => {
			const draft = tuckObservedDraft(tuck, { branchEntries: manager.getBranch(), tokensBefore: before }, ctx, planningReserve(WINDOW, target === 'band' ? band : ROOM, FACTOR, SYSTEM), measure as never, {}, true);
			return draft.compaction ? { draft: true, after: draft.after, mode: draft.mode, compaction: draft.compaction } : { draft: false, capacityRejected: Boolean(draft.capacityRejected), reason: draft.unavailable };
		} });
	if (decision.kind !== 'cut') throw new Error(JSON.stringify(decision));
	expect(decision.target).toBe('room');
	// The cut keeps the fresh round native and lands the request under the room, by the same arithmetic.
	const kept = manager.getBranch().findIndex(e => e.id === decision.plan.compaction.firstKeptEntryId);
	expect(manager.getBranch().slice(kept).map(e => e.type === 'message' ? e.message.role : e.type)).toEqual(['assistant', 'toolResult', 'toolResult']);
	expect(decision.plan.after).toBeLessThan(allowance);
	expect(fits(decision.plan.after + SYSTEM, ROOM)).toBe(true);
});

// A refusal ends its attempt and nothing more. The compactor refuses a request that cannot be made to fit (a host view larger than the room, or
// a fresh tool round larger than it, which a cut must keep native), aborts that run, and tells the user to shorten the input or use a larger
// model. Once room is available again, whatever starts the next run decides afresh: a prompt always did (the `input` hook), and a run that no
// prompt starts (a custom message that triggers a turn, as an extension's report does) now does too; before, it met the old refusal and was
// aborted before its first request, three hooks over, with the message of the refusal it was never part of.
const small = { limits: { contextWindow: WINDOW, maxTokens: RESPONSE }, reserveTokens: RESPONSE, cutAtDefault: true, liveTools: true,
	compaction: { requestReserve: () => ({ response: RESPONSE, responseExact: true as const }) } };
const routes = {
	// System part and host input alone exceed the room: no cut can help, and the guard refuses.
	'system part and host input exceed the room': { options: { ...small, system: 2000, host: 17000, at: 'impossible' as const, complete: 8000 }, free: (h: Awaited<ReturnType<typeof harness>>) => h.setHost(100), refused: 'Complete Pi context and response reserve exceed', again: 'refused' as const },
	// The tool round fresh from the last call is larger than the room: a cut keeps it native, and the prompt it answers is too large to leave
	// room even for the result clipped (clip-fresh-result.test.ts has the case the clip resolves), so no cut can help, and the trigger refuses.
	'a fresh tool round larger than the room': { options: { ...small, system: 1500, host: 100, at: 'tool' as const, history: 1000, complete: 31300, fresh: 15000, replyTokens: (request: number) => request === 1 ? 1000 : 0 }, free: (h: Awaited<ReturnType<typeof harness>>) => { (h.session.model as { contextWindow: number }).contextWindow = 272000; }, refused: 'cannot fit or reduce the request budget', again: 'answered' as const },
};
const marks = (h: Awaited<ReturnType<typeof harness>>) => ({ requests: h.state.requests, aborts: h.state.aborts, faults: h.faults.length, notices: h.notices.length });
const since = (h: Awaited<ReturnType<typeof harness>>, m: ReturnType<typeof marks>) => ({ requests: h.state.requests - m.requests, aborts: h.state.aborts - m.aborts, faults: h.faults.slice(m.faults), notices: h.notices.slice(m.notices) });

for (const [name, route] of Object.entries(routes))
	for (const trigger of ['a prompt', 'a custom message that triggers a turn'] as const)
		test(`a refusal (${name}) is not held against the next run once room is available: ${trigger}`, async () => {
			const h = await harness(route.options);
			try {
				const first = await h.run();
				expect(first.faults.join(' '), first.probe).toContain(route.refused);
				expect(first.aborts, first.probe).toBeGreaterThan(0);
				expect(first.notices.join(' '), first.probe).toContain('shorten the input');
				// The next prompt decides afresh. While the host view still fills the room it is refused again. The refused tool round was left
				// behind by its ended run: the next prompt's cut summarizes it, and that prompt is answered.
				const again = marks(h);
				await h.session.prompt('Try again');
				if (route.again === 'refused') {
					expect(since(h, again).requests).toBe(0);
					expect(since(h, again).faults.join(' ')).toContain(route.refused);
					expect(since(h, again).notices.join(' ')).toContain('shorten the input');
				} else {
					expect(since(h, again).faults, first.probe).toEqual([]);
					expect(since(h, again).requests, first.probe).toBeGreaterThan(0);
				}
				// Room is available: the host view shrinks, or the user changes to a model with a larger window.
				route.free(h);
				const freed = marks(h);
				if (trigger === 'a prompt') await h.session.prompt('Continue after freeing room');
				else await h.session.sendCustomMessage({ customType: 'report', content: 'A report that starts a turn', display: false }, { triggerTurn: true });
				const after = since(h, freed);
				expect(after.faults, first.probe).toEqual([]);
				expect(after.aborts, first.probe).toBe(0);
				expect(after.requests, first.probe).toBeGreaterThan(0);
				expect((h.session.messages.at(-1) as { stopReason?: string }).stopReason, first.probe).toBe('stop');
			} finally { await h.cleanup(); }
		}, 120000);
