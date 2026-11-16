import { expect, test } from 'vitest';
import { SessionManager, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { conversationTokens } from '../src/budget';
import { createRecall, type RecallPage } from '../src/recall';
import { thinkingRecords } from '../src/content-observations';
import { tuck, tuckObservedDraft, tuckRecall } from '../src/tuck';
import { installCompaction } from '../src/compaction';
import { buildGlobalIndexById } from '../src/tuck/core/global-indices';
import { parseRecords, serializeRecords, splitSummary } from '../src/tuck/core/transcript';
import { filterOmittedSummary } from '../src/omissions';

const assistant = (content: unknown[]) => ({ role: 'assistant', content, stopReason: 'stop', timestamp: 0,
  api: 'openai-completions', provider: 'probe', model: 'probe', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }) as never;

function fixture(block: Record<string, unknown> = { type: 'thinking', thinking: 'Inspect the parser before changing the import path. '.repeat(20) }) {
  const manager = SessionManager.inMemory('/plain-thinking');
  manager.appendMessage({ role: 'user', content: 'Keep the parser behavior intact.', timestamp: 0 });
  manager.appendMessage(assistant([{ type: 'toolCall', id: 'write', name: 'write', arguments: { path: 'engine.go', content: 'package engine\nfunc Parse() {}' } }]));
  manager.appendMessage({ role: 'toolResult', toolCallId: 'write', toolName: 'write', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 0 });
  manager.appendMessage(assistant([{ type: 'toolCall', id: 'bash', name: 'bash', arguments: { command: 'npm test' } }]));
  manager.appendMessage({ role: 'toolResult', toolCallId: 'bash', toolName: 'bash', content: [{ type: 'text', text: 'Tests: 42 passed\nErrors: 0\nDuration: 1s' }], isError: false, timestamp: 0 });
  const thoughtId = manager.appendMessage(assistant([block, { type: 'text', text: 'Recorded observation.' }]));
  // These source passages cannot be clipped into short dialogue excerpts or
  // moved into a tiny native tail, leaving measurable room for the lowest ranks.
  for (let i = 0; i < 12; i++) manager.appendMessage(assistant([{ type: 'text', text: `OLD_${i}:` + 'x'.repeat(9000) }]));
  manager.appendMessage({ role: 'user', content: 'Continue the current task.', timestamp: 0 });
  manager.appendMessage(assistant([{ type: 'text', text: 'Recent state is ready.' }]));
  const ctx = { sessionManager: manager, cwd: '/plain-thinking', model: { contextWindow: 81920, maxTokens: 16384 } } as unknown as ExtensionContext;
  const draft = (room: number) => tuckObservedDraft(tuck, { branchEntries: manager.getBranch(),
    tokensBefore: conversationTokens(manager.buildSessionProjection().messages) }, ctx, 81920 - room, conversationTokens);
  return { manager, thoughtId, draft, thought: block.thinking as string };
}
const rowsOf = (summary: string) => parseRecords(splitSummary(summary)!.body);

test('a plain-thinking opening is quoted with exact recall coordinates by index and entryId', () => {
  const f = fixture(), original = JSON.stringify(f.manager.getEntries()), room = 2400, draft = f.draft(room);
  if (!draft.compaction) throw new Error(draft.unavailable);
  const row = rowsOf(draft.compaction.summary).find(r => r.kind === 'section' && r.title === 'Thinking')!;
  expect(row).toBeDefined();
  const length = Math.max(80, Math.floor(Math.sqrt(4 * room)));
  expect(row.text!.slice(row.text!.indexOf('\n') + 1)).toBe(f.thought.slice(0, length));
  const locator = JSON.parse(row.text!.match(/tuck_recall (\{[^\n]*\})\):\n/u)![1]!) as { index: number; offset: number; limit: number };
  expect(locator.offset).toBe('Recorded observation.\n'.length);
  const entries = f.manager.getEntries(), branch = f.manager.getBranch();
  const read = tuckRecall(tuck, entries, branch, locator) as RecallPage;
  expect(read.entries[0]!.text).toBe(f.thought);
  const byId = tuckRecall(tuck, entries, branch, { entryId: f.thoughtId, offset: locator.offset + 8, limit: 20 }) as RecallPage;
  expect(byId.entries[0]!.text).toBe(f.thought.slice(8, 28));
  // Existing visible-text offsets and source bytes do not move.
  expect((tuckRecall(tuck, entries, branch, { entryId: f.thoughtId, offset: 0, limit: 21 }) as RecallPage).entries[0]!.text).toBe('Recorded observation.');
  expect(JSON.stringify(f.manager.getEntries())).toBe(original);
  expect(parseRecords(serializeRecords([row]))).toEqual([row]);
  expect(filterOmittedSummary(draft.compaction.summary, new Set([row.sourceIndex!]))).not.toContain('Thinking:');
});

