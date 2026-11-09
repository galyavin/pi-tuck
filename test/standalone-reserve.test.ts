import { expect, test, vi } from 'vitest';
import { SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage } from '@earendil-works/pi-ai';
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
 expect(await offer(manager, window - response - 1, maxTokens)).toEqual([]);
 expect((await offer(manager, window - response, maxTokens)).join(' ')).toContain(CAPACITY);
}

test('standalone starts at Pi reserveTokens even when the catalogue maximum is larger', async () => {
 await edge(fresh(), reserve);
 // A Pi setting larger than the cap remains the reserve.
 const larger = SettingsManager.inMemory({ compaction: { reserveTokens: 40_000 } });
 for (const [tokens, refused] of [[41_919, false], [41_920, true]] as const) {
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
 await edge(manager, reserve);
});

// A transient failure is not a reply that did not fit: pi-ai does not class it as a context overflow, so the branch keeps native's room.
test.each([
 ['an error with no message', reply('error')],
 ['a 503', reply('error', '503 upstream unavailable')],
] as const)('%s on the branch keeps Pi reserveTokens', async (_label, message) => {
 const manager = fresh(); manager.appendMessage(message);
 await edge(manager, reserve);
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
  for (const [leaf, held] of [[before, reserve], [after, cap]] as const) {
   const source = SessionManager.open(manager.getSessionFile()!, dir);
   const path = source.createBranchedSession(leaf)!;
   await edge(SessionManager.open(path, dir), held);
  }
 } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('recorded shape: cap equals reserve, so standalone limits equal the 1.0.19 floor before and after a failure', async () => {
 for (const stop of [undefined, 'length', 'error'] as const) {
  const manager = fresh(); if (stop) manager.appendMessage(reply(stop, OVERFLOW_TEXT));
  await edge(manager, reserve, reserve);
  for (const tokens of [49_152, 65_535, 65_536, 65_537]) {
   // The unchanged host floor is exactly 1.0.19's max(reserveTokens, model.maxTokens) arithmetic.
   expect(await offer(manager, tokens, reserve)).toEqual(await offer(manager, tokens, reserve, () => ({ response: reserve })));
  }
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
