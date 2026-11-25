import { expect, test } from 'vitest';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { requestReplyFloor } from '../src/request-capacity';

const model = { provider: 'example', api: 'example', id: 'small', maxTokens: 256 };
const assistant = (output: number, stopReason = 'stop', thinking = false, id = model.id) => ({ type: 'message', message: {
 role: 'assistant', provider: model.provider, api: model.api, model: id,
 content: thinking ? [{ type: 'thinking', thinking: 'spent' }] : [], usage: { output }, stopReason,
} }) as SessionEntry;

test('a small model starts with minimal headroom and ignores other models and failed requests', () => {
 const entries = [assistant(400, 'stop', false, 'other'), assistant(900, 'error'), assistant(600, 'aborted'), assistant(NaN)];
 expect(requestReplyFloor(entries, 16_384, model)).toBe(1);
 expect(requestReplyFloor([...entries, assistant(34.5)], 16_384, model)).toBe(35);
 expect(requestReplyFloor([...entries, assistant(200, 'length')], 64, model)).toBe(64);
 expect(requestReplyFloor([...entries, assistant(400, 'length', true)], 64, model)).toBe(256);
});
