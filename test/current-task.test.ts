import { test, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { measurableConversationTokens, planningReserve } from '../src/budget';
import { tuck, tuckObservedDraft } from '../src/tuck';

// A session that runs task after task: each task opens with a long user turn and goes on in short step turns. Once the history is long enough that
// the summary clips user turns down to a few words, the current task was lost while the first task stayed whole.
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const reply = (content: unknown, stopReason = 'stop') => ({ role: 'assistant', content, stopReason, timestamp: 1, api: 'x', provider: 'x', model: 'x', usage });
const words = (mark: string, n: number) => (mark + ' lorem ipsum dolor sit amet ').repeat(Math.ceil(n / (mark.length + 28))).slice(0, n);

function draft(tasks: number, taskChars: number, window: number, room: number) {
	const dir = mkdtempSync(join(tmpdir(), 'pi-task-'));
	const m = SessionManager.inMemory(dir);
	const ctx = { sessionManager: m, cwd: dir, model: { contextWindow: window, maxTokens: 8192 } } as unknown as ExtensionContext;
	let c = 0;
	const call = (chars: number) => { const id = `c${++c}`; m.appendMessage(reply([{ type: 'toolCall', id, name: 'bash', arguments: { command: 'x' } }], 'toolUse') as never);
		m.appendMessage({ role: 'toolResult', toolCallId: id, toolName: 'bash', isError: false, timestamp: 1, content: [{ type: 'text', text: words('out', chars) }] } as never); };
	for (let t = 0; t < tasks; t++) {
		m.appendMessage({ role: 'user', content: `STEP 1: TASK ${t}. ` + words(`TASKBODY${t}`, t === 0 ? 16000 : taskChars), timestamp: 1 } as never);
		for (let s = 2; s <= 6; s++) { call(2000); m.appendMessage(reply([{ type: 'text', text: words(`report${t}-${s}`, 1500) }]) as never); m.appendMessage({ role: 'user', content: `STEP ${s}: go on ${t}`, timestamp: 1 } as never); }
		for (let k = 0; k < 6; k++) call(3000);
	}
	const measure = (x: never) => measurableConversationTokens(x, ctx);
	const before = measure(m.buildSessionProjection().messages as never);
	const result = tuckObservedDraft(tuck, { branchEntries: m.getBranch(), tokensBefore: before }, ctx, planningReserve(window, room, 1, 3000), measure as never, {}, true);
	rmSync(dir, { recursive: true, force: true });
	return result;
}

test('in a long run of tasks, the summary keeps the current task, not only the first', () => {
	const result = draft(120, 3000, 81920, 64000);
	const summary = result.compaction!.summary;
	expect(summary).toContain('TASKBODY119 ');
	expect((summary.match(/TASKBODY119 /g) ?? []).length).toBeGreaterThan(50);
	// The task body follows all protected openings and the recent assistant third.
});

test('a current task longer than the budget keeps its head and a locator to the rest', () => {
	const summary = draft(40, 52000, 81920, 64000).compaction!.summary;
	expect(summary).toContain('TASKBODY39 ');
	expect(summary).toMatch(/tuck_recall \{"index":\d+,"offset":\d+\}/);
});

test('where the extra quote leaves no room, the cut still lands as before', () => {
	const result = draft(6, 3000, 32768, 16384);
	expect(result.compaction).toBeDefined();
});
