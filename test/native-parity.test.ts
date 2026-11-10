import { expect, test } from 'vitest';
import { SettingsManager, shouldCompact } from '@earendil-works/pi-coding-agent';
import { exemptUsefulCut, floorCase, forcedPointParity, nativeCompactionPoint, observeLegacyBudget, refusalParity, type NativeState } from './native-parity';

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
 expect(refusalParity(state, 'cannot fit')).toEqual({ violation: true });
 expect(refusalParity({ ...state, correctedTokens: 10001 }, 'cannot fit').exception).toBe('past-window');
 expect(refusalParity({ ...state, correctedTokens: 10000, hardLine: 10000 }, 'cannot fit').violation).toBe(true); // zero reserve/floor
 expect(refusalParity({ ...state, afterFailedReply: true }, 'cannot fit').exception).toBe('failed-reply');
 expect(refusalParity(state, 'Prompt check failed: partial summary').exception).toBe('prompt-check');
 expect(forcedPointParity(state, 5999)).toBe(true);
 expect(forcedPointParity(state, 6000)).toBe(false);
 expect(forcedPointParity({ ...state, afterFailedReply: true }, 5999)).toBe(false);
 expect(forcedPointParity({ ...state, nativePoint: null }, 6000)).toBe(true);
 expect(floorCase({ ...state, expectedHardLine: 8000 })).toBe(true);
 expect(floorCase({ ...state, expectedHardLine: 6500 })).toBe(false);
});

test('the reply-floor exception uses corrected count and is strict at the branch floor line on both builds', () => {
 expect(refusalParity({ ...state, correctedTokens: 8001 }, 'cannot fit')).toEqual({ violation: false, exception: 'reply-floor' });
 expect(refusalParity({ ...state, correctedTokens: 8000 }, 'cannot fit')).toEqual({ violation: true });
 expect(refusalParity({ ...state, correctedTokens: 7999 }, 'cannot fit')).toEqual({ violation: true });
 expect(refusalParity({ ...state, hardLine: undefined, expectedHardLine: 6500 }, 'baseline refusal').exception).toBe('reply-floor');
 expect(refusalParity({ ...state, hardLine: 6500, expectedHardLine: 8000 }, 'cannot fit').violation).toBe(true);
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
