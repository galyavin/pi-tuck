import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { SemanticRecallController } from '../src/semantic-recall';
import { RUNTIME_ID } from '../src/assets';
import { statusText } from '../src/status';

const fixture = vi.hoisted(() => ({ controller: undefined as SemanticRecallController | undefined,
  setting: undefined as ((enabled: boolean) => Promise<unknown>) | undefined, finish: undefined as (() => void) | undefined,
  fails: false, setupCalls: 0 }));
vi.mock('../src/compaction', async original => ({ ...(await original<typeof import('../src/compaction')>()),
  installCompaction: async (_pi: unknown, options: { semanticRecall: SemanticRecallController; onSemanticSetting: typeof fixture.setting }) => {
    fixture.controller = options.semanticRecall; fixture.setting = options.onSemanticSetting;
    return { setSemanticEnabled: async () => { options.semanticRecall.configure({ pythonPath: '/usr/bin/python3', runtimeRoot: '/private/tmp/claude-501/setup-runtime', indexDirectory: '/private/tmp/claude-501/setup-index' }); options.semanticRecall.enable(); } };
  },
}));
vi.mock('../src/setup', () => ({ ensureSemanticRuntime: async () => {
  fixture.setupCalls++;
  await new Promise<void>(resolve => { fixture.finish = resolve; });
  if (fixture.fails) throw new Error('fixture setup failed');
} }));
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!, arch = Object.getOwnPropertyDescriptor(process, 'arch')!;
afterEach(() => { Object.defineProperty(process, 'platform', platform); Object.defineProperty(process, 'arch', arch); });

for (const hasUI of [false, true]) for (const installed of [false, true]) for (const settingsOff of [false, true])
for (const userOff of [false, true]) for (const fails of [false, true])
test(`setup table: UI=${hasUI} installed=${installed} settingsOff=${settingsOff} userOff=${userOff} fails=${fails}`, async () => {
  Object.defineProperty(process, 'platform', { value: 'darwin' }); Object.defineProperty(process, 'arch', { value: 'arm64' });
  const dir = mkdtempSync('/private/tmp/claude-501/tuck-setup-'), agentDir = join(dir, 'agent'), project = join(dir, 'project');
  mkdirSync(agentDir); mkdirSync(project);
  if (installed) { const runtime = join(agentDir, 'pi-tuck', 'runtime', RUNTIME_ID); mkdirSync(runtime, { recursive: true }); writeFileSync(join(runtime, 'semantic-recall.json'), '{}'); }
  if (settingsOff) writeFileSync(join(agentDir, 'pi-tuck.json'), '{"semanticRecall":false}');
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
  fixture.fails = fails; fixture.finish = undefined; fixture.setupCalls = 0;
  const notices: string[] = [], stderr: string[] = [];
  const write = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { stderr.push(String(chunk).trim()); return true; });
  try {
    vi.resetModules();
    const { default: extension } = await import('../index');
    const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
    const pi = { on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, [...handlers.get(name) ?? [], handler]); } } as unknown as ExtensionAPI;
    await extension(pi);
    const ctx = { hasUI, cwd: project, ui: { notify: (message: string) => { notices.push(message); } } } as unknown as ExtensionContext;
    for (const handler of handlers.get('session_start') ?? []) await handler({}, ctx);
    if (userOff) await fixture.setting!(false);
    (fixture.finish as (() => void) | undefined)?.();
    await new Promise<void>(resolve => setImmediate(resolve));
    const status = fixture.controller!.status();
    const expected = userOff ? 'off-user' : settingsOff ? 'off-settings' : !hasUI && !installed ? 'not-installed' : fails ? 'failed' : 'ready';
    expect(status.setup).toBe(expected);
    expect(fixture.controller!.requestCoverage()).not.toHaveProperty('setup');
    expect(fixture.controller!.requestCoverage()).not.toHaveProperty('setupMessage');
    const line = statusText({ version: 'test', active: true, branch: [], cutAt: undefined, search: true, semantic: status }).split('\n').filter(line => line.startsWith('Search:'));
    expect(line).toHaveLength(1);
    expect(line[0]).toBe(expected === 'ready' ? 'Search: by meaning and keyword.'
      : expected === 'not-installed' ? 'Search: by keyword; semantic recall is not set up yet; start Pi once in an interactive session to set it up. Word recall works meanwhile.'
      : expected === 'failed' ? 'Search: by keyword; semantic recall setup failed: fixture setup failed.'
      : 'Search: by keyword; semantic recall is off in this session (/tuck-semantic on).');
    const messages = hasUI ? notices : stderr;
    expect(hasUI ? stderr : notices).toEqual([]);
    expect(messages.length).toBeLessThanOrEqual(1);
    expect(messages.filter(message => message.includes('setup failed'))).toHaveLength(expected === 'failed' ? 1 : 0);
    expect(fixture.setupCalls).toBe(!settingsOff && (hasUI || installed) ? 1 : 0);
    if (!hasUI && !installed && !settingsOff && !userOff && !fails) {
      for (const handler of handlers.get('session_start') ?? []) await handler({}, ctx);
      expect(stderr).toHaveLength(2); expect(stderr[0]).toBe(stderr[1]); // once for each session, including pi -p
    }
    if (settingsOff && userOff) {
      for (const handler of handlers.get('session_start') ?? []) await handler({}, ctx);
      expect(fixture.controller!.status().setup).toBe('off-settings');
    }
  } finally { write.mockRestore(); if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; rmSync(dir, { recursive: true, force: true }); }
});
