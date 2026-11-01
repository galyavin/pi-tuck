import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

// Semantic recall runs on Metal, so only on Apple silicon. Elsewhere (Linux, Intel Macs) pi-tuck compacts and offers word recall: the model is
// not offered tuck_search, tuck_recall does not point to it, and the semantic runtime is never downloaded.
const state = vi.hoisted(() => ({ options: [] as { search?: boolean }[], setups: 0 }));
vi.mock('../src/compaction', async original => ({
	...(await original<typeof import('../src/compaction')>()),
	installCompaction: vi.fn(async (_pi: unknown, options: { search?: boolean }) => { state.options.push(options); return { setSemanticEnabled: async () => {} }; }),
}));
vi.mock('../src/setup', () => ({ ensureSemanticRuntime: vi.fn(async () => { state.setups++; }) }));

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!, arch = Object.getOwnPropertyDescriptor(process, 'arch')!;
afterEach(() => { Object.defineProperty(process, 'platform', platform); Object.defineProperty(process, 'arch', arch); });

for (const [os, cpu] of [['linux', 'x64'], ['linux', 'arm64'], ['darwin', 'x64']] as const)
	test(`on ${os} ${cpu}, the extension asks for no tuck_search and downloads nothing, even with a UI`, async () => {
		Object.defineProperty(process, 'platform', { value: os }); Object.defineProperty(process, 'arch', { value: cpu });
		const agentDir = mkdtempSync(join(tmpdir(), 'pi-tuck-off-platform-')), project = join(agentDir, '..', 'pi-tuck-off-platform-project');
		mkdirSync(project, { recursive: true });
		const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
			const pi = { on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); } } as unknown as ExtensionAPI;
			state.options.length = 0; state.setups = 0;
			vi.resetModules();
			const { default: extension } = await import('../index');
			await extension(pi);
			expect(state.options.at(-1)?.search).toBe(false);
			const notices: string[] = [];
			const ctx = { hasUI: true, cwd: project, ui: { notify: (message: string) => { notices.push(message); } } } as unknown as ExtensionContext;
			for (const handler of handlers.get('session_start') ?? []) await handler({}, ctx);
			expect(state.setups).toBe(0);
			expect(notices.join(' ')).toContain('semantic recall needs macOS on Apple silicon');
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
			rmSync(agentDir, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true });
		}
	});

test('with search off, only tuck_recall is registered and its description does not point to tuck_search; with it on, both, as before', async () => {
	const { installCompaction } = await vi.importActual<typeof import('../src/compaction')>('../src/compaction');
	for (const search of [false, true]) {
		const tools: { name: string; description: string }[] = [];
		const pi = { registerCommand: () => {}, registerTool: (tool: { name: string; description: string }) => { tools.push(tool); }, on: () => () => {} } as unknown as ExtensionAPI;
		await installCompaction(pi, { search });
		expect(tools.map(tool => tool.name).sort()).toEqual(search ? ['tuck_recall', 'tuck_search'] : ['tuck_recall']);
		expect(tools.find(tool => tool.name === 'tuck_recall')!.description.includes('tuck_search')).toBe(search);
	}
});
