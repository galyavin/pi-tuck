import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { RUNTIME_ID } from '../src/assets';

// A run with no UI (pi -p, RPC, JSON) used to return before semantic recall started, even with the runtime installed, so jobs and benchmark
// arms ran on word recall while tuck_search said it was "being set up". An installed runtime now starts there too; without one, the run
// says it is not set up and starts no download.
const spies = vi.hoisted(() => ({ enabled: vi.fn(async () => {}), setup: vi.fn(async () => '/config.json'), refused: [] as string[] }));
vi.mock('../src/compaction', async original => ({
	...(await original<typeof import('../src/compaction')>()),
	installCompaction: vi.fn(async () => ({ setSemanticEnabled: spies.enabled })),
}));
vi.mock('../src/setup', () => ({ ensureSemanticRuntime: spies.setup }));
vi.mock('../src/semantic-recall', async original => {
 const real = await original<typeof import('../src/semantic-recall')>();
 return { ...real, createSemanticRecall: () => {
  const controller = new real.SemanticRecallController();
  const set = controller.setSetup.bind(controller);
  controller.setSetup = (state, detail) => { set(state, detail); const message = controller.status().setupMessage; if (message) spies.refused.push(message); };
  return controller;
 } };
});

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!, arch = Object.getOwnPropertyDescriptor(process, 'arch')!;
afterEach(() => { Object.defineProperty(process, 'platform', platform); Object.defineProperty(process, 'arch', arch); });

for (const installed of [true, false])
	test(installed ? 'with no UI, an installed runtime starts semantic recall' : 'with no UI and no runtime, it says so and downloads nothing', async () => {
		Object.defineProperty(process, 'platform', { value: 'darwin' }); Object.defineProperty(process, 'arch', { value: 'arm64' });
		spies.enabled.mockClear(); spies.setup.mockClear(); spies.refused.length = 0;
		const agentDir = mkdtempSync(join(tmpdir(), 'pi-tuck-noui-')), project = join(agentDir, '..', `${agentDir.split('/').at(-1)}-project`);
		mkdirSync(project, { recursive: true });
		if (installed) { const runtime = join(agentDir, 'pi-tuck', 'runtime', RUNTIME_ID); mkdirSync(runtime, { recursive: true }); writeFileSync(join(runtime, 'semantic-recall.json'), '{}'); }
		const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
			const pi = { on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); } } as unknown as ExtensionAPI;
			vi.resetModules();
			const { default: extension } = await import('../index');
			await extension(pi);
			const ctx = { hasUI: false, cwd: project, ui: { notify: () => { throw new Error('no UI'); } } } as unknown as ExtensionContext;
			const written: string[] = [];
			const write = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => { written.push(String(chunk)); return true; });
			try {
				for (const handler of handlers.get('session_start') ?? []) await handler({}, ctx);
				await new Promise(resolve => setTimeout(resolve, 10));
			} finally { write.mockRestore(); }
			// An off or failing semantic recall is said once on stderr, where the operator of a no-UI run sees it; a working one says nothing.
			const ours = written.filter(line => line.startsWith('pi-tuck: semantic recall'));
			expect(ours).toHaveLength(installed ? 0 : 1);
			if (installed) {
				expect(spies.enabled).toHaveBeenCalledTimes(1);
				expect(spies.refused).toEqual(['Semantic recall is starting; word recall works meanwhile']);
			} else {
				expect(spies.enabled).not.toHaveBeenCalled();
				expect(spies.setup).not.toHaveBeenCalled();
				expect(spies.refused.join(' ')).toContain('not set up yet; start Pi once in an interactive session');
			}
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
			rmSync(agentDir, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true });
		}
	});
