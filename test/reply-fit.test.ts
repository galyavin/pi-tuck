import { expect, test } from 'vitest';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { branchReplyFloor, needsFullReplyReserve, replyFit, requestReplyFloor } from '../src/request-capacity';

const assistant = (output: number, stopReason = 'stop', errorMessage?: string, thinking = false) => ({ type: 'message', message: {
  role: 'assistant', content: thinking ? [{ type: 'thinking', thinking: 'spent' }] : [], usage: { output }, stopReason, errorMessage,
} }) as SessionEntry;
for (const [name, branch, failed, largestOutput, floor] of [
  ['empty', [], false, 0, 3584],
  ['successful output', [assistant(1200), assistant(5000.1)], false, 5000.1, 5001],
  ['unusable output', [assistant(NaN), assistant(Infinity), assistant(-1)], false, 0, 3584],
  ['transient error', [assistant(6000), assistant(0, 'error', '503 Service Unavailable')], false, 6000, 6000],
  ['length before a later large reply', [assistant(1, 'length'), assistant(9000)], true, 9000, 8192],
  ['overflow', [assistant(0, 'error', 'Your input exceeds the context window of this model. Please adjust your input and try again.')], true, 0, 8192],
] as const) test(`reply fit owns reserve fallback and floor history: ${name}`, () => {
  expect(replyFit(branch)).toEqual({ failed, largestOutput, thinkingStop: false });
  expect(branchReplyFloor(branch, 8192)).toBe(floor);
  expect(requestReplyFloor(branch, 8192, 4096)).toBe(Math.min(floor, 4096));
});

for (const fullReserve of [false, true]) test(`thinking exhaustion shares the reply-fit reader (full reserve=${fullReserve})`, () => {
  const thinking = assistant(9000.1, 'length', undefined, true);
  const branch = [thinking, assistant(1000), ...(fullReserve ? [assistant(1, 'length')] : [])];
  expect(thinking.type === 'message' && needsFullReplyReserve(thinking.message)).toBe(false);
  expect(replyFit(branch)).toEqual({ failed: fullReserve, largestOutput: 9000.1, thinkingStop: true });
  expect(branchReplyFloor(branch, 8192)).toBe(fullReserve ? 8192 : 9001);
  expect(requestReplyFloor(branch, 8192, 4096)).toBe(4096);
});
