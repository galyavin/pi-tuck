import { expect, test, vi } from 'vitest';
import { SessionManager, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { installCompaction } from '../src/compaction';

for (const api of ['pi-virtual', 'openai-completions'])
test.each([0, -1, undefined, NaN, Infinity, -Infinity])(`${api} with unknown window %s leaves prompts and native compaction alone`, async contextWindow => {
 const manager = SessionManager.inMemory('/virtual/window');
 const first = manager.appendMessage({ role: 'user', content: 'Historical prompt', timestamp: 0 });
 manager.appendCompaction('A saved pi-tuck summary must stay byte-identical.', first, 100, { compactor: 'pi-tuck', version: 2 });
 const handlers = new Map<string, ((event: any, ctx: ExtensionContext) => any)[]>();
 const faults: unknown[] = [], notify = vi.fn(), abort = vi.fn(), commands = new Map<string, any>();
 const pi = { on: (name: string, handler: any) => handlers.set(name, [...handlers.get(name) ?? [], handler]),
  registerTool() {}, registerCommand: (name: string, command: any) => commands.set(name, command), appendEntry: vi.fn(), getSettings: () => ({}), getAllTools: () => [], getActiveTools: () => [] } as unknown as ExtensionAPI;
 const handle = await installCompaction(pi, { fail: error => faults.push(error) });
 const ctx = { model: { provider: 'fixture', api, id: 'virtual', contextWindow, maxTokens: 4096 }, cwd: '/virtual/window',
  sessionManager: manager, isIdle: () => true, abort, ui: { notify }, getSystemPrompt: () => 'system' } as unknown as ExtensionContext;
 const emit = async (name: string, event: any = {}) => {
  const results: unknown[] = [];
  for (const handler of handlers.get(name) ?? []) { const result = await handler(event, ctx); if (result !== undefined) results.push(result); }
  return results;
 };
 try {
  const prompt = 'prompt '.repeat(10000);
  await emit('input', { text: prompt });
  await emit('before_agent_start', { prompt, systemPrompt: 'system', systemPromptOptions: { selectedTools: [] } });
  await emit('agent_start');
  const message = { role: 'user' as const, content: prompt, timestamp: 0 };
  await emit('message_end', { message }); manager.appendMessage(message);
  const messages = manager.buildSessionProjection().messages;
  expect(await emit('context', { messages })).toEqual([]);
  expect(await emit('context_with_system', { messages })).toEqual([]);
  expect(faults).toEqual([]);
  expect(abort).not.toHaveBeenCalled();
  expect(notify).not.toHaveBeenCalled();
  for (const reason of ['threshold', 'overflow', 'manual'])
   expect(await emit('session_before_compact', { reason, signal: new AbortController().signal, entries: [], branchEntries: manager.getBranch(), preparation: { tokensBefore: 20000 } })).toEqual([]);
  expect(await emit('session_before_tree', { preparation: { userWantsSummary: true } })).toEqual([]);
  const context = { contextMessages: messages, pendingMessages: [], canContinue: true };
  expect(await emit('turn_end', { message: { role: 'assistant', stopReason: 'length', content: [{ type: 'thinking', thinking: 'unfinished' }] },
   messageEntryId: 'reply', entries: [], toolResults: [], outcome: 'completed', context })).toEqual([]);
  expect(await emit('agent_before_settle', { entries: [], outcome: 'completed', context })).toEqual([]);
  expect(pi.appendEntry).not.toHaveBeenCalled();
  await emit('message_end', { message: { role: 'assistant', stopReason: 'length' } });
  await emit('agent_settled');
  expect(notify).not.toHaveBeenCalled();
  await commands.get('tuck').handler('', ctx);
  expect(notify.mock.calls.at(-1)?.[0]).toContain('standing down:');
  expect(notify.mock.calls.at(-1)?.[0]).toContain(api === 'pi-virtual' ? 'pi-virtual model' : 'context window');
 } finally { await handle.close(); }
});

test('a pi-virtual model with a positive window also stands down', async () => {
 const { drive, sessionWith } = await import('./calibration-fixture');
 const d = await drive(sessionWith([]).manager);
 try {
  d.ctx.model = { ...d.ctx.model!, api: 'pi-virtual', contextWindow: 16384 };
  await d.start(); await d.offer(100000);
  expect(d.errors).toEqual([]);
  expect(d.ctx.abort).not.toHaveBeenCalled();
 } finally { await d.close(); }
});
