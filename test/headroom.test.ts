import { expect, test } from 'vitest';
import { estimateTokens, SettingsManager, type SessionBeforeCompactEvent } from '@earendil-works/pi-coding-agent';
import { bandOf, conversationTokens, DEFAULT_CUT_AT, requestTokens, TRIGGER_MARGIN_FRACTION } from '../src/budget';
import { assertNativeToolRounds } from '../src/protocol';
import { carriesPrompt } from '../src/request-capacity';
import { tuck, tuckDraft, tuckObservedDraft } from '../src/tuck';
import { part3Fixture } from './part3-fixture';

test.each([16384, 49152, 262144])('post-cut headroom meets native keep-recent at room %i', room => {
  const f = part3Fixture(400, room + 8192, 8192, 0);
  const keepRecentTokens = SettingsManager.inMemory().getCompactionSettings(f.ctx.model).keepRecentTokens;
  const systemPrompt = 's'.repeat(4800);
  const measure = (messages: Parameters<typeof requestTokens>[0]) => requestTokens(messages, systemPrompt);
  const draft = tuckObservedDraft(tuck, { branchEntries: f.manager.getBranch(), tokensBefore: f.before, keepRecentTokens },
    f.ctx, f.reserve, measure);
  if (!draft.compaction) throw new Error(draft.unavailable);
  f.manager.appendCompaction(draft.compaction.summary, draft.compaction.firstKeptEntryId, f.before, draft.compaction.details, true);
  const messages = f.manager.buildSessionProjection().messages;
  const summary = messages.find(message => message.role === 'compactionSummary')!;
  const summaryTokens = estimateTokens(summary);
  const offset = measure([summary]) - summaryTokens;
  const carried = measure(messages);
  const band = bandOf(room, DEFAULT_CUT_AT);
  expect(band).toBe(room - Math.ceil(room * TRIGGER_MARGIN_FRACTION));
  expect(carried).toBe(draft.after);
  expect(carried - summaryTokens).toBeLessThanOrEqual(keepRecentTokens + offset);
  expect(band - carried).toBeGreaterThanOrEqual(room - (offset + keepRecentTokens + summaryTokens));
  expect((draft.compaction.details as { carriedTarget: number }).carriedTarget).toBeLessThanOrEqual(keepRecentTokens + offset);
  expect(draft.after).toBeLessThanOrEqual((draft.compaction.details as { carriedTarget: number }).carriedTarget);
  assertNativeToolRounds(messages);
});

test('the keep-recent cap preserves a whole protected prompt and fresh round above its limit', () => {
  const f = part3Fixture(80);
  const keepRecentTokens = 1000;
  const prompt = 'Protected prompt "whole"\n' + 'condition '.repeat(1200);
  const protectedPromptEntryId = f.manager.appendMessage({ role: 'user', content: prompt, timestamp: 1700001000000 });
  const call = { role: 'assistant' as const, content: [{ type: 'toolCall' as const, id: 'fresh', name: 'read', arguments: { path: 'fresh.ts' } }],
    api: 'openai-completions' as const, provider: 'probe', model: 'probe', stopReason: 'toolUse' as const, timestamp: 1700001000001,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  const receipt = { role: 'toolResult' as const, toolCallId: 'fresh', toolName: 'read', isError: false,
    content: [{ type: 'text' as const, text: 'fresh source '.repeat(1000) }], timestamp: 1700001000002 };
  f.manager.appendMessage(call);
  f.manager.appendMessage(receipt);
  expect(conversationTokens([{ role: 'user', content: prompt, timestamp: 0 }])).toBeGreaterThan(keepRecentTokens);
  expect(conversationTokens([call, receipt])).toBeGreaterThan(keepRecentTokens);
  const before = f.measure(f.manager.buildSessionProjection().messages);
  const draft = tuckObservedDraft(tuck, { branchEntries: f.manager.getBranch(), tokensBefore: before, protectedPromptEntryId, keepRecentTokens },
    f.ctx, f.reserve, f.measure);
  if (!draft.compaction) throw new Error(draft.unavailable);
  expect(draft.after).toBeGreaterThan(keepRecentTokens);
  f.manager.appendCompaction(draft.compaction.summary, draft.compaction.firstKeptEntryId, before, draft.compaction.details, true);
  const messages = f.manager.buildSessionProjection().messages;
  expect(carriesPrompt(messages, prompt)).toBe(true);
  expect(messages.slice(-2)).toEqual([call, receipt]);
  assertNativeToolRounds(messages);
});

test('native preparation keep-recent overrides the fallback, and legacy callers keep their uncapped target', () => {
  const f = part3Fixture();
  const settings = SettingsManager.inMemory().getCompactionSettings(f.ctx.model);
  const input = { branchEntries: f.manager.getBranch(), tokensBefore: f.before };
  const direct = (keepRecentTokens?: number) => tuckObservedDraft(tuck, { ...input, keepRecentTokens }, f.ctx, f.reserve, f.measure);
  const event = { branchEntries: input.branchEntries, preparation: { tokensBefore: f.before, settings } } as SessionBeforeCompactEvent;
  expect(tuckDraft(tuck, event, f.ctx, f.reserve, f.measure, {}, true, false, false, undefined, 0)).toEqual(direct(settings.keepRecentTokens));
  const legacy = { ...event, preparation: { ...event.preparation, settings: undefined } } as unknown as SessionBeforeCompactEvent;
  expect(tuckDraft(tuck, legacy, f.ctx, f.reserve, f.measure, {}, true, false, false, undefined, settings.keepRecentTokens)).toEqual(direct(settings.keepRecentTokens));
  expect(tuckDraft(tuck, legacy, f.ctx, f.reserve, f.measure)).toEqual(direct());
  const uncapped = direct(), capped = direct(settings.keepRecentTokens);
  if (!uncapped.compaction || !capped.compaction) throw new Error('Missing comparison draft');
  expect(uncapped.after).toBeGreaterThan(capped.after);
});
