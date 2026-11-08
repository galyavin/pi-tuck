import { test, expect } from 'vitest';
import { SessionManager, convertToLlm, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { carriedTarget, measurableConversationTokens } from '../src/budget';
import { tuck, tuckObservedDraft } from '../src/tuck';
import { filterOmittedSummary, projectedMessages } from '../src/omissions';
import { parseRecords, serializeTranscript, splitSummary, type TranscriptRecord } from '../src/tuck/core/transcript';
import { DIALOGUE_SUFFIX } from '../src/tuck/core/format';
import { normalize } from '../src/tuck/core/normalize';
import { filterNoise } from '../src/tuck/core/filter-noise';
import { view } from './shapes/checks';
import { part3Fixture } from './part3-fixture';

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const answer = (text: string) => ({ role: 'assistant' as const, content: [{ type: 'text' as const, text }], stopReason: 'stop' as const,
  timestamp: 1, api: 'openai-completions' as const, provider: 'probe', model: 'probe', usage });
const context = (manager: SessionManager) => ({ sessionManager: manager, cwd: '/part3-review', model: { contextWindow: 32768, maxTokens: 8192 } }) as unknown as ExtensionContext;
const summary = (records: TranscriptRecord[]) => serializeTranscript(records) + DIALOGUE_SUFFIX;
const recordsOf = (text: string) => parseRecords(splitSummary(text)!.body);
function rangeFixture() {
  const manager = SessionManager.inMemory('/part3-review');
  const ids = [manager.appendMessage({ role: 'user', content: 'user zero', timestamp: 1 }), manager.appendMessage(answer('assistant one')),
    manager.appendMessage({ role: 'user', content: 'user two', timestamp: 1 }), manager.appendMessage(answer('assistant three')),
    manager.appendMessage({ role: 'user', content: 'user four', timestamp: 1 })];
  return { manager, ids };
}

test('review 1: omitting an intervening assistant preserves the counted user range byte for byte', () => {
  const { manager, ids } = rangeFixture();
  const text = summary([{ kind: 'omission', role: 'user', count: 2, sourceRange: { start: 0, end: 4 }, reason: 'tuck_recall' }]);
  const keep = manager.appendMessage({ role: 'user', content: 'current', timestamp: 1 });
  manager.appendCompaction(text, keep, 1000, { compactor: 'pi-tuck' }, true);
  manager.appendContextEdit(ids[1]!, null);
  expect(filterOmittedSummary(text, new Set([1]))).toBe(text);
  expect(filterOmittedSummary(text, new Set([1]), manager.getEntries())).toBe(text);
  const projected = projectedMessages(manager.buildSessionProjection().messages, context(manager));
  expect(projected.find(message => message.role === 'compactionSummary')?.summary).toBe(text);
});

test('review 1: an edit adjusts only counted units of the same role, and pre-cut edits are not subtracted twice', () => {
  const { manager, ids } = rangeFixture();
  manager.appendContextEdit(ids[2]!, null);
  const text = summary([{ kind: 'omission', role: 'user', count: 2, sourceRange: { start: 0, end: 4 }, reason: 'tuck_recall' }]);
  const keep = manager.appendMessage({ role: 'user', content: 'current', timestamp: 1 });
  manager.appendCompaction(text, keep, 1000, { compactor: 'pi-tuck' }, true);
  const ctx = context(manager);
  expect(projectedMessages(manager.buildSessionProjection().messages, ctx).find(message => message.role === 'compactionSummary')?.summary).toBe(text);
  manager.appendContextEdit(ids[0]!, null);
  const adjusted = projectedMessages(manager.buildSessionProjection().messages, ctx).find(message => message.role === 'compactionSummary')!.summary;
  expect(recordsOf(adjusted)).toEqual([{ kind: 'omission', role: 'user', count: 1, sourceRange: { start: 4, end: 4 }, reason: 'tuck_recall' }]);
});

test('review 2: an answered image+text turn keeps its text opening among the newest eight', () => {
  const manager = SessionManager.inMemory('/part3-review');
  manager.appendMessage({ role: 'user', content: 'Earlier first prompt.', timestamp: 1 }); manager.appendMessage(answer('First answer.'));
  const mixed = 'IMAGEOPEN: ' + 'image instruction '.repeat(2000);
  manager.appendMessage({ role: 'user', content: [{ type: 'text', text: mixed }, { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB' }], timestamp: 1 });
  manager.appendMessage(answer('Answered the image turn.'));
  for (let turn = 0; turn < 6; turn++) { manager.appendMessage({ role: 'user', content: `Answered ${turn}: ` + 'q'.repeat(18000), timestamp: 1 }); manager.appendMessage(answer(`Answer ${turn}.`)); }
  manager.appendMessage({ role: 'user', content: 'Current input.', timestamp: 1 });
  const ctx = context(manager), measure = (messages: Parameters<typeof measurableConversationTokens>[0]) => measurableConversationTokens(messages, ctx);
  const draft = tuckObservedDraft(tuck, { branchEntries: manager.getBranch(), tokensBefore: measure(manager.buildSessionProjection().messages) }, ctx, 16384, measure);
  if (!draft.compaction) throw new Error(draft.unavailable);
  manager.appendCompaction(draft.compaction.summary, draft.compaction.firstKeptEntryId, 0, draft.compaction.details, true);
  expect(view(convertToLlm(manager.buildSessionProjection().messages)).texts.some(text => text.includes(mixed.slice(0, 80)))).toBe(true);
});

test('review 3: the whitespace-only current input remains whole after it has been answered', () => {
  const manager = SessionManager.inMemory('/part3-review'), current = ' \n \t ';
  manager.appendMessage({ role: 'user', content: 'USER0:' + 'x'.repeat(30000), timestamp: 1 }); manager.appendMessage(answer('Answer 0. ' + 'y'.repeat(30000)));
  manager.appendMessage({ role: 'user', content: current, timestamp: 1 }); manager.appendMessage(answer('Working '.repeat(1000)));
  const ctx = context(manager), measure = (messages: Parameters<typeof measurableConversationTokens>[0]) => measurableConversationTokens(messages, ctx);
  const draft = tuckObservedDraft(tuck, { branchEntries: manager.getBranch(), tokensBefore: measure(manager.buildSessionProjection().messages) }, ctx, 16384, measure);
  if (!draft.compaction) throw new Error(draft.unavailable);
  manager.appendCompaction(draft.compaction.summary, draft.compaction.firstKeptEntryId, 0, draft.compaction.details, true);
  expect(view(convertToLlm(manager.buildSessionProjection().messages)).texts).toContain(current);
});

test('review 4: unpaired lookup results are counted without dead export-pair metadata or output echoes', () => {
  const messages = [{ role: 'toolResult' as const, toolCallId: 'unpaired', toolName: 'tuck_recall', isError: false, timestamp: 1, content: [{ type: 'text' as const, text: 'LOOKUP_ECHO_BODY' }] }];
  const blocks = filterNoise(normalize(messages, [7]));
  expect(blocks).toEqual([{ kind: 'tool_result', name: 'tuck_recall', sourceIndex: 7 }]);
  const compiled = tuck.compileDialogue({ messages, sourceIndices: [7], ranking: { maxBriefChars: 10000 } });
  expect(compiled).not.toContain('LOOKUP_ECHO_BODY');
  expect(recordsOf(compiled)).toEqual([expect.objectContaining({ role: 'toolResult', count: 1, sourceRange: { start: 7, end: 7 } })]);
});

test('the exported target preserves the existing total-grant arithmetic', () => {
  for (let at = 0; at < 3000; at++) {
    const window = at * 101 + 1, reserve = at % 101 * 97, base = at % 97 * 101, before = at * 67;
    const free = Math.max(0, window - reserve - base - 1);
    const allowance = Math.max(0, Math.min(Math.floor(free / 4), before - base - 1)) * 4;
    expect(carriedTarget(window, reserve, base, before)).toBe(Math.min(Math.max(0, window - reserve - 1), before - 1, base + allowance / 4));
  }
});

test('a cut stays under its single target in the actual projection estimate', () => {
  const f = part3Fixture(240);
  const draft = tuckObservedDraft(tuck, { branchEntries: f.manager.getBranch(), tokensBefore: f.before }, f.ctx, f.reserve, f.measure, {}, false);
  if (!draft.compaction) throw new Error(draft.unavailable);
  f.manager.appendCompaction(draft.compaction.summary, draft.compaction.firstKeptEntryId, f.before, draft.compaction.details, true);
  const after = f.measure(f.manager.buildSessionProjection().messages);
  expect(after).toBe(draft.after);
  expect(after - (draft.compaction.details as { carriedTarget: number }).carriedTarget).toBeLessThanOrEqual(0);
});
