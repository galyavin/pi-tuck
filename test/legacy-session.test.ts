import { expect, test, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage, type Context } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ToolDefinition, type ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { installCompaction } from '../src/compaction';
import { textOf } from '../src/tuck/core/content';
import { projectedMessages } from '../src/omissions';
import { tuck, tuckRecall } from '../src/tuck';
import { isLookupTool } from '../src/tuck/core/recall-operation';
import { splitSummary } from '../src/tuck/core/transcript';
import { scriptedModelRuntime } from './model-fixture';

// Recorded through the unmodified pi-tuck 1.1.1 extension (03efb8f), using Pi's persisted session API and scripted replies.
// The actual old search ran with the optional feature off: its keyword evidence and disabled-result envelope are both recorded.
const fixture = new URL('./fixtures/legacy-semantic-session.jsonl', import.meta.url);

for (const name of ['tuck_search', 'vcc_search'])
test(`a saved ${name} call and result load, summarize, cut, recall and resume without the removed tool`, async () => {
 const dir = mkdtempSync(join(tmpdir(), 'pi-old-session-')), file = join(dir, 'session.jsonl');
 const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected HTTP'));
 const raw = readFileSync(fixture, 'utf8');
 expect(raw).not.toMatch(/\/Users\/|\/private\/|\/var\/folders\/|pi-legacy-record-/);
 writeFileSync(file, raw.replaceAll('tuck_search', name));
 const manager = SessionManager.open(file, dir), original = manager.getEntries().map(e => ({ id: e.id, json: JSON.stringify(e) }));
 const call = manager.getBranch().find(e => e.type === 'message' && e.message.role === 'assistant' && e.message.content.some(b => b.type === 'toolCall' && b.name === name));
 const result = manager.getBranch().find(e => e.type === 'message' && e.message.role === 'toolResult' && e.message.toolName === name);
 expect(call).toBeDefined(); expect(result).toHaveProperty('message.isError', false); expect(isLookupTool(name)).toBe(true);
 const runtime = await scriptedModelRuntime(), model = runtime.getModel('openai-codex', 'gpt-6.1-sol')!;
 const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: true, reserveTokens: 32768, keepRecentTokens: 0 } });
 let handle: Awaited<ReturnType<typeof installCompaction>> | undefined, recall: ToolDefinition | undefined;
 const faults: string[] = [], requests: Context[] = [];
 const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings, noExtensions: true, noSkills: true,
  noContextFiles: true, noPromptTemplates: true, noThemes: true, systemPrompt: 'Continue the compatibility check.', extensionFactories: [async pi => {
   const register = pi.registerTool.bind(pi);
   pi.registerTool = tool => { if (tool.name === 'tuck_recall') recall = tool as unknown as ToolDefinition; register(tool); };
   try { handle = await installCompaction(pi, { settings, cutAt: 1, fail: error => faults.push(String(error)) }); }
   finally { pi.registerTool = register; }
  }] });
 await loader.reload();
 const { session } = await createAgentSession({ cwd: dir, modelRuntime: runtime, model, thinkingLevel: 'low', sessionManager: manager,
  settingsManager: settings, resourceLoader: loader, tools: ['tuck_recall'] });
 try {
  await session.bindExtensions({ onError: event => faults.push(event.error) });
  let request = 0;
  session.agent.streamFunction = (_model, context) => {
   requests.push(structuredClone(context));
   const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
    content: ++request === 1 ? [{ type: 'toolCall', id: 'new-recall', name: 'tuck_recall', arguments: { query: 'sapphire migration' } }]
     : [{ type: 'text', text: 'The historical decision remains available. ' + 'Current public observation. '.repeat(1500) }],
    stopReason: request === 1 ? 'toolUse' : 'stop', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
     cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
   const stream = createAssistantMessageEventStream(); stream.push({ type: 'done', reason: request === 1 ? 'toolUse' : 'stop', message }); stream.end(message); return stream;
  };
  await session.prompt('Continue from the saved sapphire migration decision.');
  expect(requests.length).toBeGreaterThanOrEqual(2);
  for (const context of requests) expect(getCurrentTools(context.messages).map(t => t.name)).toEqual(['tuck_recall']);
  const freshResult = manager.getBranch().find(e => e.type === 'message' && e.message.role === 'toolResult' && e.message.toolCallId === 'new-recall');
  expect(freshResult).toHaveProperty('message.isError', false);
  expect(JSON.stringify(freshResult)).toContain('sapphire migration');
  const cut = await session.compact();
  expect(splitSummary(cut.summary)).toBeDefined();
  expect(splitSummary(cut.summary)!.closing).not.toMatch(/tuck_search|vcc_search/);
  const ctx = { cwd: dir, sessionManager: manager } as unknown as ExtensionToolContext;
  // Invoke the registered tool too: exact reads must return the old result byte for byte, rather than a rewritten result envelope.
  const exact = await recall!.execute('read-old-result', { entryId: result!.id }, undefined, undefined, ctx);
  const page = JSON.parse(textOf(exact.content));
  if (result?.type !== 'message' || result.message.role !== 'toolResult') throw new Error('Missing old result');
  expect(page.entries[0].text).toBe(textOf(result.message.content));
  expect(JSON.stringify(tuckRecall(tuck, manager.getEntries(), manager.getBranch(), { query: 'sapphire migration' }))).toContain('sapphire migration');
  const resumed = SessionManager.open(file, dir);
  expect(projectedMessages(resumed.buildSessionProjection().messages, { cwd: dir, sessionManager: resumed } as unknown as ExtensionToolContext).length).toBeGreaterThan(0);
  for (const entry of original) expect(JSON.stringify(resumed.getEntries().find(e => e.id === entry.id))).toBe(entry.json);
  expect(faults).toEqual([]); expect(network).not.toHaveBeenCalled();
 } finally {
  await session.abort(); await handle?.close(); session.dispose(); network.mockRestore(); rmSync(dir, { recursive: true, force: true });
 }
});

