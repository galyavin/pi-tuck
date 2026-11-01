import { test, expect } from 'vitest';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { SessionManager, type ExtensionAPI, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { installCompaction } from '../src/compaction';

// A model's near miss gets the shape it was close to, not the export shape that is listed first. Pi's validator checks only that each
// field is known and in range; the tool checks the exact shape.
test('tuck_recall names the closest call shape and what to add or remove', async () => {
 const tools: ToolDefinition[] = [];
 const pi = { on: () => {}, registerCommand: () => {}, registerTool: (t: ToolDefinition) => { tools.push(t); } } as unknown as ExtensionAPI;
 const handle = await installCompaction(pi, { assertAccess: () => {} });
 const recall = tools.find(t => t.name === 'tuck_recall')!;
 const m = SessionManager.inMemory('/recall-arguments'); m.appendMessage({ role: 'user', content: 'needle', timestamp: 1 });
 const call = async (args: Record<string, unknown>) => {
  const checked = validateToolArguments(recall as never, { type: 'toolCall', id: 'c', name: 'tuck_recall', arguments: args } as never);
  return recall.execute('c', checked as never, undefined, undefined, { sessionManager: m, cwd: '/recall-arguments' } as never);
 };
 try {
  // The calls a local model made, by key (Nautilus's counts): {limit, query} and {around, before}.
  await expect(call({ query: 'needle', limit: 10 })).rejects.toThrow('Invalid tuck_recall arguments {query, limit}. Closest call: {query}: remove limit; or {entryId, query?, offset?, limit?}: add entryId.');
  await expect(call({ around: 'x', before: 5 })).rejects.toThrow('before: must be <= 3');
  await expect(call({ entryId: 'e', outputPath: 'out', limit: 3 })).rejects.toThrow('Closest call: {entryId, outputPath}: remove limit; or {entryId, query?, offset?, limit?}: remove outputPath.');
  await expect(call({ foo: 1 })).rejects.toThrow('Validation failed');
  for (const ok of [{ query: 'needle' }, {}, { limit: 5 }]) await expect(call(ok)).resolves.toBeDefined();
 } finally { await handle.close(); }
}, 60_000);
