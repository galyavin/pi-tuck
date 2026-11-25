import { expect, test } from 'vitest';
import { SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { normalizeContext } from '@earendil-works/pi-ai';
import { clampMaxTokensToContext } from '@earendil-works/pi-ai/api/simple-options';
import { estimateContextTokens } from '@earendil-works/pi-ai/utils/estimate';
import { piContextSafetyMargin } from '../src/request-capacity';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CompactionOptions } from '../src/compaction';
import { CAPACITY, MODEL, guarded } from './calibration-fixture';
import { OVERFLOW_TEXT, receiptOf, scenario } from './budget-fixture';

const window = 81_920, reserve = 16_384, cap = 32_768;
const settings = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: reserve, keepRecentTokens: 0 } });
const options = { settings, requestReserve: undefined };
const fresh = () => SessionManager.inMemory('/x');
const reply = (stopReason: AssistantMessage['stopReason'], errorMessage?: string, output = 0): AssistantMessage => ({
 role: 'assistant', content: [], stopReason, ...(errorMessage === undefined ? {} : { errorMessage }),
 api: MODEL.api, provider: MODEL.provider, model: MODEL.id, timestamp: 1,
 usage: { input: 0, output, cacheRead: 0, cacheWrite: 0, totalTokens: output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
const offer = (manager: SessionManager, tokens: number, maxTokens = cap, host?: CompactionOptions['requestReserve']) =>
 guarded(manager, tokens, async d => { d.ctx.model = { ...MODEL, contextWindow: window, maxTokens }; }, { ...options, requestReserve: host });
async function edge(manager: SessionManager, response: number, maxTokens = cap) {
 const room = window - reserve, model = { ...MODEL, contextWindow: window, maxTokens };
 const margin = await piContextSafetyMargin();
 const hardLine = Math.max(room, window - margin - response);
 let low = 1, high = hardLine;
 while (high - low > 1) {
  const tokens = Math.floor((low + high) / 2);
  const context = normalizeContext({ messages: [{ role: 'user', content: 'x'.repeat(4 * (tokens - 2)), timestamp: 0 }] });
  const clamped = clampMaxTokensToContext(model, context, maxTokens);
  if (tokens <= room || (clamped >= response && estimateContextTokens(context).tokens + margin + clamped <= window)) low = tokens;
  else high = tokens;
 }
 expect(await offer(manager, low, maxTokens)).toEqual([]);
 expect((await offer(manager, high, maxTokens)).join(' ')).toMatch(/estimated request budget|request clamp/);
 expect((await offer(manager, hardLine, maxTokens)).join(' ')).toContain(CAPACITY);
}

test('a fresh session admits an above-reserve request that leaves usable generation room', async () => {
 await edge(fresh(), 1);
});

test.each([reply('length'), reply('error', OVERFLOW_TEXT), reply('error', '503 upstream unavailable')])(
 'a zero-output $stopReason does not raise the standalone reserve to the catalogue cap', async message => {
  const manager = fresh();
  manager.appendMessage(message);
  await edge(manager, 1);
 });

test('host responseExact stays exact after a length or error stop; a host without it keeps the catalogue floor', async () => {
 for (const stop of ['length', 'error'] as const) {
  const manager = fresh(); manager.appendMessage(reply(stop, OVERFLOW_TEXT));
  expect(await offer(manager, 65_535, cap, () => ({ response: reserve, responseExact: true }))).toEqual([]);
  expect((await offer(manager, 65_536, cap, () => ({ response: reserve, responseExact: true }))).join(' ')).toContain(CAPACITY);
  expect((await offer(manager, 49_152, cap, () => ({ response: reserve }))).join(' ')).toContain(CAPACITY);
 }
});

test('a persisted resume and /fork inherit only observed output on the retained branch', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'tuck-reserve-fork-'));
 try {
  const manager = SessionManager.create(dir, dir);
  const before = manager.appendMessage({ role: 'user', content: 'Task', timestamp: 0 });
  manager.appendMessage(reply('stop', undefined, 3_584));
  const after = manager.appendMessage({ role: 'user', content: 'Continue', timestamp: 2 });
  await edge(SessionManager.open(manager.getSessionFile()!, dir), 3_584);
  for (const [leaf, held] of [[before, 1], [after, 3_584]] as const) {
   const source = SessionManager.open(manager.getSessionFile()!, dir);
   const path = source.createBranchedSession(leaf)!;
   await edge(SessionManager.open(path, dir), held);
  }
 } finally { rmSync(dir, { recursive: true, force: true }); }
});

test.each(['prompt', 'tool'] as const)('recorded shape at the %s boundary keeps the same cut limits as 1.0.19', async at => {
 const common = { at, complete: 65_535, host: 200, reserveTokens: reserve, limits: { contextWindow: window, maxTokens: reserve }, ...(at === 'tool' ? { fresh: 30_000 } : {}) };
 const standalone = await scenario({ ...common, compaction: { requestReserve: undefined } });
 const oldFloor = await scenario(common);
 expect(standalone.faults, standalone.probe).toEqual([]);
 expect(standalone.guard).toEqual(oldFloor.guard);
 expect(standalone.cuts).toBe(oldFloor.cuts);
 expect(standalone.entries.map(e => receiptOf(e).responseReserveTokens)).toEqual(oldFloor.entries.map(e => receiptOf(e).responseReserveTokens));
});
