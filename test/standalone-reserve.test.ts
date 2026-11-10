import { expect, test, vi } from 'vitest';
import { SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { normalizeContext } from '@earendil-works/pi-ai';
import { clampMaxTokensToContext } from '@earendil-works/pi-ai/api/simple-options';
import { piContextSafetyMargin } from '../src/request-capacity';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CompactionOptions } from '../src/compaction';
import { CAPACITY, MODEL, SUMMARY, drive, guarded } from './calibration-fixture';
import { OVERFLOW_TEXT, receiptOf, scenario } from './budget-fixture';

const window = 81_920, reserve = 16_384, cap = 32_768;
const settings = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: reserve, keepRecentTokens: 0 } });
const options = { settings, requestReserve: undefined };
const fresh = () => SessionManager.inMemory('/x');
const reply = (stopReason: AssistantMessage['stopReason'], errorMessage?: string): AssistantMessage => ({
 role: 'assistant', content: [], stopReason, ...(errorMessage === undefined ? {} : { errorMessage }),
 api: MODEL.api, provider: MODEL.provider, model: MODEL.id, timestamp: 1,
 usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
const offer = (manager: SessionManager, tokens: number, maxTokens = cap, host?: CompactionOptions['requestReserve']) =>
 guarded(manager, tokens, async d => { d.ctx.model = { ...MODEL, contextWindow: window, maxTokens }; }, { ...options, requestReserve: host });
async function edge(manager: SessionManager, response: number, maxTokens = cap) {
 const room = window - Math.max(reserve, response), model = { ...MODEL, contextWindow: window, maxTokens };
 const hardLine = Math.max(room, window - await piContextSafetyMargin() - response);
 let low = 1, high = hardLine;
 while (high - low > 1) {
  const tokens = Math.floor((low + high) / 2);
  const context = normalizeContext({ messages: [{ role: 'user', content: 'x'.repeat(4 * (tokens - 2)), timestamp: 0 }] });
  if (tokens <= room || clampMaxTokensToContext(model, context, maxTokens) >= response) low = tokens; else high = tokens;
 }
 expect(await offer(manager, low, maxTokens)).toEqual([]);
 expect((await offer(manager, high, maxTokens)).join(' ')).toMatch(/estimated request budget|request clamp/);
 expect((await offer(manager, hardLine, maxTokens)).join(' ')).toContain(CAPACITY);
}

test('standalone starts with a 4096-token reply floor even when the reserve and catalogue maximum are larger', async () => {
 await edge(fresh(), 4_096);
 // A Pi setting larger than the cap remains the reserve.
 const larger = SettingsManager.inMemory({ compaction: { reserveTokens: 40_000 } });
 for (const [tokens, refused] of [[60_000, false], [73_728, true]] as const) {
  const errors = await guarded(fresh(), tokens, async d => { d.ctx.model = { ...MODEL, contextWindow: window, maxTokens: cap }; }, { ...options, settings: larger });
  expect(errors.join(' ').includes(CAPACITY)).toBe(refused);
 }
});

test.each([
 ['length', reply('length')],
 ['readable context overflow', reply('error', OVERFLOW_TEXT)],
] as const)('%s on the branch raises the reserve, including after resume and compaction', async (_label, message) => {
 const manager = fresh();
 manager.appendMessage({ role: 'user', content: 'Task', timestamp: 0 });
 manager.appendMessage(message);
 const kept = manager.appendMessage({ role: 'user', content: 'Continue', timestamp: 2 });
 manager.appendCompaction(SUMMARY, kept, 1000);
 // guarded emits session_start (resume); the failure precedes the latest cut and is outside its kept tail.
 await edge(manager, Math.max(reserve, cap));
});

test.each(['stop', 'toolUse', 'aborted'] as const)('%s does not raise the reserve', async stop => {
 const manager = fresh(); manager.appendMessage(reply(stop));
 await edge(manager, 4_096);
});

// A transient failure is not a reply that did not fit: pi-ai does not class it as a context overflow, so the branch keeps native's room.
test.each([
 ['an error with no message', reply('error')],
 ['a 503', reply('error', '503 upstream unavailable')],
] as const)('%s on the branch keeps Pi reserveTokens', async (_label, message) => {
 const manager = fresh(); manager.appendMessage(message);
 await edge(manager, 4_096);
});

test('each decision follows /tree and a new session without an in-memory fallback flag', async () => {
 const manager = fresh(), first = manager.appendMessage({ role: 'user', content: 'Task', timestamp: 0 });
 const d = await drive(manager, options);
 try {
  d.ctx.model = { ...MODEL, contextWindow: window, maxTokens: cap };
  await d.offer(60_000); expect(d.errors).toEqual([]);
  const failed = manager.appendMessage(reply('length'));
  await d.offer(49_151); expect(d.errors).toEqual([]);
  await d.offer(60_000); expect(d.errors.map(String).join(' ')).toContain(CAPACITY);
  manager.branch(first); await d.start();
  d.errors.length = 0; await d.offer(60_000); expect(d.errors).toEqual([]);
  manager.branch(failed); await d.start();
  await d.offer(60_000); expect(d.errors.map(String).join(' ')).toContain(CAPACITY);
  d.ctx.sessionManager = fresh(); await d.start();
  d.errors.length = 0; await d.offer(60_000); expect(d.errors).toEqual([]);
 } finally { await d.close(); vi.restoreAllMocks(); }
});

test('host responseExact stays exact after a length or error stop; a host without it keeps the catalogue floor', async () => {
 for (const stop of ['length', 'error'] as const) {
  const manager = fresh(); manager.appendMessage(reply(stop, OVERFLOW_TEXT));
  expect(await offer(manager, 65_535, cap, () => ({ response: reserve, responseExact: true }))).toEqual([]);
  expect((await offer(manager, 65_536, cap, () => ({ response: reserve, responseExact: true }))).join(' ')).toContain(CAPACITY);
  expect((await offer(manager, 49_152, cap, () => ({ response: reserve }))).join(' ')).toContain(CAPACITY);
 }
});

test('a persisted resume and /fork inherit only failures on the retained branch', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'tuck-reserve-fork-'));
 try {
  const manager = SessionManager.create(dir, dir);
  const before = manager.appendMessage({ role: 'user', content: 'Task', timestamp: 0 });
  manager.appendMessage(reply('length'));
  const after = manager.appendMessage({ role: 'user', content: 'Continue', timestamp: 2 });
  await edge(SessionManager.open(manager.getSessionFile()!, dir), cap);
  for (const [leaf, held] of [[before, 4_096], [after, cap]] as const) {
   const source = SessionManager.open(manager.getSessionFile()!, dir);
   const path = source.createBranchedSession(leaf)!;
   await edge(SessionManager.open(path, dir), held);
  }
 } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('after a failure the full reserve remains mandatory even when cap equals reserve', async () => {
 for (const stop of ['length', 'error'] as const) {
  const manager = fresh(); manager.appendMessage(reply(stop, OVERFLOW_TEXT));
  await edge(manager, reserve, reserve);
 }
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
