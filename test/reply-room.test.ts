import { expect, test } from 'vitest';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { capStopNotice, installCompaction } from '../src/compaction';
import { bandOf } from '../src/budget';
import { piContextSafetyMargin, stoppedReplyRoom } from '../src/request-capacity';

// 1.7.0: after a length stop the reply room grows to min(maxTokens, 2x the stopped output), by Pi's clamp math; with no stop nothing changes.
const studio = { provider: 'mac-studio', id: 'main', api: 'openai-completions', contextWindow: 272_000, maxTokens: 65_536, reasoning: true };
const reply = (output: number, stopReason = 'stop', model = studio, thinkingOnly = false) => ({ type: 'message', message: {
	role: 'assistant', api: model.api, provider: model.provider, model: model.id, stopReason, timestamp: 1,
	content: thinkingOnly ? [{ type: 'thinking', thinking: 'still thinking' }] : [{ type: 'text', text: 'done' }],
	usage: { input: 1_000, output, cacheRead: 0, cacheWrite: 0, totalTokens: 1_000 + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });

async function fixture(branch: unknown[], model = studio) {
	const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
	const pi = {
		on: (name: string, h: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, [...(handlers.get(name) ?? []), h]); return () => {}; },
		registerCommand: () => {}, registerTool: () => {}, getActiveTools: () => [], getAllTools: () => [], appendEntry: () => {}, getThinkingLevel: () => 'high',
	} as unknown as ExtensionAPI;
	const handle = await installCompaction(pi, {});
	const notices: string[] = [];
	const ctx = {
		hasUI: true, cwd: '/w', model, ui: { notify: (m: string) => notices.push(m), setFooter: () => {}, setStatus: () => {} },
		sessionManager: { getBranch: () => branch, getEntries: () => branch, getSessionName: () => undefined, getSessionId: () => 's', getLeafId: () => null },
		getContextUsage: () => undefined,
	};
	const fire = async (name: string, event: unknown = {}) => { for (const h of handlers.get(name) ?? []) { try { await h(event, ctx); } catch { /* other handlers need a fuller context */ } } };
	await fire('session_start');
	return { cut: () => handle.cutPoint(ctx as never), fire, notices };
}

test('no length stop: the trim point is the 1.6.0 one, whatever the replies were', async () => {
	for (const branch of [[], [reply(20_000), reply(64_000)], [reply(5_000, 'stop', { ...studio, id: 'other' })]]) {
		const f = await fixture(branch);
		expect(f.cut()).toBe(bandOf(272_000 - 16_384));
	}
	expect(stoppedReplyRoom([reply(64_000) as never], studio, 272_000, 4_096)).toBeUndefined();
	// A length stop of another model does not count.
	expect(stoppedReplyRoom([reply(16_000, 'length', { ...studio, id: 'other' }) as never], studio, 272_000, 4_096)).toBeUndefined();
});

test('a 16k stop gives about 32k of reply room by Pi math', async () => {
	const margin = await piContextSafetyMargin();
	const f = await fixture([reply(16_384, 'length')]);
	const room = 272_000 - margin - 32_768;
	expect(f.cut()).toBe(bandOf(room));
	// Pi gives a request min(maxTokens, window - input - margin): at the room that is 32,768.
	expect(Math.min(studio.maxTokens, 272_000 - room - margin)).toBe(32_768);
});

test('the raise is bounded by maxTokens, and by half of what Pi can give a request on a small window', () => {
	expect(stoppedReplyRoom([reply(65_536, 'length') as never], studio, 272_000, 4_096)).toBe(65_536);
	expect(stoppedReplyRoom([reply(40_000, 'length') as never], studio, 272_000, 4_096)).toBe(65_536);
	expect(stoppedReplyRoom([reply(4_000, 'length') as never, reply(9_000, 'length') as never], studio, 272_000, 4_096)).toBe(18_000);
	const small = { ...studio, contextWindow: 32_768, maxTokens: 16_384 };
	expect(stoppedReplyRoom([reply(12_000, 'length', small) as never], small, 32_768, 4_096)).toBe(14_336);
});

test('a raise below the reserve leaves the trim point as it was', async () => {
	// A 4k stop asks for 8k of reply room; the 16,384 reserve already gives more.
	const f = await fixture([reply(4_000, 'length')]);
	expect(f.cut()).toBe(bandOf(272_000 - 16_384));
});

test('a thinking-only stop exactly at the configured cap says so, with the setting and the file', async () => {
	const stopped = reply(65_536, 'length', studio, true);
	const f = await fixture([stopped]);
	await f.fire('agent_start');
	await f.fire('message_end', { message: stopped.message });
	await f.fire('agent_settled');
	expect(f.notices).toHaveLength(1);
	expect(f.notices[0]).toMatch(/^pi-tuck: mac-studio\/main used its whole reply cap \(maxTokens 65,536\) while still thinking, before any answer or tool call\. The cap is maxTokens for this model in \S*models\.json\. A lower thinking level, or a task that writes to files as it goes, usually helps more than a bigger cap\. The unfinished response is saved in the session\.$/);
	expect(capStopNotice('p/m', 65_536, '~/.pi/agent/models.json')).toContain('in ~/.pi/agent/models.json.');
	// Below the cap: the old notice.
	const short = reply(30_000, 'length', studio, true), g = await fixture([short]);
	await g.fire('agent_start');
	await g.fire('message_end', { message: short.message });
	await g.fire('agent_settled');
	expect(g.notices[0]).toContain('exhausted its output allowance');
});
