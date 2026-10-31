import { test, expect, vi } from 'vitest';
import { SettingsManager, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { installCompaction } from '../src/compaction';

// A missing model is configuration, not capacity: the engine-wide capacity error (which asks the operator to adjust the input, the
// model or the reserve) must not label it. The handlers are driven directly because Pi itself refuses to prompt without a model.
async function harness() {
	const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
		registerCommand: () => {}, registerTool: () => {}, getSettings: () => ({}), getAllTools: () => [], getActiveTools: () => [],
	} as unknown as ExtensionAPI;
	const errors: unknown[] = [];
	const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 0 } });
	const handle = await installCompaction(pi, { cutAt: 1, settings, requestReserve: () => ({ response: 100 }), fail: error => errors.push(error) });
	const notices: string[] = [];
	const context = (model: unknown) => ({
		model, cwd: '/x', signal: undefined, isIdle: () => true, abort: vi.fn(), getSystemPrompt: () => 'system', ui: { notify: (message: string) => notices.push(message) },
		sessionManager: { getBranch: () => [], getEntries: () => [], buildSessionProjection: () => ({ messages: [], entries: [] }) },
	}) as unknown as ExtensionContext;
	const call = async (name: string, event: unknown, ctx: ExtensionContext) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); };
	return { errors, notices, context, call, close: () => handle.close() };
}
const smallModel = { provider: 'p', api: 'a', id: 'm', contextWindow: 1000, maxTokens: 100 };
const isPlain = (error: unknown) => error instanceof Error && Object.getPrototypeOf(error) === Error.prototype;
// A failure latches the attempt, so every case gets its own installation.
async function run<T>(body: (h: Awaited<ReturnType<typeof harness>>) => Promise<T>) { const h = await harness(); try { return await body(h); } finally { await h.close(); } }

test('the guard: a missing model is a plain Error, with no capacity advice', async () => {
	await run(async h => {
		await h.call('context_with_system', { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] }, h.context(undefined));
		expect(h.errors).toHaveLength(1);
		expect(isPlain(h.errors[0])).toBe(true);
		expect((h.errors[0] as Error).message).toBe('No context model for the request budget');
		expect(h.notices).toEqual([]); // the capacity advice ("lower Pi's compaction.reserveTokens") is for capacity only
	});
});

test('the guard: with a model, a request over the room is still the capacity error, with its advice', async () => {
	await run(async h => {
		await h.call('context_with_system', { messages: [{ role: 'user', content: 'x'.repeat(4000), timestamp: 0 }] }, h.context(smallModel));
		expect(h.errors).toHaveLength(1);
		expect(isPlain(h.errors[0])).toBe(false);
		expect((h.errors[0] as Error).constructor.name).toBe('CapacityError');
		expect((h.errors[0] as Error).message).toContain('Complete Pi context and response reserve exceed the estimated request budget');
		expect(h.notices.join(' ')).toContain("lower Pi's compaction.reserveTokens");
	});
});

const event = (prompt: string) => ({ prompt, images: undefined, systemPrompt: 'system', systemPromptOptions: { selectedTools: [] } });

test('the incoming precheck: a missing model is a plain Error before any capacity test', async () => {
	await run(async h => {
		// Even a prompt that would be over any room is reported as the missing model, because that is checked first.
		await h.call('before_agent_start', event('x'.repeat(100000)), h.context(undefined));
		expect(h.errors).toHaveLength(1);
		expect(isPlain(h.errors[0])).toBe(true);
		expect((h.errors[0] as Error).message).toBe('No context model for the request budget');
		expect(h.notices).toEqual([]);
	});
});

test('the incoming precheck: with a model, a prompt over the room is still the capacity error', async () => {
	await run(async h => {
		await h.call('before_agent_start', event('x'.repeat(100000)), h.context(smallModel));
		expect(h.errors).toHaveLength(1);
		expect((h.errors[0] as Error).constructor.name).toBe('CapacityError');
		expect((h.errors[0] as Error).message).toBe('Incoming Pi prompt and response reserve cannot fit the estimated request budget');
	});
});
