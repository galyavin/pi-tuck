import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { installCompaction } from '../src/compaction';
import { LOADED_VERSION, statusText } from '../src/status';
import { harness } from './budget-fixture';

// What the operator is told, as opposed to what the model sees: `/tuck` in words, and `/compact` with text after it.
const ours = (tokensBefore: number, tokensAfter: number) => ({ type: 'compaction', tokensBefore, details: { compactor: 'pi-tuck', tokensAfter } });
const base = { version: '9.9.9', active: true, branch: [], cutAt: undefined, search: true, semantic: { state: 'waiting' as const, lastError: null } };

test('the loaded version is the package version', () => {
 expect(LOADED_VERSION).toBe(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
});

test('/tuck before any cut, adaptive, on Apple silicon', () => {
 expect(statusText(base)).toBe([
  'pi-tuck 9.9.9 (the version this session loaded; restart Pi after an update).',
  'Cuts: none yet in this session. The recall tools appear after the first cut.',
  'Cut point: adapts by itself.',
  'Search: by meaning and keyword.',
 ].join('\n'));
});

test('/tuck counts pi-tuck cuts on the branch, gives the last one, and names Pi\'s own cuts apart', () => {
 const text = statusText({ ...base, branch: [{ type: 'compaction', details: null }, ours(40722, 4484), { type: 'message' }, ours(37800, 5100)] });
 expect(text).toContain('Cuts: 2 by pi-tuck in this session, the last from 37,800 to 5,100 tokens.');
 expect(text).toContain("Pi's own compaction cut 1 time in this session.");
});

test('/tuck names a hand-set cut point, and search in words for each state', () => {
 expect(statusText({ ...base, cutAt: 0.9 })).toContain('Cut point: fixed at cutAt 0.9 of the input room. Remove cutAt from pi-tuck.json to let it adapt.');
 expect(statusText({ ...base, search: false })).toContain('Search: by keyword (search by meaning needs macOS on Apple silicon).');
 expect(statusText({ ...base, semantic: { state: 'preparing', lastError: null } })).toContain('Search: by meaning and keyword; indexing history in the background.');
 expect(statusText({ ...base, semantic: { state: 'disabled', lastError: 'Semantic recall is being set up; word recall works meanwhile' } }))
  .toContain('Search: by keyword; semantic recall is being set up; word recall works meanwhile.');
 expect(statusText({ ...base, semantic: { state: 'disabled', lastError: null } })).toContain('Search: by keyword; semantic recall is off in this session (/tuck-semantic on).');
 expect(statusText({ ...base, active: false })).toBe("pi-tuck 9.9.9 is loaded but inactive in this host; Pi's own compaction runs.");
});

test('/tuck is a command, not a tool, and shows no JSON', async () => {
 const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>(), tools: string[] = [];
 const pi = { registerCommand: (name: string, c: { handler: (args: string, ctx: unknown) => Promise<void> }) => { commands.set(name, c.handler); },
  registerTool: (tool: { name: string }) => { tools.push(tool.name); }, on: () => () => {} } as unknown as ExtensionAPI;
 await installCompaction(pi, { search: false });
 expect(tools.sort()).toEqual(['tuck_recall']);
 const notices: string[] = [];
 await commands.get('tuck')!('', { sessionManager: { getBranch: () => [ours(1000, 200)] }, ui: { notify: (message: string) => { notices.push(message); } } });
 expect(notices).toHaveLength(1);
 expect(notices[0]).toContain(`pi-tuck ${LOADED_VERSION} `);
 expect(notices[0]).toContain('Cuts: 1 by pi-tuck in this session, the last from 1,000 to 200 tokens.');
 expect(notices[0]).not.toContain('{');
});

test('/compact with text cuts as plain /compact does and says the text was not used', async () => {
 const run = async (instructions?: string) => {
  const h = await harness({ at: 'prompt', complete: 60000, host: 0 });
  try {
   let outcome = 'compacted';
   try { await h.session.compact(instructions); } catch (error) { outcome = String(error); }
   return { outcome, summaries: h.compactions().map(e => (e as { summary: string }).summary), notices: [...h.notices], faults: [...h.faults] };
  } finally { await h.cleanup(); }
 };
 const plain = await run(), steered = await run('keep the file names');
 expect(steered.outcome, JSON.stringify(steered)).toBe('compacted');
 expect(steered.faults).toEqual([]);
 expect(steered.summaries).toHaveLength(1);
 expect(steered.summaries).toEqual(plain.summaries);
 expect(steered.notices.filter(n => n.includes('/compact ignores the text after it'))).toHaveLength(1);
 expect(plain.notices.filter(n => n.includes('/compact ignores'))).toEqual([]);
});
