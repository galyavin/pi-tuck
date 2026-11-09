import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

// A first-time setup announces its download; when semantic recall then starts on it, the operator hears that it is ready, once. A setup that
// was already done downloads nothing and says nothing.
const state = vi.hoisted(() => ({ announce: true }));
vi.mock('../src/compaction', async original => ({
	...(await original<typeof import('../src/compaction')>()),
	installCompaction: vi.fn(async () => ({ setSemanticEnabled: async () => {} })),
}));
vi.mock('../src/setup', () => ({ ensureSemanticRuntime: vi.fn(async (_root: string, notice: (message: string) => void) => { if (state.announce) notice('pi-tuck: setting up semantic recall, a one-time download of about 388 MB. Word recall works meanwhile.'); return '/config.json'; }) }));

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!, arch = Object.getOwnPropertyDescriptor(process, 'arch')!;
afterEach(() => { Object.defineProperty(process, 'platform', platform); Object.defineProperty(process, 'arch', arch); });
const READY = 'pi-tuck: semantic recall is set up. Search by meaning works from the first cut on.';

for (const announce of [true, false])
	test(announce ? 'a first-time setup ends with one ready notice' : 'an existing setup says nothing', async () => {
		Object.defineProperty(process, 'platform', { value: 'darwin' }); Object.defineProperty(process, 'arch', { value: 'arm64' });
		state.announce = announce;
		const agentDir = mkdtempSync(join(tmpdir(), 'pi-tuck-ready-')), project = join(agentDir, '..', `${agentDir.split('/').at(-1)}-project`);
		mkdirSync(project, { recursive: true });
		const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
			const pi = { on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); } } as unknown as ExtensionAPI;
			vi.resetModules();
			const { default: extension } = await import('../index');
			await extension(pi);
			const notices: string[] = [];
			const ctx = { hasUI: true, cwd: project, ui: { notify: (message: string) => { notices.push(message); } } } as unknown as ExtensionContext;
			for (const round of [1, 2]) {
				for (const handler of handlers.get('session_start') ?? []) await handler({}, ctx);
				await new Promise(resolve => setTimeout(resolve, 10));
				expect(notices.filter(n => n === READY), `round ${round}`).toHaveLength(announce ? 1 : 0);
			}
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
			rmSync(agentDir, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true });
		}
	});
