import { expect, test } from 'vitest';
import { SessionManager, type SessionEntry } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { drive, MODEL } from './calibration-fixture';
import { harness, type Options } from './budget-fixture';
import { replyFit, seedContextWindow, WINDOW_RECEIPT } from '../src/request-capacity';

const identity = JSON.stringify([MODEL.provider, MODEL.api, MODEL.id]);
const usage = (output: number) => ({ input: 63_000, cacheRead: 511, cacheWrite: 0, output, totalTokens: 63_511 + output,
 cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

for (const [name, cap, output, learned, laterCap] of [
 ['server clips below the sent cap', 16_384, 4_489, 68_000, undefined],
 ['genuine stop at the sent cap', 4_489, 4_489, undefined, undefined],
 ['no payload cap is no evidence', undefined, 4_489, undefined, undefined],
 ['a later payload edit is the cap actually sent', 16_384, 4_489, undefined, 4_489],
] as const) test(`window evidence: ${name}`, async () => {
 const manager = SessionManager.inMemory('/virtual/pi-tuck-test/window');
 const d = await drive(manager);
 try {
  await d.start(); await d.offer(40_000);
  const payload = { max_tokens: cap };
  if (cap !== undefined) await d.emit('before_provider_request', { payload });
  if (laterCap !== undefined) payload.max_tokens = laterCap;
  const message: AssistantMessage = { role: 'assistant', api: MODEL.api, provider: MODEL.provider, model: MODEL.id,
   content: [{ type: 'text', text: 'Partial answer' }], stopReason: 'length', timestamp: 1, usage: usage(output) };
  await d.emit('message_end', { message });
  const id = manager.appendMessage(message);
  await d.emit('turn_end', { message, messageEntryId: id });
  expect(seedContextWindow(manager.getBranch(), identity)).toBe(learned);
  expect(replyFit(manager.getBranch()).failed).toBe(learned === undefined);
  expect(seedContextWindow(manager.getBranch(), 'another model')).toBeUndefined();
 } finally { await d.close(); }
});

test('a server-clipped reply retries once inside the learned window while preserving the task', async () => {
 let largeReply = false;
 const h = await harness({ at: 'prompt', complete: 0, noHistory: true, noOpening: true, persist: true, stableHost: true,
  limits: { contextWindow: 81_920, maxTokens: 16_384 }, providerWindow: 68_000, piRequestPath: true,
  host: 200, systemTokens: 800, reserveTokens: 16_384, keepRecent: 20_000, usageRatio: 1,
  replyWindow: 'clip', replyWindowOutput: () => largeReply ? 16_384 : 48, cutAtDefault: true, compaction: { requestReserve: undefined } });
 try {
  for (let i = 0; i < 6; i++) await h.session.prompt(h.sized(1_500));
  const before = h.state.requests;
  const task = h.sized(48_000);
  largeReply = true;
  await h.session.prompt(task);
  expect(h.state.requests - before).toBe(2);
  expect(h.state.stops.slice(before)).toEqual(['length', 'stop']);
  expect(h.providerRequests.filter(r => r.length).every(r => r.prompt + r.output === 68_000)).toBe(true);
  expect(seedContextWindow(h.manager.getBranch(), identity)).toBe(68_000);
  expect(JSON.stringify(h.saved())).toContain(task.slice(0, 80));
  expect(h.faults).toEqual([]);
 } finally { await h.cleanup(); }
});

test('a fresh real Pi session reads the saved window before its first request, without another clipped reply', async () => {
 const options: Options = { at: 'prompt', complete: 0, noHistory: true, noOpening: true, persist: true, stableHost: true,
  limits: { contextWindow: 81_920, maxTokens: 16_384 }, providerWindow: 68_000, piRequestPath: true,
  host: 200, systemTokens: 800, reserveTokens: 16_384, keepRecent: 20_000, usageRatio: 1,
  replyWindow: 'clip', replyWindowOutput: () => 16_384, cutAtDefault: true, compaction: { requestReserve: undefined } };
 const first = await harness(options);
 let branch: SessionEntry[];
 try {
  await first.session.prompt(first.sized(52_000));
  const clipped = first.providerRequests.find(r => !r.summary && r.length);
  expect(clipped).toBeDefined();
  expect(clipped!.output).toBeLessThan(clipped!.maxTokens);
  expect(clipped!.prompt + clipped!.output).toBe(68_000);
  const file = first.manager.getSessionFile()!;
  branch = SessionManager.open(file, first.dir).getBranch();
  expect(seedContextWindow(branch, identity)).toBe(68_000);
  expect(replyFit(branch).failed).toBe(false);
 } finally { await first.cleanup(); }
 const rooms: number[] = [];
 const second = await harness({ ...options, persist: false, branch, replyWindowOutput: () => 48,
  compaction: { requestReserve: undefined, observeBudget: budget => rooms.push(budget.room) } });
 try {
  const receipts = branch.filter(e => e.type === 'custom' && e.customType === WINDOW_RECEIPT).length;
  await second.session.prompt(second.sized(2_000));
  expect(rooms.length).toBeGreaterThan(0);
  expect(rooms[0]).toBe(68_000 - 16_384);
  expect(rooms.every(room => room === rooms[0])).toBe(true);
  expect(second.state.requests).toBeGreaterThan(0);
  expect(second.providerRequests[0]!.prompt + second.providerRequests[0]!.maxTokens).toBeLessThanOrEqual(68_000);
  expect(second.providerRequests.every(r => !r.refused && !r.length)).toBe(true);
  expect(second.manager.getBranch().filter(e => e.type === 'custom' && e.customType === WINDOW_RECEIPT).length).toBe(receipts);
  expect(second.session.messages.findLast(m => m.role === 'assistant')).toMatchObject({ stopReason: 'stop' });
 } finally { await second.cleanup(); }
});
