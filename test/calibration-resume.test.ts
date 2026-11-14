import { expect, test } from 'vitest';
import { CALIBRATION_WINDOW, seedWindow } from '../src/compaction';
import { drive, KEY, MODEL, reporting, sessionWith, stampWindow, SUMMARY } from './calibration-fixture';

const TYPE = 'pi-tuck-calibration';
const entries = (manager: ReturnType<typeof sessionWith>['manager']) => manager.getBranch().filter(e => e.type === 'custom' && e.customType === TYPE);

test('D7: a paired reply before any cut saves only the identity and rolling window, and a cold instance restores it', async () => {
 const { manager } = sessionWith([]), d = await drive(manager);
 try {
  await d.start(); await d.offer(10000); await d.reply(reporting(12500));
  expect(entries(manager).map(e => e.type === 'custom' && e.data)).toEqual([{ calibrationIdentity: KEY, calibrationWindow: [1, 1.25] }]);
 } finally { await d.close(); }
 const factors: number[] = [], cold = await drive(manager, { observeBudget: b => factors.push(b.factor) });
 try { await cold.start(); await cold.offer(10000); expect(factors).toEqual([1.25]); }
 finally { await cold.close(); }
});

test('overflow calibration also survives a cold instance', async () => {
 const { manager } = sessionWith([]), d = await drive(manager);
 const bound = (MODEL.contextWindow + 1) / 220000;
 try {
  await d.start(); await d.offer(220000);
  await d.reply({ stopReason: 'error', errorMessage: 'Your input exceeds the context window of this model.' });
  expect(seedWindow(manager.getBranch(), KEY)).toEqual([1, bound]);
 } finally { await d.close(); }
});

test('a run of turns with a stable full window writes no calibration entries', async () => {
 const { manager } = sessionWith([stampWindow(Array(CALIBRATION_WINDOW).fill(1.25))]), d = await drive(manager);
 try {
  await d.start();
  for (let i = 0; i < 12; i++) { await d.offer(10000); await d.reply(reporting(12500)); }
  expect(entries(manager)).toEqual([]);
 } finally { await d.close(); }
});

test('a changed aging window is saved even while its maximum stays unchanged', async () => {
 const { manager } = sessionWith([stampWindow([1.3, 1.1])]), d = await drive(manager);
 try {
  await d.start(); await d.offer(10000); await d.reply(reporting(11000));
  expect(entries(manager)).toHaveLength(1);
  expect(seedWindow(manager.getBranch(), KEY)).toEqual([1.3, 1.1, 1.1]);
 } finally { await d.close(); }
});

test('writes compare the seed after the unchanged clamps, rather than out-of-range raw values', async () => {
 const { manager } = sessionWith([stampWindow(Array(CALIBRATION_WINDOW).fill(1.5))]), d = await drive(manager);
 try {
  await d.start(); await d.offer(10000); await d.reply(reporting(20000));
  expect(entries(manager)).toEqual([]);
 } finally { await d.close(); }
});

test('the newest calibration or compaction wins, sibling entries never seed, and tree moves reseed the active branch', async () => {
 const { manager, first } = sessionWith([stampWindow([1.1])]);
 const kept = manager.getLeafId()!;
 manager.appendCustomEntry(TYPE, { calibrationIdentity: KEY, calibrationWindow: [1.4] });
 expect(seedWindow(manager.getBranch(), KEY)).toEqual([1.4]);
 manager.appendCompaction(SUMMARY, first, 1000, stampWindow([1.2]), true);
 expect(seedWindow(manager.getBranch(), KEY)).toEqual([1.2]);
 const factors: number[] = [], d = await drive(manager, { observeBudget: b => factors.push(b.factor) });
 try {
  await d.start(); await d.offer(10000);
  manager.branch(kept); await d.emit('session_tree', {}); await d.offer(10000);
  expect(factors).toEqual([1.2, 1.1]);
 } finally { await d.close(); }
});

test('a private calibration entry never enters the model projection or replaces learned server capacity', async () => {
 const { manager } = sessionWith([]), before = manager.buildSessionProjection().messages;
 manager.appendCustomEntry(TYPE, { calibrationIdentity: KEY, calibrationWindow: [1.25] });
 expect(manager.buildSessionProjection().messages).toEqual(before);
 const { seedContextWindow, WINDOW_RECEIPT } = await import('../src/request-capacity');
 manager.appendCustomEntry(WINDOW_RECEIPT, { calibrationIdentity: KEY, learnedContextWindow: 15000, serverClippedReplyId: 'reply' });
 manager.appendCustomEntry(TYPE, { calibrationIdentity: KEY, calibrationWindow: [1.3] });
 expect(seedContextWindow(manager.getBranch(), KEY)).toBe(15000);
});