test('unknown private index/setup-era custom entries are ignored by load, projection, summary and recall', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'pi-old-private-')), file = join(dir, 'session.jsonl');
 try {
  writeFileSync(file, readFileSync(fixture));
  const manager = SessionManager.open(file, dir), before = manager.buildSessionProjection().messages;
  // 1.1.1 stored no index/setup receipts in session JSONL. Unknown private types must remain generic, inert records if another host did.
  const ids = ['pi-tuck-index', 'pi-tuck-setup', 'vcc-index', 'vcc-setup', 'unknown-private-type'].flatMap(type =>
   [null, 7, 'PRIVATE_OLD_RECEIPT', { state: 'ready', receipt: 'PRIVATE_OLD_RECEIPT' }].map(data => manager.appendCustomEntry(type, data)));
  const reopened = SessionManager.open(file, dir);
  expect(reopened.buildSessionProjection().messages).toEqual(before);
  const branch = reopened.getBranch(), entries = reopened.getEntries();
  expect(ids.every(id => entries.some(e => e.id === id))).toBe(true);
  const ctx = { cwd: dir, sessionManager: reopened } as unknown as ExtensionToolContext;
  expect(JSON.stringify(projectedMessages(before, ctx))).not.toContain('PRIVATE_OLD_RECEIPT');
  expect(tuckRecall(tuck, entries, branch, { query: 'PRIVATE_OLD_RECEIPT' })).toHaveProperty('hits', []);
  for (const id of ids) expect(tuckRecall(tuck, entries, branch, { entryId: id })).toHaveProperty('status', 'not_found');
  const clean = SessionManager.inMemory(dir, undefined, [reopened.getHeader()!, ...entries.filter(e => !ids.includes(e.id))]);
  const { tuckObservedDraft } = await import('../src/tuck');
  const { measurableConversationTokens } = await import('../src/budget');
  const summary = (m: SessionManager) => {
   const context = { ...ctx, sessionManager: m, model: { contextWindow: 272000 } } as unknown as ExtensionToolContext;
   return tuckObservedDraft(tuck, { branchEntries: m.getBranch(), tokensBefore: 50000, operatorManual: true }, context, 32768,
    messages => measurableConversationTokens(messages, context));
  };
  const withReceipts = summary(reopened), withoutReceipts = summary(clean);
  expect(withReceipts.compaction).toBeDefined();
  expect(withReceipts).toEqual(withoutReceipts);
 } finally { rmSync(dir, { recursive: true, force: true }); }
});
