import { expect, test } from 'vitest';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { branchReplyFloor, needsFullReplyReserve, requestReplyFloor, thinkingOnlyLength } from '../src/request-capacity';
import { statusText } from '../src/status';
import { MODEL } from './calibration-fixture';
import { harness } from './budget-fixture';
import { thinkingLengthCell, thinkingLengthCells } from './length-retry-fixture';

test.each(thinkingLengthCells)('thinking-only length recovery: $name', async cell => {
 const r = await thinkingLengthCell(cell);
 expect(r.requests).toBe(2);
 expect(r.retries).toBe(1);
 expect(r.stops).toEqual(['length', cell.twice ? 'length' : 'stop']);
 expect(r.omitted).toBe(true);
 expect(r.preserved).toBe(true);
 expect(r.wholePrompt).toBe(true);
 // Below the room Pi's cap is already the model's whole reply cap, so the retry gives up no history; above it the deepest cut buys room.
 expect(r.noOptionalHistory).toBe(cell.above);
 expect(r.deepest).toBe(cell.above);
 expect(r.caps[1]).toBeGreaterThanOrEqual(r.outputs[0]!);
 if (cell.above) expect(r.caps[1]).toBeGreaterThan(r.caps[0]!);
 expect(r.replyFloor).toBe(Math.max(3_584, ...r.outputs));
 expect(r.receipt).toMatchObject({ kind: 'retry', stoppedOutputTokens: r.outputs[0], piEstimateTokens: r.contextTokens[1], piCap: r.caps[1] });
 expect(r.faults).toEqual([]);
 expect(r.notices).toEqual([]);
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

test('the thinking-only floor includes stopped output across cuts, while other failures keep the full reserve', () => {
 const manager = SessionManager.inMemory('/x');
 const message = { role: 'assistant' as const, content: [{ type: 'thinking' as const, thinking: 'unfinished reasoning' }],
  api: MODEL.api, model: MODEL.id, provider: MODEL.provider, stopReason: 'length' as const, timestamp: 1,
  usage: { input: 100, output: 7_650, cacheRead: 0, cacheWrite: 0, totalTokens: 7_750, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
 const id = manager.appendMessage(message);
 manager.appendCompaction('kept summary', '', 1);
 expect(thinkingOnlyLength(message)).toBe(true);
 expect(needsFullReplyReserve(message)).toBe(false);
 expect(branchReplyFloor(manager.getBranch(), 16_384)).toBe(7_650);
 expect(branchReplyFloor(manager.getBranch(), 2_048)).toBe(7_650);
 expect(requestReplyFloor(manager.getBranch(), 16_384, 4_096)).toBe(4_096);
 for (const content of [[], [{ type: 'text' as const, text: 'partial answer' }], [{ type: 'toolCall' as const, id: 'call', name: 'effect', arguments: {} }]]) {
  expect(thinkingOnlyLength({ ...message, content })).toBe(false);
  manager.branch(id);
  manager.appendMessage({ ...message, content });
  expect(branchReplyFloor(manager.getBranch(), 16_384)).toBe(16_384);
 }
 manager.branch(id);
 manager.appendMessage({ ...message, stopReason: 'error', errorMessage: 'Your input exceeds the context window of this model.' });
 expect(branchReplyFloor(manager.getBranch(), 16_384)).toBe(16_384);
});

test('/tuck counts retry receipts on the current branch', () => {
 expect(statusText({ version: 'test', active: true, branch: [
  { type: 'custom', customType: 'pi-tuck-capacity', data: { kind: 'retry' } },
  { type: 'custom', customType: 'pi-tuck-capacity', data: { kind: 'above-room' } },
 ], cutAt: undefined, search: false, semantic: { state: 'disabled', lastError: null } })).toContain('Retries: 1 after thinking-only length stops in this session.');
});
