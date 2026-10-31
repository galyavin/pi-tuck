import { createHash } from 'node:crypto';
import { SessionManager, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { measurableConversationTokens } from '../src/budget';
import { tuck, tuckObservedDraft, type DraftMode } from '../src/tuck';

// Seeded coding sessions that grow past the window, each cut drafted the way the tool-loop trigger drafts it and appended to the
// session. Message times are fixed so a summary depends on the code alone. The three shapes are the ones measured for the shrunk
// view's cost: one that is prose-heavy, one whose assistant says little, and one that never reaches the shrunk view.
export type Shape = 'prose' | 'low-prose' | 'residual';

const WORDS = 'parser cache index token budget summary recall branch module schema router worker queue retry timeout config build test lint deploy migrate session window ledger anchor cursor shard vector'.split(' ');
const RESIDUAL_WORDS = WORDS.slice(0, 19);

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const reply = (content: unknown[], stopReason: string, timestamp: number) =>
	({ role: 'assistant', content, api: 'openai-completions', provider: 'probe', model: 'probe', usage, stopReason, timestamp }) as never;

export interface Cut { turn: number; entries: number; before: number; mode?: DraftMode; summaryChars?: number; sha256?: string; ms: number; unavailable?: string }

/** `cutAt` drafts one cut at that turn only, however large the session has grown. */
export interface Run { window: number; reserve: number; turns: number; stopAfterCuts?: number; stopAfterShrunk?: number; cutAt?: number }

/** Grows a session in `shape`, cutting whenever it passes the room. Returns one row per cut; the last may be unavailable. */
export function run(shape: Shape, { window, reserve, turns, stopAfterCuts = 0, stopAfterShrunk = 0, cutAt }: Run): Cut[] {
	let seed = shape === 'residual' ? 11 : 7;
	const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
	const vocabulary = shape === 'residual' ? RESIDUAL_WORDS : WORDS;
	const words = (n: number) => Array.from({ length: n }, () => vocabulary[Math.floor(rnd() * vocabulary.length)]).join(' ');
	let clock = 1_700_000_000_000;
	const stamp = () => (clock += 1000);
	const manager = SessionManager.inMemory('/tmp/synthetic-project');
	const ctx = { sessionManager: manager, cwd: '/tmp/synthetic-project', model: { contextWindow: window, maxTokens: 8192, provider: 'probe', id: 'probe', api: 'openai-completions' } } as unknown as ExtensionContext;
	const measure = (messages: Parameters<typeof measurableConversationTokens>[0]) => measurableConversationTokens(messages, ctx);
	const user = (text: string) => manager.appendMessage({ role: 'user', content: text, timestamp: stamp() });
	const result = (id: string, name: string, text: string, isError = false) =>
		manager.appendMessage({ role: 'toolResult', toolCallId: id, toolName: name, content: [{ type: 'text', text }], isError, timestamp: stamp() });
	const call = (id: string, name: string, args: object) => ({ type: 'toolCall', id, name, arguments: args });
	const rows: Cut[] = [];
	let calls = 0, shrunk = 0;
	for (let turn = 1; turn <= turns; turn++) {
		const file = `src/${vocabulary[turn % vocabulary.length]}/${vocabulary[(turn * 7) % vocabulary.length]}-${turn % 97}.ts`;
		if (shape === 'residual') {
			if (turn % 1000 === 1) user(`Task ${turn}: ${words(40)}`);
			const a = `c${++calls}`, b = `c${++calls}`;
			manager.appendMessage(reply([call(a, 'read', { path: file }), call(b, 'bash', { command: `npm test -- ${vocabulary[turn % 11]}` })], 'toolUse', stamp()));
			result(a, 'read', words(500));
			result(b, 'bash', words(250));
		} else {
			if (shape === 'prose') user(`Turn ${turn}: please ${words(40)}`);
			else if (turn % 60 === 1) user(`Task ${turn}: please ${words(40)}`);
			const a = `c${++calls}`, b = `c${++calls}`, e = `c${++calls}`;
			const lead = shape === 'prose' ? `I will look at ${file}. ${words(80)}` : `Checking ${file}. ${words(12)}`;
			manager.appendMessage(reply([{ type: 'text', text: lead }, call(a, 'read', { path: file }),
				call(b, 'bash', { command: `npm test -- ${vocabulary[turn % 11]} && rg ${vocabulary[turn % 13]} src` })], 'toolUse', stamp()));
			result(a, 'read', words(500));
			result(b, 'bash', words(250), turn % 9 === 0);
			manager.appendMessage(reply([call(e, 'edit', { path: file, oldText: words(12), newText: words(14) })], 'toolUse', stamp()));
			result(e, 'edit', 'Edited.');
			const close = shape === 'prose' ? `Done with turn ${turn}. ${words(120)}` : `Round ${turn} done. ${words(15)}`;
			manager.appendMessage(reply([{ type: 'text', text: close }], shape === 'prose' || turn % 60 === 0 ? 'stop' : 'toolUse', stamp()));
		}
		if (cutAt !== undefined && turn !== cutAt) continue;
		const before = measure(manager.buildSessionProjection().messages);
		if (cutAt === undefined && before + 3000 < window - reserve) continue;
		const started = performance.now();
		const draft = tuckObservedDraft(tuck, { branchEntries: manager.getBranch(), tokensBefore: before }, ctx, reserve, measure, {}, false);
		const ms = performance.now() - started;
		const entries = manager.getEntries().length;
		if (!draft.compaction) { rows.push({ turn, entries, before, ms, unavailable: draft.unavailable }); break; }
		manager.appendCompaction(draft.compaction.summary, draft.compaction.firstKeptEntryId, before, draft.compaction.details, true);
		const kept = manager.getBranch().findIndex(entry => entry.id === draft.compaction!.firstKeptEntryId);
		rows.push({ turn, entries, before, mode: draft.mode, summaryChars: draft.compaction.summary.length, ms,
			sha256: createHash('sha256').update(`${kept}\n${draft.compaction.summary}`).digest('hex') });
		if (draft.mode === 'shrunk') shrunk++;
		if (stopAfterCuts && rows.length >= stopAfterCuts) break;
		if (stopAfterShrunk && shrunk >= stopAfterShrunk) break;
	}
	return rows;
}