test.each([
  { thinkingSignature: 'opaque-signed-payload' },
  { thinkingSignature: '' },
  { redacted: true },
  { encrypted: true },
  { encrypted_content: 'opaque-encrypted-payload' },
  { encryptedContent: 'opaque-encrypted-payload' },
])('signed, redacted and encrypted blocks stay unquoted and unreadable: %j', fields => {
  const f = fixture({ type: 'thinking', thinking: 'PRIVATE_REASONING', ...fields }), original = JSON.stringify(f.manager.getEntries());
  const draft = f.draft(2400);
  if (!draft.compaction) throw new Error(draft.unavailable);
  expect(draft.compaction.summary).not.toContain('PRIVATE_REASONING');
  expect(rowsOf(draft.compaction.summary).some(r => r.kind === 'section' && r.title === 'Thinking')).toBe(false);
  const entries = f.manager.getEntries(), branch = f.manager.getBranch(), index = buildGlobalIndexById(entries).get(f.thoughtId)!;
  expect((tuckRecall(tuck, entries, branch, { index }) as RecallPage).entries[0]!.text).toBe('Recorded observation.');
  expect((tuckRecall(tuck, entries, branch, { entryId: f.thoughtId, query: 'PRIVATE_REASONING' }) as RecallPage).status).toBe('no_matches');
  const only = f.manager.appendMessage(assistant([{ type: 'thinking', thinking: 'PRIVATE_ONLY', ...fields }]));
  expect((tuckRecall(tuck, f.manager.getEntries(), f.manager.getBranch(), { entryId: only }) as RecallPage).status).toBe('not_found');
  const onlyIndex = buildGlobalIndexById(f.manager.getEntries()).get(only)!;
  expect((tuckRecall(tuck, f.manager.getEntries(), f.manager.getBranch(), { index: onlyIndex }) as RecallPage).status).toBe('not_found');
  expect(JSON.stringify(f.manager.getEntries().slice(0, entries.length))).toBe(original);
});

test('plain thinking is newest first, including multiple blocks in one source, and keyword recall finds it', () => {
  const manager = SessionManager.inMemory('/plain-order');
  const older = manager.appendMessage(assistant([{ type: 'thinking', thinking: 'OLDER_PLAIN' }]));
  const newer = manager.appendMessage(assistant([{ type: 'thinking', thinking: 'FIRST_PLAIN' },
    { type: 'thinking', thinking: 'SIGNED_SECRET', thinkingSignature: 'signature' },
    { type: 'thinking', thinking: 'NEWEST_PLAIN' }]));
  const entries = manager.getEntries(), indices = buildGlobalIndexById(entries);
  const rows = [...thinkingRecords(entries, indices, 80)];
  expect(rows.map(row => row.text!.split('\n').at(-1))).toEqual(['NEWEST_PLAIN', 'FIRST_PLAIN', 'OLDER_PLAIN']);
  const second = tuckRecall(tuck, entries, manager.getBranch(), { entryId: newer, offset: 12, limit: 12 }) as RecallPage;
  expect(second.entries[0]!.text).toBe('NEWEST_PLAIN');
  const found = tuckRecall(tuck, entries, manager.getBranch(), { query: 'OLDER_PLAIN' }) as { hits: { entryId: string }[] };
  expect(found.hits.some(hit => hit.entryId === older)).toBe(true);
  expect((tuckRecall(tuck, entries, manager.getBranch(), { query: 'SIGNED_SECRET' }) as { hits: unknown[] }).hits).toEqual([]);
});

test('thinking gives way before output tails or definition maps, with the native tail unchanged', () => {
  const f = fixture(), large = f.draft(2400);
  if (!large.compaction) throw new Error(large.unavailable);
  expect(large.compaction.summary).toContain('Thinking:');
  let tight: ReturnType<typeof f.draft> | undefined;
  for (let room = 2390; room >= 500; room -= 10) {
    const draft = f.draft(room);
    if (!draft.compaction || draft.compaction.firstKeptEntryId !== large.compaction.firstKeptEntryId) continue;
    const summary = draft.compaction.summary;
    if (!summary.includes('Thinking:') && summary.includes('(output tail):') && summary.includes('(definitions as of #')) { tight = draft; break; }
  }
  expect(tight?.compaction).toBeDefined();
  for (const draft of [large, tight!]) {
    if (!draft.compaction) throw new Error(draft.unavailable);
    expect(draft.after).toBeLessThanOrEqual((draft.compaction.details as { carriedTarget: number }).carriedTarget);
  }
});

