import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

// A first-time setup announced in one session can finish after a new session started (/new). The shared setup is reused there, so its
// download callback never runs again; the new session still owes the "set up" notice, once.
let finish: () => void = () => {};
const spies = vi.hoisted(() => ({ enabled: vi.fn(async () => {}) }));
vi.mock('../src/compaction', async original => ({
	...(await original<typeof import('../src/compaction')>()),
	installCompaction: vi.fn(async () => ({ setSemanticEnabled: spies.enabled })),
}));
vi.mock('../src/setup', () => ({ ensureSemanticRuntime: vi.fn((_root: string, progress: (message: string) => void) => {
	progress('pi-tuck: downloading semantic recall (once).');
	return new Promise<string>(resolve => { finish = () => resolve('/config.json'); });
}) }));

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!, arch = Object.getOwnPropertyDescriptor(process, 'arch')!;
afterEach(() => { Object.defineProperty(process, 'platform', platform); Object.defineProperty(process, 'arch', arch); });

test('a setup that finishes in a later session still says it is set up, once', async () => {
	Object.defineProperty(process, 'platform', { value: 'darwin' }); Object.defineProperty(process, 'arch', { value: 'arm64' });
	const agentDir = mkdtempSync(join(tmpdir(), 'pi-tuck-span-')), project = join(agentDir, '..', `${agentDir.split('/').at(-1)}-project`);
	mkdirSync(project, { recursive: true });
	const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
		const pi = { on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); } } as unknown as ExtensionAPI;
		vi.resetModules();
		const { default: extension } = await import('../index');
		await extension(pi);
		const notices: string[] = [];
		const ctx = { hasUI: true, cwd: project, ui: { notify: (message: string) => notices.push(message) } } as unknown as ExtensionContext;
		const fire = async (name: string) => { for (const handler of handlers.get(name) ?? []) await handler({}, ctx); };
		await fire('session_start');                       // session A announces the download
		await fire('session_shutdown'); await fire('session_start'); // /new before setup finishes: session B reuses the setup
		finish(); await new Promise(resolve => setTimeout(resolve, 10));
		expect(notices.filter(n => n.includes('semantic recall is set up'))).toHaveLength(1);
	} finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; }
});
