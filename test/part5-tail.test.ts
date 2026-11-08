import { expect, test } from 'vitest';
import { SessionManager, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { carriedTailTokens, conversationTokens, measurableConversationTokens } from '../src/budget';
import { tuck, tuckObservedDraft, type Tuck } from '../src/tuck';
import { assertNativeToolRounds } from '../src/protocol';

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (tokens: number, reasoning = 0) => ({ role: 'assistant' as const,
  content: [...(reasoning ? [{ type: 'thinking' as const, thinking: '', thinkingSignature: 'saved-signature' }] : []), { type: 'text' as const, text: 'a'.repeat(tokens * 4) }],
  stopReason: 'stop' as const, timestamp: 0, api: 'openai-responses' as const, provider: 'probe', model: 'probe', usage: { ...usage, reasoning } });

function fixture(userTokens: number, reasoning = 0, fresh = false) {
  const manager = SessionManager.inMemory('/part5-tail');
  manager.appendMessage({ role: 'user', content: 'First prompt.', timestamp: 0 });
  for (let i = 0; i < 20; i++) manager.appendMessage(assistant(2000));
  manager.appendMessage({ role: 'user', content: 'Latest task: ' + 'u'.repeat(userTokens * 4), timestamp: 0 });
  for (let i = 0; i < 6; i++) manager.appendMessage(assistant(2000, reasoning));
  const result = 'FRESH_RESULT: ' + 'r'.repeat(80000);
  if (fresh) {
    manager.appendMessage({ ...assistant(0), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'fresh', name: 'read', arguments: { path: 'fresh.txt' } }] });
    manager.appendMessage({ role: 'toolResult', toolCallId: 'fresh', toolName: 'read', isError: false, timestamp: 0, content: [{ type: 'text', text: result }] });
  }
  const ctx = { sessionManager: manager, cwd: '/part5-tail', model: { contextWindow: 131072, maxTokens: 16384 } } as unknown as ExtensionContext;
  const measure = (messages: Parameters<typeof conversationTokens>[0]) => measurableConversationTokens(messages, ctx);
  let compiledIds: readonly string[] = [];
  const observing: Tuck = { ...tuck, compileDialogue: input => {
    compiledIds = input.sourceEntryIds!;
    return tuck.compileDialogue(input);
  } };
  const draft = tuckObservedDraft(observing, { branchEntries: manager.getBranch(), tokensBefore: measure(manager.buildSessionProjection().messages) }, ctx, 16384, measure, {}, false);
  if (!draft.compaction) throw new Error(draft.unavailable);
  return { manager, measure, draft, compiledIds, result };
}

test('the shared tail amount preserves smaller offers and caps a 20k offer at the band’s 12,500', () => {
  expect(carriedTailTokens(6000)).toBe(6000);
  expect(carriedTailTokens(20000)).toBe(12500);
});

test('the same bounded native suffix sets the third rank and target base, in the planner estimate', () => {
  // Each newest assistant costs 2k visible + 2k replayed reasoning. Three whole
  // messages fit; a source-character estimate alone would admit six.
  const a = fixture(18000, 2000), b = fixture(28000, 2000);
  for (const f of [a, b]) {
    const branch = f.manager.getBranch(), at = branch.findIndex(entry => entry.id === f.compiledIds.at(-1)) + 1;
    const native = branch.slice(at).flatMap(entry => entry.type === 'message' ? [entry.message] : []);
    expect(native).toHaveLength(3);
    expect(conversationTokens(native)).toBe(12000);
    expect(f.draft.after).toBeLessThanOrEqual((f.draft.compaction.details as { carriedTarget: number }).carriedTarget);
  }
  // Enlarging an older turn in the old offered tail must not inflate the base
  // after that turn moves outside the shared preferred boundary.
  expect((a.draft.compaction.details as { carriedTarget: number }).carriedTarget)
    .toBe((b.draft.compaction.details as { carriedTarget: number }).carriedTarget);
});

test('a required fresh native round stays whole when it exceeds the preferred tail amount', () => {
  const f = fixture(18000, 0, true);
  f.manager.appendCompaction(f.draft.compaction.summary, f.draft.compaction.firstKeptEntryId, 0, f.draft.compaction.details, true);
  const messages = f.manager.buildSessionProjection().messages;
  assertNativeToolRounds(messages);
  const fresh = messages.find(message => message.role === 'toolResult' && message.toolCallId === 'fresh');
  expect(fresh).toMatchObject({ content: [{ type: 'text', text: f.result }] });
  expect(f.measure(messages)).toBe(f.draft.after);
  expect(f.draft.after).toBeLessThanOrEqual((f.draft.compaction.details as { carriedTarget: number }).carriedTarget);
});