test('plain and signed thinking in the kept tail stay native and are not quoted', () => {
  const f = fixture();
  const recent = assistant([{ type: 'thinking', thinking: 'KEPT_NATIVE_THOUGHT' },
    { type: 'thinking', thinking: 'KEPT_SIGNED_THOUGHT', thinkingSignature: 'opaque-native-signature' },
    { type: 'text', text: 'Latest recent state.' }]);
  const id = f.manager.appendMessage(recent), draft = f.draft(2400);
  if (!draft.compaction) throw new Error(draft.unavailable);
  expect(draft.compaction.summary).not.toContain('KEPT_NATIVE_THOUGHT');
  expect(draft.compaction.summary).not.toContain('KEPT_SIGNED_THOUGHT');
  f.manager.appendCompaction(draft.compaction.summary, draft.compaction.firstKeptEntryId, draft.compaction.tokensBefore, draft.compaction.details, true);
  expect(f.manager.buildSessionProjection().entries.find(entry => entry.sourceEntry.id === id)?.messages).toEqual([recent]);
});

test('a thinking opening completes a Unicode character at the same boundary as a user opening', () => {
  const manager = SessionManager.inMemory('/plain-unicode');
  manager.appendMessage(assistant([{ type: 'thinking', thinking: 'x'.repeat(79) + '😊 remaining thinking' }]));
  const entries = manager.getEntries(), rows = [...thinkingRecords(entries, buildGlobalIndexById(entries), 80)];
  expect(rows[0]!.text!.split('\n').at(-1)).toBe('x'.repeat(79) + '😊');
});

test('appended plain thinking preserves existing tool-call read offsets and lookup exclusions', () => {
  const manager = SessionManager.inMemory('/plain-prefix');
  const id = manager.appendMessage(assistant([{ type: 'thinking', thinking: 'PLAIN_FINDABLE' }, { type: 'text', text: 'Visible' },
    { type: 'toolCall', id: 'call', name: 'read', arguments: { path: 'a.ts' } },
    { type: 'toolCall', id: 'lookup', name: 'tuck_recall', arguments: { query: 'LOOKUP_EXCLUDED' } }]));
  manager.appendMessage({ role: 'toolResult', toolCallId: 'call', toolName: 'read', content: [{ type: 'text', text: 'file body' }], isError: false, timestamp: 0 });
  const entries = manager.getEntries(), branch = manager.getBranch(), recall = createRecall(), link = [...recall.producerReads(branch).values()][0]!;
  expect(link.offset).toBe('Visible\n'.length);
  const read = tuckRecall(tuck, entries, branch, { entryId: id, offset: link.offset, limit: link.limit }) as RecallPage;
  expect(JSON.parse(read.entries[0]!.text)).toEqual({ toolCall: { name: 'read', id: 'call', arguments: { path: 'a.ts' } } });
  expect((tuckRecall(tuck, entries, branch, { query: 'LOOKUP_EXCLUDED' }) as { hits: unknown[] }).hits).toEqual([]);
  expect((tuckRecall(tuck, entries, branch, { query: 'PLAIN_FINDABLE' }) as { hits: unknown[] }).hits).toHaveLength(1);
});

test('the registered recall description explains plain thinking and excluded reasoning', async () => {
  let tool: ToolDefinition | undefined;
  const pi = { on: () => {}, getSettings: () => ({}), registerCommand: () => {}, registerTool: (value: ToolDefinition) => {
    if (value.name === 'tuck_recall') tool = value;
  } } as unknown as ExtensionAPI;
  await installCompaction(pi);
  expect(tool!.description).toContain('Plain thinking is readable; signed, redacted or encrypted reasoning and system records are excluded.');
});

import { isPlainThinking } from '../src/tuck/core/readable-content';
test('openai-completions marks plain reasoning with its field name, which is not a signature', () => {
  for (const field of ['reasoning', 'reasoning_content', 'reasoning_text']) expect(isPlainThinking({ type: 'thinking', thinking: 'plan', thinkingSignature: field })).toBe(true);
  expect(isPlainThinking({ type: 'thinking', thinking: 'x', thinkingSignature: '[{"type":"reasoning.encrypted","data":"abc"}]' })).toBe(false);
  expect(isPlainThinking({ type: 'thinking', thinking: 'x', thinkingSignature: 'EqQBCkgIAxABGAIiQL' })).toBe(false);
});
