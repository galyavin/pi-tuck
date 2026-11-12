import type { Api, Model, SimpleStreamOptions, TranscriptContext } from '@earendil-works/pi-ai';
import { streamSimple as completions } from '@earendil-works/pi-ai/api/openai-completions';
import { streamSimple as responses } from '@earendil-works/pi-ai/api/openai-responses';
import { buildBaseOptions } from '@earendil-works/pi-ai/api/simple-options';
import { estimateContextTokens } from '@earendil-works/pi-ai/utils/estimate';

/** Run Pi's real option and payload builders, stopping at onPayload before any HTTP.
 * The scripted server uses a capped Responses transport for non-Completions models
 * (including Codex, whose own wire format omits an output cap). No copied clamps.
 */
export async function providerRequest(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) {
 const base = buildBaseOptions(model, context, options);
 const api = model.api === 'openai-completions' ? 'openai-completions' : 'openai-responses';
 let payload: Record<string, unknown> | undefined;
 const sentinel = new Error('Scripted provider: captured request');
 const requestModel = { ...model, api, baseUrl: 'https://fixture.invalid/v1' };
 const requestOptions: SimpleStreamOptions = { ...options, apiKey: 'sk-scripted-fixture', transport: 'sse',
  fetch: async () => { throw new Error('Scripted request escaped onPayload'); },
  onPayload: async value => { payload = (await options?.onPayload?.(value, model) ?? value) as Record<string, unknown>; throw sentinel; },
 };
 const stream = api === 'openai-completions'
  ? completions(requestModel as Model<'openai-completions'>, context, requestOptions)
  : responses(requestModel as Model<'openai-responses'>, context, requestOptions);
 const result = await stream.result();
 if (!payload) throw new Error(`Pi did not build the scripted request: ${result.errorMessage}`);
 const field = ['max_tokens', 'max_completion_tokens', 'max_output_tokens'].find(key => typeof payload![key] === 'number');
 if (!field) throw new Error('Pi request has no output cap');
 return { api, field, maxTokens: payload[field] as number, baseMaxTokens: base.maxTokens!,
  requestedMaxTokens: options?.maxTokens ?? model.maxTokens, contextTokens: estimateContextTokens(context).tokens,
  thinkingBudget: payload.thinking_budget ?? payload.reasoning_budget ?? payload.reasoning };
}
