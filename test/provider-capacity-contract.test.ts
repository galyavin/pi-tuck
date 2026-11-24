import { expect, test } from 'vitest';
import type { TranscriptContext } from '@earendil-works/pi-ai';
import { getApiProvider } from '@earendil-works/pi-ai/compat';
import { harness } from './budget-fixture';

const providers = [
 { provider: 'openai', id: 'gpt-6.1-sol', api: 'openai-responses', level: 'low', window: 8_192, maxTokens: 256 },
 { provider: 'anthropic', id: 'claude-sonnet-4-6', api: 'anthropic-messages', level: 'low', window: 12_288, maxTokens: 1_024 },
 { provider: 'openrouter', id: 'openai/gpt-oss-120b', api: 'openai-completions', level: 'xhigh', window: 65_536, maxTokens: 8_192 },
] as const;

test.each(providers)('$provider standalone pi-tuck dispatches through its native payload builder without extra capabilities', async profile => {
 const h = await harness({ at: 'prompt', complete: 0, noHistory: true, noOpening: true, stableHost: true,
  host: 200, systemTokens: 700, reserveTokens: 16_384,
  limits: { contextWindow: profile.window, maxTokens: profile.maxTokens }, model: profile,
  compaction: { requestReserve: undefined } });
 try {
  const model = h.session.model!;
  expect(model.api).toBe(profile.api);
  h.session.setThinkingLevel(profile.level);
  const prompt = 'Preserve the whole task across provider formats.';
  let transcript: TranscriptContext | undefined;
  const stream = h.session.agent.streamFunction;
  h.session.agent.streamFunction = (selected, context, options) => {
   transcript = structuredClone(context);
   return stream(selected, context, options);
  };
  await h.session.prompt(prompt);
  expect(h.faults).toEqual([]);
  expect(h.state.requests).toBe(1);
  expect(h.state.stops).toContain('stop');
  expect(transcript).toBeDefined();
  const native = getApiProvider(model.api)?.streamSimple;
  expect(native).toBeTypeOf('function');
  const payloads: unknown[] = [];
  await native!({ ...model, baseUrl: 'https://fixture.invalid/v1' }, transcript!, {
   apiKey: 'scripted-key', reasoning: profile.level, transport: 'sse',
   fetch: async () => { throw new Error('Unexpected HTTP'); },
   onPayload: value => { payloads.push(value); throw new Error('Captured payload'); },
  }).result();
  expect(payloads).toHaveLength(1);
  expect(JSON.stringify(payloads[0])).toContain(prompt);
  expect(JSON.stringify(payloads[0])).not.toContain('continue_final_message');
 } finally { await h.cleanup(); }
});
