import { expect, test } from 'vitest';
import { CUT_REPLY_FLOOR, requestReplyFloor } from '../src/request-capacity';
import { MODEL } from './calibration-fixture';
import { harness } from './budget-fixture';

const limits = { contextWindow: 65_536, maxTokens: 16_384 };
test('a cut above the room aims for the cut reply floor', async () => {
 const h = await harness({ at: 'prompt', complete: 52_600, history: 10_000, host: 0, systemTokens: 42_000, keepRecent: 4_000,
  limits, reserveTokens: 24_576, piRequestPath: true, compaction: { requestReserve: undefined } });
 try {
  await h.run();
  expect(h.faults).toEqual([]);
  expect(h.compactions().length).toBeGreaterThan(0);
  expect(h.state.requestOptions[0]!.baseMaxTokens).toBeGreaterThanOrEqual(CUT_REPLY_FLOOR);
 } finally { await h.cleanup(); }
});

test('where no cut can reach the cut reply floor, the request is sent as Pi sends it', async () => {
 const h = await harness({ at: 'prompt', complete: 0, noHistory: true, noOpening: true, host: 0, systemTokens: 52_000,
  limits, reserveTokens: 24_576, piRequestPath: true, compaction: { requestReserve: undefined } });
 try {
  await h.session.prompt('Task');console.log("B",JSON.stringify(h.manager.getBranch().flatMap(e=>e.type==="custom"?[e.data]:[])),h.state.requestOptions.map(o=>[o.baseMaxTokens,o.contextTokens]));
  expect(h.faults).toEqual([]);
  expect(h.state.requests).toBe(1);
  expect(h.state.requestOptions[0]!.baseMaxTokens).toBeLessThan(CUT_REPLY_FLOOR);
  expect(h.state.requestOptions[0]!.baseMaxTokens).toBeGreaterThan(0);
 } finally { await h.cleanup(); }
});

test('the cut reply floor stays within the reserve and the model limit, and leaves the admission floor alone', () => {
 expect(requestReplyFloor([], 16_384, { ...MODEL, maxTokens: 16_384 })).toBe(1);
 expect(requestReplyFloor([], 16_384, { ...MODEL, maxTokens: 16_384 }, CUT_REPLY_FLOOR)).toBe(CUT_REPLY_FLOOR);
 expect(requestReplyFloor([], 2_048, { ...MODEL, maxTokens: 16_384 }, CUT_REPLY_FLOOR)).toBe(2_048);
 expect(requestReplyFloor([], 16_384, { ...MODEL, maxTokens: 256 }, CUT_REPLY_FLOOR)).toBe(256);
});
