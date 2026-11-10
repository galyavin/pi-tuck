import { expect, test, vi } from 'vitest';
import { normalizeContext } from '@earendil-works/pi-ai';
import { clampMaxTokensToContext } from '@earendil-works/pi-ai/api/simple-options';
import { estimateContextTokens } from '@earendil-works/pi-ai/utils/estimate';
import { piContextSafetyMargin, requestReplyFloor } from '../src/request-capacity';
import { harness } from './budget-fixture';
import { drive, MODEL } from './calibration-fixture';
import { providerRequest } from './request-options';
import { convertToLlm, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';

test('the safety margin comes from the installed Pi clamp', async () => {
 const window = 1_000_000, context = normalizeContext({ messages: [] });
 const margin = window - estimateContextTokens(context).tokens - clampMaxTokensToContext({ ...MODEL, contextWindow: window, maxTokens: window }, context, window);
 expect(await piContextSafetyMargin()).toBe(margin);
 expect(margin).toBeGreaterThan(0);
});

test('an unavailable Pi clamp import uses the stated 4096-token fallback', async () => {
 vi.doMock('@earendil-works/pi-ai/api/simple-options', () => { throw new Error('Unavailable subpath'); });
 try { expect(await piContextSafetyMargin()).toBe(4_096); }
 finally { vi.doUnmock('@earendil-works/pi-ai/api/simple-options'); }
});

test('a changed Pi safety margin is read rather than replaced with the fallback', async () => {
 vi.doMock('@earendil-works/pi-ai/api/simple-options', () => ({
  clampMaxTokensToContext: (model: { contextWindow: number }) => model.contextWindow - 7_777,
 }));
 try { expect(await piContextSafetyMargin()).toBe(7_777); }
 finally { vi.doUnmock('@earendil-works/pi-ai/api/simple-options'); }
});

test.each([{ reserve: 4_096, output: 0 }, { reserve: 16_384, output: 16_384 }])(
 'the hard line stays at the room when margin plus floor exceeds reserve ($reserve, output $output)', async ({ reserve, output }) => {
 const manager = SessionManager.inMemory('/x');
 if (output) manager.appendMessage({ role: 'assistant', content: [], stopReason: 'stop', api: MODEL.api, provider: MODEL.provider,
  model: MODEL.id, timestamp: 0, usage: { input: 0, output, cacheRead: 0, cacheWrite: 0, totalTokens: output,
   cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
 const measures: { room: number; hardLine?: number }[] = [];
 const d = await drive(manager, { requestReserve: undefined,
  settings: SettingsManager.inMemory({ compaction: { reserveTokens: reserve } }), observeBudget: measure => measures.push(measure) });
 try {
  d.ctx.model = { ...MODEL, contextWindow: 32_768, maxTokens: 16_384 };
  const room = 32_768 - reserve;
  await d.offer(room - 1);
  expect(d.errors).toEqual([]);
  expect(measures.at(-1)).toMatchObject({ room, hardLine: room });
  await d.offer(room);
  expect(d.errors.map(String).join(' ')).toContain('estimated request budget');
 } finally { await d.close(); vi.restoreAllMocks(); }
});

test.each([23_000, 27_742])('a request at %s whose real clamp cannot hold the floor is never sent', async setup => {
 const h = await harness({ at: 'prompt', complete: 0, noHistory: true, noOpening: true, systemTokens: setup - 252, host: 200,
  limits: { contextWindow: 32_768, maxTokens: 16_384 }, reserveTokens: 16_384,
  compaction: { requestReserve: undefined }, piRequestPath: true });
 try {
  const prompt = h.sized(200);
  const context = normalizeContext({ systemPrompt: h.session.systemPrompt, messages: convertToLlm([{ role: 'user', content: prompt, timestamp: 0 }, h.hostInput()]) });
  const model = { ...MODEL, contextWindow: 32_768, maxTokens: 16_384 };
  expect(clampMaxTokensToContext(model, context, model.maxTokens)).toBeLessThan(3_584);
  await h.session.prompt(prompt);
  expect(h.state.requests).toBe(0);
  expect(h.state.clampStops).toBe(0);
  expect(h.faults.join(' ')).toMatch(/estimated request budget|request clamp/);
  expect(h.manager.getBranch().find(e => e.type === 'custom' && e.customType === 'pi-tuck-capacity')).toMatchObject({ data: { kind: 'refusal', hardLine: 25_088 } });
 } finally { await h.cleanup(); }
});

test('real payload builders apply the Responses minimum and the Completions cap', async () => {
 const model = { ...MODEL, contextWindow: 32_768, maxTokens: 16_384 };
 const context = normalizeContext({ messages: [{ role: 'user', content: 'x'.repeat(120_000), timestamp: 0 }] });
 expect((await providerRequest(model, context)).maxTokens).toBe(16);
 expect((await providerRequest({ ...model, api: 'openai-completions' }, context)).maxTokens).toBe(1);
});

test('a request above the room is sent when Pi leaves the model’s 1879-token reply cap', async () => {
 const h = await harness({ at: 'prompt', complete: 0, noHistory: true, noOpening: true, systemTokens: 21_748, host: 200,
  limits: { contextWindow: 32_768, maxTokens: 1_879 }, reserveTokens: 16_384,
  compaction: { requestReserve: undefined }, piRequestPath: true });
 try {
  await h.session.prompt(h.sized(200));
  expect(h.guard[0]).toBeGreaterThan(16_384);
  expect(h.state.requests).toBe(1);
  expect(h.state.requestOptions[0]?.baseMaxTokens).toBe(1_879);
  expect(h.state.requestOptions[0]?.maxTokens).toBe(1_879);
  expect(h.state.stops.at(-1)).toBe('stop');
  expect(h.faults).toEqual([]);
  expect(h.manager.getBranch().find(e => e.type === 'custom' && e.customType === 'pi-tuck-capacity')).toMatchObject({
   data: { kind: 'above-room', room: 16_384, hardLine: 26_793 },
  });
 } finally { await h.cleanup(); }
});

test('only a positive model cap limits the branch floor, including its failed-reply fallback', () => {
 const manager = SessionManager.inMemory('/x');
 expect(requestReplyFloor(manager.getBranch(), 16_384, 1_879)).toBe(1_879);
 for (const cap of [undefined, 0, -1]) expect(requestReplyFloor(manager.getBranch(), 16_384, cap)).toBe(3_584);
 manager.appendMessage({ role: 'assistant', content: [], stopReason: 'length', api: MODEL.api, provider: MODEL.provider,
  model: MODEL.id, timestamp: 0, usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1,
   cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
 expect(requestReplyFloor(manager.getBranch(), 16_384, 1_879)).toBe(1_879);
 expect(requestReplyFloor(manager.getBranch(), 16_384, 0)).toBe(16_384);
});
