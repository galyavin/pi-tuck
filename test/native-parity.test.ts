import { expect, test } from 'vitest';
import { normalizeContext, type Api, type Model, type AssistantMessage, type Message } from '@earendil-works/pi-ai';
import { clampMaxTokensToContext } from '@earendil-works/pi-ai/api/simple-options';
import { SettingsManager, shouldCompact } from '@earendil-works/pi-coding-agent';
import { exemptUsefulCut, floorCase, forcedPointParity, nativeCompactionPoint, observeLegacyBudget, nativeReplyClamp, refusalParity, type NativeState } from './native-parity';

const settings = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 4000, keepRecentTokens: 2000, modelOverrides: { 'p/small': { reserveTokens: 1000 } } } });

test('native points come from the installed shouldCompact and effective model overrides', () => {
 for (const [id, expected] of [['normal', 6000], ['small', 9000]] as const) {
  const resolved = settings.getCompactionSettings({ provider: 'p', id } as never), point = nativeCompactionPoint(10000, resolved)!;
  expect(point).toBe(expected);
  expect(shouldCompact(point, 10000, resolved)).toBe(false);
  expect(shouldCompact(point + 1, 10000, resolved)).toBe(true);
 }
 expect(nativeCompactionPoint(10000, { enabled: false, reserveTokens: 4000, keepRecentTokens: 0 })).toBeNull();
 expect(nativeCompactionPoint(1000, { enabled: true, reserveTokens: 2000, keepRecentTokens: 0 })).toBe(-1000);
});

const state: NativeState = { rawTokens: 7000, correctedTokens: 7000, factor: 1, window: 10000, room: 6000, hardLine: 8000, nativeSettings: settings.getCompactionSettings(),
 nativePoint: 6000, nativeAction: 'compact-then-send', afterFailedReply: false, branchEntries: 1, branchMessages: 1, leafId: 'x' };

test('the native-parity refusal exceptions are narrow and retain the window boundary', () => {
 expect(refusalParity(state)).toEqual({ violation: true });
 expect(refusalParity({ ...state, correctedTokens: 10001 }).exception).toBe('past-window');
 expect(refusalParity({ ...state, correctedTokens: 10000, expectedHardLine: 10000 }).violation).toBe(true); // zero reserve/floor
 expect(refusalParity({ ...state, afterFailedReply: true }).exception).toBe('failed-reply');
 expect(forcedPointParity(state, 5999)).toBe(true);
 expect(forcedPointParity(state, 6000)).toBe(false);
 expect(forcedPointParity({ ...state, afterFailedReply: true }, 5999)).toBe(false);
 expect(forcedPointParity({ ...state, nativePoint: null }, 6000)).toBe(true);
 expect(floorCase({ ...state, expectedHardLine: 8000 })).toBe(true);
 expect(floorCase({ ...state, expectedHardLine: 6500 })).toBe(false);
});

test('the reply-floor exception uses corrected count and is strict at the branch floor line on both builds', () => {
 const floorLine = 32_768 - 4_096 - 3_584;
 const floorState = { ...state, window: 32_768, room: 16_384, expectedHardLine: floorLine };
 expect(refusalParity({ ...floorState, correctedTokens: floorLine + 1 })).toEqual({ violation: false, exception: 'reply-floor' });
 expect(refusalParity({ ...floorState, correctedTokens: floorLine })).toEqual({ violation: true });
 expect(refusalParity({ ...floorState, correctedTokens: floorLine - 1 })).toEqual({ violation: true });
 expect(refusalParity({ ...state, hardLine: undefined, expectedHardLine: 6500 }).exception).toBe('reply-floor');
 expect(refusalParity({ ...state, hardLine: 6500, expectedHardLine: 8000 }).violation).toBe(true);
});

test('useful-cut exempts only forced cuts whose setup plus prompt exceeds the room', () => {
 expect(exemptUsefulCut(true, 6001, 6000)).toBe(true);
 expect(exemptUsefulCut(false, 6001, 6000)).toBe(false);
 expect(exemptUsefulCut(true, 6000, 6000)).toBe(false);
 expect(exemptUsefulCut(true, 5999, 6000)).toBe(false);
});

test('the baseline probe stops on unknown source instead of falling back to a hand budget model', () => {
 expect(() => observeLegacyBudget('unrecognised code')).toThrow('Cannot attach');
 expect(observeLegacyBudget('options.observeBudget(')).toBe('options.observeBudget(');
});

test('only the oracle clamp and floor can certify a below-hard-line refusal', () => {
 expect(refusalParity({ ...state, oracleClamp: 3583, oracleFloor: 3584 }).exception).toBe('reply-floor');
 expect(refusalParity({ ...state, oracleClamp: 3584, oracleFloor: 3584 }).violation).toBe(true);
 expect(refusalParity({ ...state, oracleClamp: 3585, oracleFloor: 3584 }).violation).toBe(true);
 expect(refusalParity({ ...state, hardLine: 6500 }).violation).toBe(true);
});

test('the smallest request keeps the last fresh usage anchor and clips only tool results', () => {
 const model = { contextWindow: 32768, maxTokens: 8192 } as Model<Api>;
 const assistant = (input: number, timestamp: number): AssistantMessage => ({ role: 'assistant', api: 'openai-responses', provider: 'test', model: 'test',
  content: [{ type: 'toolCall', id: 'fresh', name: 'effect', arguments: {} }], stopReason: 'toolUse', timestamp,
  usage: { input, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: input + 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
 const last = assistant(28000, 2);
 const result: Message = { role: 'toolResult', toolCallId: 'fresh', toolName: 'effect', isError: false, content: [{ type: 'text', text: 'x'.repeat(40000) }], timestamp: 3 };
 const fresh = [assistant(1000, 1), last, result], before = structuredClone(fresh);
 const cap = nativeReplyClamp(model, [{ role: 'system', content: 'x'.repeat(40000), timestamp: 0 }], { role: 'user', content: 'Answer my prompt', timestamp: 0 }, fresh);
 // Pi's last usage supersedes the prefix, while the clipped result still follows that anchor.
 const reference = clampMaxTokensToContext(model, normalizeContext({ messages: [last, { ...result, content: [{ type: 'text', text: 'x'.repeat(800) }] }] }), model.maxTokens);
 expect(cap).toBe(reference);
 expect(cap).toBeGreaterThan(1);
 expect(cap).toBeLessThan(3584);
 expect(fresh).toEqual(before);
});
