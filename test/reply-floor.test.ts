import { expect, test, vi } from 'vitest';
import { SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { branchReplyFloor, carriesPrompt } from '../src/request-capacity';
import { drive, MODEL } from './calibration-fixture';
import { harness, OVERFLOW_TEXT } from './budget-fixture';
import { assertNativeToolRounds } from '../src/protocol';
import { tuck, tuckRecall, tuckObservedDraft } from '../src/tuck';
import { createRecall } from '../src/recall';
import { semanticEligibleSources } from '../src/semantic-recall';
import { conversationTokens } from '../src/budget';
import { serializeTranscript } from '../src/tuck/core/transcript';
import { DIALOGUE_SUFFIX } from '../src/tuck/core/format';
import { BUILD_ID } from '../src/build-id';

const response = (output: number, stopReason = 'stop', errorMessage?: string) => ({ role: 'assistant' as const, content: [{ type: 'text' as const, text: 'done' }],
 api: MODEL.api, provider: MODEL.provider, model: MODEL.id, timestamp: 1, stopReason, errorMessage,
 usage: { input: 0, output, cacheRead: 0, cacheWrite: 0, totalTokens: output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }) as Parameters<SessionManager['appendMessage']>[0];

test('branch floor: minimum 4096, largest output across cuts, reserve cap and branch selection', () => {
 const manager = SessionManager.inMemory('/x');
 const first = manager.appendMessage({ role: 'user', content: 'start', timestamp: 0 });
 expect(branchReplyFloor(manager.getBranch(), 16_384)).toBe(4_096);
 expect(branchReplyFloor(manager.getBranch(), 100)).toBe(100);
 manager.appendMessage(response(6_000));
 expect(branchReplyFloor(manager.getBranch(), 16_384)).toBe(6_000);
 manager.appendMessage(response(12_000));
 manager.appendMessage(response(400));
 manager.appendCompaction('summary', '', 1);
 expect(branchReplyFloor(manager.getBranch(), 16_384)).toBe(12_000);
 expect(branchReplyFloor(manager.getBranch(), 10_000)).toBe(10_000);
 manager.branch(first);
 expect(branchReplyFloor(manager.getBranch(), 16_384)).toBe(4_096);
});

test.each(['length', 'overflow'] as const)('%s on the retained branch holds the entire reserve', kind => {
 const manager = SessionManager.inMemory('/x');
 manager.appendMessage(response(1, kind === 'length' ? 'length' : 'error', OVERFLOW_TEXT));
 manager.appendCompaction('summary', '', 1);
 expect(branchReplyFloor(manager.getBranch(), 32_768)).toBe(32_768);
});

test('prompt check handles decoded quotes, newlines, images, whole summary quotes and rejects partial or assistant-only copies', () => {
 const prompt = 'start "quoted"\r\nlast condition \\';
 expect(carriesPrompt([{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image', data: 'unused', mimeType: 'image/png' }], timestamp: 0 }], prompt)).toBe(true);
 const summary = serializeTranscript([{ kind: 'excerpt', role: 'user', text: prompt }]) + DIALOGUE_SUFFIX;
 expect(carriesPrompt([{ role: 'compactionSummary', summary, tokensBefore: 1, timestamp: 0 }], prompt)).toBe(true);
 expect(carriesPrompt([{ role: 'user', content: prompt.slice(0, -1), timestamp: 0 }], prompt)).toBe(false);
 expect(carriesPrompt([response(1) as never], prompt)).toBe(false);
});

test('missing whole run prompt stops through fail exactly once and writes one refusal receipt', async () => {
 const manager = SessionManager.inMemory('/x');
 const d = await drive(manager);
 try {
  await d.start();
  await d.emit('before_agent_start', { prompt: 'WHOLE RUN PROMPT', systemPrompt: 'system', systemPromptOptions: { selectedTools: [] } });
  await d.emit('agent_start', {});
  await d.offer(200); await d.offer(200);
  expect(d.errors.map(String).join(' ')).toContain('Prompt check failed');
  expect(d.notices.join(' ')).toContain('whole text');
  const receipts = manager.getBranch().filter(e => e.type === 'custom' && e.customType === 'pi-tuck-capacity');
  expect(receipts).toHaveLength(1);
  expect(receipts[0]).toMatchObject({ data: { kind: 'refusal', buildId: BUILD_ID } });
 } finally { await d.close(); vi.restoreAllMocks(); }
});

test('real Pi guard receipts preserve tool pairing, parentage, prompt cut boundaries and recovery after a mid-run refusal', async () => {
 let dropPrompt = false;
 const h = await harness({ at: 'prompt', complete: 0, noHistory: true, noOpening: true, host: 200, systemTokens: 18_000,
  limits: { contextWindow: 32_768, maxTokens: 8_192 }, reserveTokens: 16_384, persist: true,
  compaction: { requestReserve: undefined }, toolCalls: request => request <= 2 || request === 4, toolResultTokens: () => 100,
  onBoundary: (_event, ctx) => { if (dropPrompt) { const user = ctx.sessionManager.getBranch().findLast(e => e.type === 'message' && e.message.role === 'user'); if (user) h.manager.appendContextEdit(user.id, null); } },
  replyWindow: 'clip', replyWindowOutput: () => 48 });
 try {
  await h.session.prompt('Whole prompt for the run');
  expect(h.state.requests).toBe(3);
  expect(h.faults).toEqual([]);
  const receipts = h.manager.getBranch().filter(e => e.type === 'custom' && e.customType === 'pi-tuck-capacity');
  expect(receipts).toHaveLength(3);
  for (const receipt of receipts) {
   const branch = h.manager.getBranch();
   const next = branch.slice(branch.indexOf(receipt) + 1).find(e => e.type === 'message' && e.message.role === 'assistant');
   expect(next?.parentId).toBe(receipt.id);
  }
  assertNativeToolRounds(h.saved());
  for (const cut of h.compactions()) {
   if (cut.firstKeptEntryId) expect(h.manager.getEntry(cut.firstKeptEntryId)?.type).not.toBe('custom');
   expect(cut.summary).not.toContain('pi-tuck-capacity');
  }
  // A late host change forces the fail path on a tool-loop request; its receipt must remain an ordinary branch leaf.
  dropPrompt = true;
  const before = h.state.requests;
  await h.session.prompt('A new prompt deliberately removed by another extension');
  expect(h.state.requests).toBe(before + 1);
  const branch = h.manager.getBranch();
  const last = branch.findLast(e => e.type === 'custom' && e.customType === 'pi-tuck-capacity' && (e.data as {kind?: string}).kind === 'refusal')!;
  const afterRefusal = branch.slice(branch.indexOf(last) + 1).find(e => e.type === 'message' && e.message.role === 'assistant');
  if (afterRefusal) expect(afterRefusal.parentId).toBe(last.id);
  expect(last).toMatchObject({ type: 'custom', customType: 'pi-tuck-capacity', data: { kind: 'refusal' } });
  assertNativeToolRounds(h.saved());
  dropPrompt = false;
  await h.session.prompt('Recover on the next prompt');
  expect(h.state.requests).toBe(before + 2);
  expect(h.state.stops.at(-1)).toBe('stop');
  const file = h.manager.getSessionFile()!;
  const reopened = SessionManager.open(file);
  const forked = SessionManager.open(reopened.createBranchedSession(reopened.getLeafId()!)!);
  expect(forked.buildSessionProjection().messages).toEqual(reopened.buildSessionProjection().messages);
  expect(forked.getBranch().filter(e => e.type === 'custom' && e.customType === 'pi-tuck-capacity').length).toBeGreaterThan(0);
  assertNativeToolRounds(forked.buildSessionProjection().messages);
  expect(h.reopenFile()).toBeGreaterThan(0);
 } finally { await h.cleanup(); }
});

test('capacity receipts cannot enter summaries, omission counts, recall, keyword search or semantic sources', () => {
 const manager = SessionManager.inMemory('/x');
 manager.appendMessage({ role: 'user', content: 'Source task', timestamp: 0 });
 manager.appendMessage(response(10));
 const clean = manager.getEntries().slice();
 const receipt = manager.appendCustomEntry('pi-tuck-capacity', { kind: 'refusal', reason: 'SECRET_RECEIPT_REASON' });
 const { isHistorySource, readable } = createRecall();
 expect(isHistorySource(manager.getEntry(receipt)!)).toBe(false);
 expect(readable(manager.getEntry(receipt)!)).toBeUndefined();
 for (const input of [{}, { entryId: receipt }])
  expect(JSON.stringify(tuckRecall(tuck, manager.getEntries(), manager.getBranch(), input))).not.toContain('SECRET_RECEIPT_REASON');
 expect(tuckRecall(tuck, manager.getEntries(), manager.getBranch(), { query: 'SECRET_RECEIPT_REASON' })).toMatchObject({ hits: [], totalMatches: 0 });
 const ctx = { cwd: '/x', model: MODEL, sessionManager: manager } as never;
 expect(JSON.stringify(semanticEligibleSources(ctx, {}, () => {}))).not.toContain('SECRET_RECEIPT_REASON');
 const draft = () => tuckObservedDraft(tuck, { branchEntries: manager.getBranch(), tokensBefore: 1000, newPrompt: true }, ctx, 1000, conversationTokens, {}, false);
 const withReceipt = draft();
 manager.branch(clean.at(-1)!.id);
 const without = draft();
 const stable = (value: unknown) => JSON.parse(JSON.stringify(value, (key, value) => key === 'timestamp' ? undefined : value));
 expect(stable(withReceipt)).toEqual(stable(without));
});

test('a prompt cut that keeps only its summary survives guard receipts and saves a boundary that keeps the user', async () => {
 // Still require a cut with the smaller 4,096 floor; the old incoming size now fits without one.
 const h = await harness({ at: 'prompt', complete: 76_000, summary: true, summaryOnly: true, summaryTokens: 12_000,
  incoming: 63_000, host: 200, systemTokens: 800, limits: { contextWindow: 81_920, maxTokens: 8_192 }, reserveTokens: 32_768,
  compaction: { requestReserve: undefined }, persist: true });
 try {
  const r = await h.run();
  expect(r.faults, r.probe).toEqual([]);
  expect(r.requests).toBe(1);
  expect(r.entries.length).toBeGreaterThan(0);
  const receipt = h.manager.getBranch().find(e => e.type === 'custom' && e.customType === 'pi-tuck-capacity');
  expect(receipt).toBeDefined();
  const user = h.manager.getBranch().findLast(e => e.type === 'message' && e.message.role === 'user')!;
  const cut = h.compactions().at(-1)!;
  const branch = h.manager.getBranch();
  expect(branch.findIndex(e => e.id === cut.firstKeptEntryId)).toBeLessThanOrEqual(branch.findIndex(e => e.id === user.id));
  expect(h.manager.getEntry(cut.firstKeptEntryId)?.type).toBe('message');
  if (user.type !== 'message' || user.message.role !== 'user') throw new Error('Missing saved prompt');
  const content = user.message.content;
  const text = typeof content === 'string' ? content : content.flatMap(b => b.type === 'text' ? [b.text] : []).join('\n');
  expect(carriesPrompt(h.saved(), text)).toBe(true);
  assertNativeToolRounds(h.saved());
  expect(h.reopenFile()).toBeGreaterThan(0);
 } finally { await h.cleanup(); }
});

test('a persistent commit fault receipts each new attempt once without clearing the fault', async () => {
 const manager = SessionManager.inMemory('/x'), d = await drive(manager);
 try {
  await d.start();
  const event = { reason: 'overflow', aborted: false, fromExtension: true, errorMessage: 'commit refused' };
  await d.emit('session_compact_failed', event);
  await d.emit('session_compact_failed', event);
  const receipts = () => manager.getBranch().filter(e => e.type === 'custom' && e.customType === 'pi-tuck-capacity');
  expect(receipts()).toHaveLength(1);
  await d.emit('agent_settled', {});
  await d.emit('before_agent_start', { prompt: 'Retry', systemPrompt: 'system', systemPromptOptions: { selectedTools: [] } });
  await d.offer(200);
  expect(receipts()).toHaveLength(2);
  expect(d.errors.map(String).every(e => e.includes('commit refused'))).toBe(true);
 } finally { await d.close(); vi.restoreAllMocks(); }
});
