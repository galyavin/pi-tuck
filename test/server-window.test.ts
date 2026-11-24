import { expect, test } from 'vitest';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { drive, MODEL } from './calibration-fixture';
import { harness } from './budget-fixture';

const legacyWindow = 'pi-tuck-window';

test('a length stop at an independent output limit does not teach a context window', async () => {
 const manager = SessionManager.inMemory('/virtual/pi-tuck-test/window');
 const d = await drive(manager);
 try {
  await d.start();
  await d.offer(40_000);
  await d.emit('before_provider_request', { payload: { max_tokens: 16_384, n_predict: 4_489 } });
  const message: AssistantMessage = { role: 'assistant', api: MODEL.api, provider: MODEL.provider, model: MODEL.id,
   content: [{ type: 'text', text: 'Partial answer' }], stopReason: 'length', timestamp: 1,
   usage: { input: 63_000, cacheRead: 511, cacheWrite: 0, output: 4_489, totalTokens: 68_000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  await d.emit('message_end', { message });
  const id = manager.appendMessage(message);
  await d.emit('turn_end', { message, messageEntryId: id });
  expect(manager.getBranch()).toContainEqual(expect.objectContaining({ type: 'custom', customType: 'pi-tuck-calibration' }));
  expect(manager.getBranch()).not.toContainEqual(expect.objectContaining({ type: 'custom', customType: legacyWindow }));
  expect(manager.getBranch()).toContainEqual(expect.objectContaining({ id, message }));
 } finally { await d.close(); }
});

test('real Pi resumes with the configured window even when the session contains a legacy inferred window', async () => {
 const rooms: number[] = [];
 const seed = SessionManager.inMemory('/virtual/pi-tuck-test/legacy-window');
 seed.appendCustomEntry(legacyWindow, {
  calibrationIdentity: JSON.stringify([MODEL.provider, MODEL.api, MODEL.id]),
  learnedContextWindow: 4_096, catalogueContextWindow: 81_920, serverClippedReplyId: 'old',
 });
 const h = await harness({ at: 'prompt', complete: 0, noHistory: true, noOpening: true, persist: false,
  branch: seed.getBranch(), stableHost: true, limits: { contextWindow: 81_920, maxTokens: 16_384 },
  host: 200, systemTokens: 800, reserveTokens: 16_384, keepRecent: 20_000,
  compaction: { requestReserve: undefined, observeBudget: budget => rooms.push(budget.room) } });
 try {
  expect(h.session.model).toMatchObject({ provider: MODEL.provider, api: MODEL.api, id: MODEL.id });
  expect(h.manager.getBranch()).toContainEqual(expect.objectContaining({ type: 'custom', customType: legacyWindow }));
  await h.session.prompt(h.sized(4_500));
  expect(rooms.length).toBeGreaterThan(0);
  expect(rooms.every(room => room === 81_920 - 16_384)).toBe(true);
  expect(h.session.messages.findLast(m => m.role === 'assistant')).toMatchObject({ stopReason: 'stop' });
  expect(h.faults).toEqual([]);
 } finally { await h.cleanup(); }
});
