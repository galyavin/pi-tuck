import { expect, test, vi } from 'vitest';
import { SessionManager, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { installCompaction } from '../src/compaction';

async function harness() {
 const handlers = new Map<string, ((event: any, ctx: ExtensionContext) => unknown)[]>();
 const pi = { on: (name: string, handler: (event: any, ctx: ExtensionContext) => unknown) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
  registerCommand() {}, registerTool() {}, appendEntry() {}, getSettings: () => ({}), getAllTools: () => [], getActiveTools: () => [] } as unknown as ExtensionAPI;
 const handle = await installCompaction(pi, { requestReserve: () => ({ response: 100, responseExact: true }) });
 const notify = vi.fn(), abort = vi.fn();
 const ctx = { hasUI: false, model: { provider: 'p', api: 'a', id: 'm', contextWindow: 1000, maxTokens: 100 },
  cwd: '/x', isIdle: () => true, abort, getSystemPrompt: () => 'system', ui: { notify }, sessionManager: SessionManager.inMemory('/x') } as unknown as ExtensionContext;
 const emit = async (name: string, event: unknown) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); };
 return { ctx, notify, abort, emit, close: () => handle.close() };
}

for (const kind of ['refusal', 'overflow', 'manual instructions', 'manual refusal', 'length stop'] as const)
test(`no UI: ${kind} is visible on stderr`, async () => {
 const h = await harness(), written: string[] = [];
 const write = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { written.push(String(chunk)); return true; });
 try {
  if (kind === 'refusal') await h.emit('context_with_system', { messages: [{ role: 'user', content: 'x'.repeat(10000), timestamp: 0 }] });
  else if (kind === 'overflow') {
   await h.emit('context_with_system', { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] });
   await h.emit('message_end', { message: { role: 'assistant', provider: 'p', api: 'a', model: 'm', content: [], stopReason: 'error', errorMessage: 'request exceeds the context window' } });
  } else if (kind.startsWith('manual')) {
   if (kind === 'manual refusal') h.ctx.getSystemPrompt = () => 'x'.repeat(10000);
   await h.emit('session_before_compact', { reason: 'manual', customInstructions: kind === 'manual instructions' ? 'please summarize' : '',
    signal: new AbortController().signal, preparation: { tokensBefore: 0 }, branchEntries: [] });
  } else {
   await h.emit('message_end', { message: { role: 'assistant', content: [], stopReason: 'length' } });
   await h.emit('agent_settled', {});
  }
  const expected = { refusal: 'shorten the input', overflow: 'provider refused', 'manual instructions': '/compact ignores',
   'manual refusal': 'pi-tuck cannot select a cut', 'length stop': 'output limit' }[kind];
  expect(written.join('')).toContain(expected);
  expect(h.notify).not.toHaveBeenCalled();
 } finally { write.mockRestore(); await h.close(); }
});

test('a closed stderr does not prevent a no-UI refusal from aborting', async () => {
 const h = await harness(), write = vi.spyOn(process.stderr, 'write').mockImplementation(() => { throw new Error('closed'); });
 try {
  await expect(h.emit('context_with_system', { messages: [{ role: 'user', content: 'x'.repeat(10000), timestamp: 0 }] })).resolves.toBeUndefined();
  expect(h.abort).toHaveBeenCalledOnce();
 } finally { write.mockRestore(); await h.close(); }
});
