import { expect, test } from 'vitest';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { requestReplyFloor, thinkingOnlyLength } from '../src/request-capacity';
import { ACT_NOW, capStopNotice } from '../src/compaction';
import { statusText } from '../src/status';
import { MODEL } from './calibration-fixture';
import { harness } from './budget-fixture';
import { expectThinkingLengthOutcome, thinkingLengthCell, thinkingLengthCells } from './length-retry-fixture';

test.each(thinkingLengthCells)('thinking-only length recovery: $name', async cell => {
 expectThinkingLengthOutcome(cell, await thinkingLengthCell(cell));
});

test('a full-cap thinking stop leaves room for a fresh prompt and a later long tool turn', async () => {
 const h = await harness({ at: 'prompt', complete: 0, noHistory: true, noOpening: true, host: 200, systemTokens: 800,
  limits: { contextWindow: 65_536, maxTokens: 32_768 }, reserveTokens: 16_384, piRequestPath: true,
  compaction: { requestReserve: undefined }, thinkingOnlyLength: n => n === 1, toolCalls: n => n === 4,
  replyTokens: () => 20_000 });
 try {
  await h.session.prompt('Initial task');
  // 1.10.0: the stall gets one act-now turn in the same run, and that request gets the raised reply room.
  expect(h.state.answers.map(a => a.stopReason)).toEqual(['length', 'stop']);
  expect(h.state.answers[0]!.usage.output).toBe(32_768);
  expect(h.state.requestOptions[1]!.maxTokens).toBe(32_768);
  expect(requestReplyFloor(h.manager.getBranch(), 16_384, h.session.model!)).toBe(16_384);
  await h.session.prompt('Fresh task');
  await h.session.prompt('Task with a long tool turn');
  expect(h.state.answers.map(a => a.stopReason)).toEqual(['length', 'stop', 'stop', 'toolUse', 'stop']);
  expect(h.state.effects).toBe(1);
  expect(h.state.requestOptions[3]!.maxTokens).toBeGreaterThan(20_000);
  expect(h.notices).toEqual([]);
  expect(h.faults).toEqual([]);
 } finally { await h.cleanup(); }
});

test.each(['text', 'toolCall'] as const)('a length stop with %s does not trigger pi-tuck recovery', async kind => {
 const h = await harness({ at: 'prompt', complete: 0, noHistory: true, noOpening: true, host: 200, systemTokens: 800,
  limits: { contextWindow: 32_768, maxTokens: 2_048 }, reserveTokens: 16_384, piRequestPath: true,
  compaction: { requestReserve: undefined }, outputTokens: 2_048, toolCalls: n => kind === 'toolCall' && n === 1 });
 try {
  // Exhaust the catalogue cap so Pi itself does not classify this as a recoverable short output.
  h.extension().on('message_end', event => { if (event.message.role === 'assistant') event.message.stopReason = 'length'; });
  await h.session.prompt('Do the task');
  // Pi supplies a failed receipt for a truncated tool call, then continues its ordinary tool loop.
  expect(h.state.requests).toBe(kind === 'toolCall' ? 2 : 1);
  expect(h.manager.getBranch().filter(entry => entry.type === 'custom' && entry.customType === 'pi-tuck-capacity' &&
   (entry.data as { kind?: string })?.kind === 'retry')).toEqual([]);
 } finally { await h.cleanup(); }
});

test('a thinking-only retry keeps the whole prompt and fresh tool pairing, clipping only the request copy', async () => {
 const wire: any[] = [];
 const h = await harness({ at: 'prompt', complete: 21_500, systemTokens: 16_648, host: 200, history: 4_000, incoming: 17_500,
  limits: { contextWindow: 32_768, maxTokens: 16_384 }, reserveTokens: 16_384, keepRecent: 20_000,
  piRequestPath: true, compaction: { requestReserve: undefined }, toolCalls: n => n === 1, toolResultTokens: () => 6_000,
  thinkingOnlyLength: n => n === 2, onWire: context => wire.push(structuredClone(context)) });
 try {
  const r = await h.run();
  expect(h.state.requests, r.probe).toBe(3);
  expect(r.faults, r.probe).toEqual([]);
  expect(r.wholePrompt).toEqual([true, true, true]);
  const fresh = wire[2].messages.find((message: any) => message.role === 'toolResult');
  expect(JSON.stringify(fresh)).toContain('tuck_recall');
  const stored = h.manager.getBranch().findLast(entry => entry.type === 'message' && entry.message.role === 'toolResult');
  expect(stored?.type === 'message' && JSON.stringify(stored.message)).not.toContain('characters');
  expect(h.state.requestOptions[2]!.baseMaxTokens).toBeGreaterThan(h.state.requestOptions[1]!.baseMaxTokens);
 } finally { await h.cleanup(); }
});

test('thinking-only exhaustion keeps Pi reserveTokens when the catalogue cap is larger', async () => {
 const reserves: number[] = [];
 const h = await harness({ at: 'prompt', complete: 21_500, systemTokens: 16_648, host: 200, history: 4_000, incoming: 17_500,
  limits: { contextWindow: 32_768, maxTokens: 32_768 }, reserveTokens: 16_384,
  piRequestPath: true, thinkingOnlyLength: n => n === 1,
  compaction: { requestReserve: undefined, observeBudget: measure => reserves.push(measure.response) } });
 try {
  await h.run();
  expect(h.state.requests).toBe(2);
  expect(h.faults).toEqual([]);
  expect(new Set(reserves)).toEqual(new Set([16_384]));
 } finally { await h.cleanup(); }
});

