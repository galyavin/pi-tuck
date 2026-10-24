import { expect, test } from 'vitest';
import { conversationTokens, replayedReasoningTokens, requestTokens, type Messages } from '../src/budget';

// Pi's estimateTokens counts a thinking block's visible text only, but on the OpenAI Responses APIs pi-ai replays the turn's reasoning item (its
// thinkingSignature) on later requests. The one measure adds the turn's recorded reasoning tokens; nothing else changes.
const usage = (reasoning?: number) => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, ...(reasoning === undefined ? {} : { reasoning }), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const assistant = (o: { thinking?: string; signature?: string; reasoning?: number; stopReason?: string; text?: string; api?: string }) => ({
 role: 'assistant' as const, api: o.api ?? 'openai-responses', provider: 'openai', model: 'gpt-6.1-sol', timestamp: 0, stopReason: (o.stopReason ?? 'stop') as never, usage: usage(o.reasoning),
 content: [
  ...(o.thinking !== undefined || o.signature !== undefined ? [{ type: 'thinking' as const, thinking: o.thinking ?? '', ...(o.signature === undefined ? {} : { thinkingSignature: o.signature }) }] : []),
  { type: 'text' as const, text: o.text ?? 'done' },
 ],
});
const sig = JSON.stringify({ type: 'reasoning', id: 'rs_1', encrypted_content: 'x'.repeat(4000) });

test('a signed thinking block on a Responses API adds its recorded reasoning in full', () => {
 expect(replayedReasoningTokens(assistant({ signature: sig, reasoning: 1000 }) as never)).toBe(1000);
 expect(replayedReasoningTokens(assistant({ thinking: 'y'.repeat(400), signature: sig, reasoning: 1000 }) as never)).toBe(1000); // the visible summary is counted by estimateTokens too: the safe direction
 expect(replayedReasoningTokens(assistant({ signature: sig, reasoning: 999.2 }) as never)).toBe(1000);
 for (const api of ['azure-openai-responses', 'openai-codex-responses']) expect(replayedReasoningTokens(assistant({ signature: sig, reasoning: 1000, api }) as never)).toBe(1000);
});

test('nothing is added without a replayed reasoning item or a recorded count', () => {
 expect(replayedReasoningTokens(assistant({ reasoning: 1000 }) as never)).toBe(0); // no thinking block
 expect(replayedReasoningTokens(assistant({ thinking: 'visible', reasoning: 1000 }) as never)).toBe(0); // unsigned (not replayed as a reasoning item)
 expect(replayedReasoningTokens(assistant({ signature: '', reasoning: 1000 }) as never)).toBe(0); // empty signature
 expect(replayedReasoningTokens(assistant({ signature: sig }) as never)).toBe(0); // no usage.reasoning
 for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) expect(replayedReasoningTokens(assistant({ signature: sig, reasoning: bad }) as never)).toBe(0);
 for (const stopReason of ['aborted', 'error']) expect(replayedReasoningTokens(assistant({ signature: sig, reasoning: 1000, stopReason }) as never)).toBe(0); // Pi skips these turns
 for (const api of ['anthropic-messages', 'google-generative-ai', 'openai-completions']) expect(replayedReasoningTokens(assistant({ signature: sig, reasoning: 1000, api }) as never)).toBe(0); // their converters replay no reasoning item
 expect(replayedReasoningTokens({ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 0 } as never)).toBe(0);
});

test('the one measure counts it: conversationTokens and the guard\'s requestTokens both include the replayed reasoning', () => {
 const user = { role: 'user' as const, content: [{ type: 'text' as const, text: 'Start.' }], timestamp: 0 };
 const plain: Messages = [user, assistant({ thinking: '', reasoning: 5000 }) as never]; // unsigned: nothing replayed
 const signed: Messages = [user, assistant({ thinking: '', signature: sig, reasoning: 5000 }) as never];
 expect(conversationTokens(signed) - conversationTokens(plain)).toBe(5000);
 expect(requestTokens(signed, 'system prompt') - requestTokens(plain, 'system prompt')).toBe(5000);
 // Two replayed turns add both.
 const two: Messages = [...signed, { role: 'user' as const, content: [{ type: 'text' as const, text: 'Next.' }], timestamp: 0 }, assistant({ signature: sig, reasoning: 300 }) as never];
 const twoPlain: Messages = [...plain, { role: 'user' as const, content: [{ type: 'text' as const, text: 'Next.' }], timestamp: 0 }, assistant({ thinking: '', reasoning: 300 }) as never];
 expect(conversationTokens(two) - conversationTokens(twoPlain)).toBe(5300);
});
