import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { win32 } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

const state = vi.hoisted(() => ({ settings: [] as string[], stats: [] as string[], removed: [] as string[], markers: [] as unknown[], options: [] as unknown[] }));
// Exercise the production folder builders with Windows paths on any host.
vi.mock('node:path', async original => {
  const actual = await original<typeof import('node:path')>();
  return { ...actual, join: actual.win32.join, resolve: actual.win32.resolve, dirname: actual.win32.dirname, basename: actual.win32.basename };
});
vi.mock('@earendil-works/pi-coding-agent', () => ({ VERSION: '1.4.0', getAgentDir: () => 'C:\\Users\\Ada\\.pi\\agent' }));
vi.mock('node:os', () => ({ homedir: () => 'C:\\Users\\Ada' }));
vi.mock('../src/compaction', () => ({ installCompaction: async (_pi: unknown, options: unknown) => { state.options.push(options); return {}; } }));
vi.mock('node:fs', () => ({ readFileSync: (path: string) => { state.settings.push(path); return '{"cutAt":0.6}'; } }));
vi.mock('node:fs/promises', () => ({
  lstat: async (path: string) => {
    state.stats.push(path);
    if (path.endsWith('pi-tuck-semantic-removed')) throw Object.assign(new Error('absent'), { code: 'ENOENT' });
    return { isDirectory: () => path.endsWith('\\pi-tuck') || path.endsWith('\\index') };
  },
  readdir: async () => ['index', 'notes.txt'],
  readFile: async () => { throw new Error('unexpected read'); },
  rm: async (path: string) => { state.removed.push(path); },
  rmdir: async () => { throw Object.assign(new Error('foreign file'), { code: 'ENOTEMPTY' }); },
  mkdir: async () => {},
  writeFile: async (...args: unknown[]) => { state.markers.push(args); },
}));

import extension from '../index';
import { cleanupLegacyFiles } from '../src/legacy-cleanup';

beforeEach(() => { for (const values of Object.values(state)) values.length = 0; });
afterEach(() => vi.unstubAllGlobals());
const agent = win32.join('C:\\Users\\Ada', '.pi', 'agent');

test('settings use the joined Windows agent folder and load the configured cut point', async () => {
  await extension({ on: () => {} } as unknown as ExtensionAPI);
  expect(state.settings).toEqual([win32.join(agent, 'pi-tuck.json')]);
  expect(state.options).toEqual([{ cutAt: 0.6 }]);
});

test('Windows checks and writes the joined home marker without inspecting or deleting candidates', async () => {
  vi.stubGlobal('process', new Proxy(process, { get: (target, key) => key === 'platform' ? 'win32' : Reflect.get(target, key) }));
  const notices: string[] = [];
  await cleanupLegacyFiles({ hasUI: true, ui: { notify: (message: string) => notices.push(message) } } as unknown as ExtensionContext);
  const marker = win32.join(agent, 'pi-tuck-semantic-removed');
  expect(state.stats).toEqual([marker]);
  expect(state.removed).toEqual([]);
  expect(state.markers).toEqual([[marker, '', { flag: 'wx' }]]);
  expect(notices).toEqual([]);
});
