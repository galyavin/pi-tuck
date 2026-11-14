import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { win32 } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

const state = vi.hoisted(() => ({ settings: [] as string[], stats: [] as string[], markers: [] as string[], options: [] as unknown[] }));
// Exercise the production folder builders with Windows path semantics on any host.
vi.mock('node:path', async original => {
  const actual = await original<typeof import('node:path')>();
  return { ...actual, join: actual.win32.join, resolve: actual.win32.resolve, dirname: actual.win32.dirname, basename: actual.win32.basename };
});
vi.mock('@earendil-works/pi-coding-agent', () => ({ VERSION: '1.4.0', getAgentDir: () => 'C:\\Users\\Ada\\.pi\\agent' }));
vi.mock('../src/compaction', () => ({ installCompaction: async (_pi: unknown, options: unknown) => { state.options.push(options); return {}; } }));
vi.mock('node:fs', () => ({ readFileSync: (path: string) => { state.settings.push(path); return '{"cutAt":0.6}'; } }));
vi.mock('node:fs/promises', () => ({
  stat: async (path: string) => { state.stats.push(path); return { isDirectory: () => true }; },
  access: async () => { throw Object.assign(new Error('missing marker'), { code: 'ENOENT' }); },
  writeFile: async (path: string) => { state.markers.push(path); },
}));

import extension from '../index';
import { removedRuntimeStatus, showRemovedRuntimeNotice } from '../src/removed-runtime';

beforeEach(() => { for (const values of Object.values(state)) values.length = 0; });
afterEach(() => vi.unstubAllGlobals());
const agent = win32.join('C:\\Users\\Ada', '.pi', 'agent');

test('settings use the joined Windows agent folder and load the configured cut point', async () => {
  await extension({ on: () => {} } as unknown as ExtensionAPI);
  expect(state.settings).toEqual([win32.join(agent, 'pi-tuck.json')]);
  expect(state.options).toEqual([{ cutAt: 0.6 }]);
});

test('the removed-runtime status prints its joined Windows root', async () => {
  const root = win32.join(agent, 'pi-tuck');
  expect(await removedRuntimeStatus()).toBe(`Semantic search was removed from pi-tuck. Its runtime folder ${root} can be deleted by hand.`);
  expect(state.stats).toEqual([root]);
});

test('the removed-runtime marker is a sibling joined with Windows separators', async () => {
  vi.stubGlobal('process', new Proxy(process, { get: (target, key) => key === 'platform' ? 'win32' : Reflect.get(target, key) }));
  const notices: string[] = [];
  await showRemovedRuntimeNotice({ hasUI: true, ui: { notify: (message: string) => notices.push(message) } } as unknown as ExtensionContext);
  expect(state.markers).toEqual([win32.join(agent, 'pi-tuck.notice-shown')]);
  expect(notices).toEqual([`pi-tuck no longer uses semantic search; its runtime folder ${win32.join(agent, 'pi-tuck')} can be deleted.`]);
});