test('a retry whose deepest request cannot leave the floor refuses with the existing receipt and notice', async () => {
 const h = await harness({ at: 'prompt', complete: 21_500, systemTokens: 16_648, host: 200, history: 4_000, incoming: 17_500,
  limits: { contextWindow: 32_768, maxTokens: 16_384 }, reserveTokens: 16_384,
  piRequestPath: true, thinkingOnlyLength: n => n === 1, compaction: { requestReserve: undefined },
  onRequest: (_request, { setHost }) => { setHost(20_000); } });
 try {
  await h.run();
  expect(h.state.requests).toBe(1);
  expect(h.faults.join(' ')).toContain("Pi's request clamp leaves less than the reply floor");
  expect(h.notices.join(' ')).toContain('shorten the input');
  expect(h.manager.getBranch().filter(entry => entry.type === 'custom' && entry.customType === 'pi-tuck-capacity' &&
   (entry.data as { kind?: string })?.kind === 'refusal')).toHaveLength(1);
 } finally { await h.cleanup(); }
});

test('the ordinary floor includes stopped reasoning within the reserve and model limit', () => {
 const manager = SessionManager.inMemory('/x');
 const message = { role: 'assistant' as const, content: [{ type: 'thinking' as const, thinking: 'unfinished reasoning' }],
  api: MODEL.api, model: MODEL.id, provider: MODEL.provider, stopReason: 'length' as const, timestamp: 1,
  usage: { input: 100, output: 7_650, cacheRead: 0, cacheWrite: 0, totalTokens: 7_750, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
 const id = manager.appendMessage(message);
 manager.appendCompaction('kept summary', '', 1);
 expect(thinkingOnlyLength(message)).toBe(true);
 expect(requestReplyFloor(manager.getBranch(), 16_384, { ...MODEL, maxTokens: 16_384 })).toBe(7_650);
 expect(requestReplyFloor(manager.getBranch(), 2_048, { ...MODEL, maxTokens: 16_384 })).toBe(2_048);
 expect(requestReplyFloor(manager.getBranch(), 16_384, { ...MODEL, maxTokens: 4_096 })).toBe(4_096);
 for (const content of [[], [{ type: 'text' as const, text: 'partial answer' }], [{ type: 'toolCall' as const, id: 'call', name: 'effect', arguments: {} }]]) {
  expect(thinkingOnlyLength({ ...message, content })).toBe(false);
  manager.branch(id);
  manager.appendMessage({ ...message, content });
  expect(requestReplyFloor(manager.getBranch(), 16_384, { ...MODEL, maxTokens: 16_384 })).toBe(7_650);
 }
 manager.branch(id);
 manager.appendMessage({ ...message, stopReason: 'error', errorMessage: 'Your input exceeds the context window of this model.' });
 expect(requestReplyFloor(manager.getBranch(), 16_384, { ...MODEL, maxTokens: 16_384 })).toBe(7_650);
});

test('/tuck counts retry receipts on the current branch', () => {
 expect(statusText({ version: 'test', active: true, branch: [
  { type: 'custom', customType: 'pi-tuck-capacity', data: { kind: 'retry' } },
  { type: 'custom', customType: 'pi-tuck-capacity', data: { kind: 'above-room' } },
 ], cutAt: undefined })).toContain('Capacity retries on this branch: 1.');
});

// After-cap act-now: a thinking-only stall that is not retried gets one follow-up turn; at most two in a row, then the cap-stop notice,
// until a reply is not a stall. The stalled reply stays saved but leaves the request context.
test('act-now: two in a row at most, then the notice; a reply that is not a stall re-arms it', async () => {
 const wire: { messages: { role: string; stopReason?: string; content: unknown }[] }[] = [];
 const h = await harness({ at: 'prompt', complete: 0, noHistory: true, noOpening: true, host: 200, systemTokens: 800,
  limits: { contextWindow: 65_536, maxTokens: 32_768 }, reserveTokens: 16_384, piRequestPath: true,
  compaction: { requestReserve: undefined }, thinkingOnlyLength: n => [1, 2, 3, 5].includes(n), replyTokens: () => 2_000,
  onWire: context => wire.push(structuredClone(context as never)) });
 try {
  await h.session.prompt('Initial task');
  expect(h.state.answers.map(a => a.stopReason)).toEqual(['length', 'length', 'length']);
  expect(h.notices).toEqual([capStopNotice('openai-codex/gpt-6.1-sol', 32_768, '~/.pi/agent/models.json')]);
  const text = (m: { content: unknown }) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
  for (const request of wire.slice(1, 3)) {
   expect(text(request.messages.at(-1)!)).toContain(ACT_NOW);
   expect(request.messages.some(m => m.role === 'assistant' && m.stopReason === 'length')).toBe(false);
  }
  // The stalled replies stay in the session.
  expect(h.manager.getBranch().filter(e => e.type === 'message' && e.message.role === 'assistant' && e.message.stopReason === 'length')).toHaveLength(3);
  await h.session.prompt('Fresh task');
  expect(h.state.answers.at(-1)!.stopReason).toBe('stop');
  await h.session.prompt('Another task');
  expect(h.state.answers.slice(4).map(a => a.stopReason)).toEqual(['length', 'stop']);
  expect(text(wire[5]!.messages.at(-1)!)).toContain(ACT_NOW);
  expect(h.notices).toHaveLength(1);
  expect(h.faults).toEqual([]);
 } finally { await h.cleanup(); }
});
