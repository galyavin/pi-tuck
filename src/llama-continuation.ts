import { createAssistantMessageEventStream, type Api, type AssistantMessage, type AssistantMessageEvent, type Model, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import type { ApiStreamSimpleFunction } from "@earendil-works/pi-ai/compat";
import { CONTINUATION_CACHE_MISS } from "./status.js";

export interface LlamaContinuation {
    model: string;
    extraTokens: number;
    deadlineMs: number;
}

type Wire = Record<string, unknown>;
const wire = (value: unknown): Wire => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a Chat Completions request");
    return value as Wire;
};
const promptTokens = (message: AssistantMessage) => message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;

export function llamaContinuationStream(profile: LlamaContinuation, native: ApiStreamSimpleFunction) {
    return (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => {
        if (`${model.provider}/${model.id}` !== profile.model || (options && "disableContinuation" in options && options.disableContinuation) || !model.reasoning)
            return native(model, context, options);
        const output = createAssistantMessageEventStream();
        const deadline = AbortSignal.timeout(profile.deadlineMs);
        const signal = options?.signal ? AbortSignal.any([options.signal, deadline]) : deadline;

        void (async () => {
            let first: AssistantMessage | undefined;
            let firstRequest: Wire | undefined;
            let thinkingEnd: Extract<AssistantMessageEvent, {type: "thinking_end"}> | undefined;
            try {
                const stream = native(model, context, {
                    ...options, signal,
                    onPayload: async (value, actualModel) => {
                        // The gateway notices a disconnected client on its next write,
                        // including during a silent prompt prefill.
                        const withPing = { sse_ping_interval: 5, ...wire(value) };
                        const payload = (await options?.onPayload?.(withPing, actualModel)) ?? withPing;
                        firstRequest = structuredClone(wire(payload));
                        return payload;
                    },
                });
                for await (const event of stream) {
                    if (event.type === "done" || event.type === "error") continue;
                    if (event.type === "thinking_end" && event.partial.stopReason === "length" &&
                        event.contentIndex === 0 && event.partial.content.length === 1) {
                        thinkingEnd = event;
                    } else {
                        output.push(event);
                    }
                }
                first = await stream.result();
                const thought = first.content.length === 1 ? first.content[0] : undefined;
                const initialPrompt = promptTokens(first);
                const expectedPrompt = initialPrompt + first.usage.output;
                const request = firstRequest;
                const originalCap = request?.max_completion_tokens ?? request?.max_tokens;
                // Only exhaustions at the full configured cap qualify. An input-clamped or
                // server-clipped reply is Pi's capacity recovery case.
                const remainder = Math.min(profile.extraTokens, model.contextWindow - expectedPrompt - 4096);
                if (!signal.aborted && first.stopReason === "length" && thought?.type === "thinking" && thought.thinking &&
                    thinkingEnd && request && Array.isArray(request.messages) &&
                    originalCap === model.maxTokens && first.usage.output === model.maxTokens &&
                    Number.isSafeInteger(remainder) && remainder > 0 && initialPrompt > 0 &&
                    request.n_predict === undefined && request.continue_final_message === undefined) {
                    const messages = [...request.messages, { role: "assistant", content: "", reasoning_content: thought.thinking }];
                    const payload = { ...request, messages, max_completion_tokens: remainder, add_generation_prompt: false,
                        continue_final_message: "reasoning_content", return_progress: true } as Wire;
                    delete payload.max_tokens;
                    const admission = new AbortController();
                    const continuationSignal = AbortSignal.any([signal, admission.signal]);
                    let cacheVerified = false;
                    // Expect an initial report, before prompt evaluation. A server that cannot
                    // show reuse must not silently spend the deadline rebuilding the prompt.
                    const admissionTimer = setTimeout(() => admission.abort(), 15_000);
                    admissionTimer.unref();
                    // The native parser keeps streaming, handles cancellation and validates tool
                    // arguments. Only the completed combined response is returned to the agent loop.
                    let second: AssistantMessage;
                    try {
                        const continuation = native(model, context, {
                            ...options, signal: continuationSignal, maxTokens: remainder, maxRetries: 0,
                            onPayload: async (_value, actualModel) => {
                                const expected = JSON.stringify(payload);
                                const next = (await options?.onPayload?.(payload, actualModel)) ?? payload;
                                if (JSON.stringify(next) !== expected) throw new Error("Continuation request changed by a provider hook");
                                return next;
                            },
                            onProviderStreamEvent: async (event, actualModel) => {
                                if (!cacheVerified && !admission.signal.aborted && event && typeof event === "object" && "prompt_progress" in event) {
                                    const progress = wire(event.prompt_progress);
                                    cacheVerified = progress.total === expectedPrompt &&
                                        (progress.cache === expectedPrompt - 1 || progress.cache === expectedPrompt);
                                    if (!cacheVerified) admission.abort();
                                    clearTimeout(admissionTimer);
                                }
                                await options?.onProviderStreamEvent?.(event, actualModel);
                            },
                        });
                        // Release no tool actions until the terminal response confirms the prefix
                        // length and that the shared allowance still holds.
                        second = await continuation.result();
                    } finally {
                        clearTimeout(admissionTimer);
                    }
                    if (signal.aborted) {
                        first = { ...first, stopReason: "aborted", errorMessage: "Continuation cancelled or deadline reached" };
                    } else if (!cacheVerified) {
                        first = { ...first, errorMessage: CONTINUATION_CACHE_MISS };
                    } else if (second.stopReason !== "error" && second.stopReason !== "aborted" &&
                        promptTokens(second) === expectedPrompt &&
                        Number.isSafeInteger(second.usage.output) && second.usage.output > 0 && second.usage.output <= remainder) {
                        // A length stop cannot certify complete arguments. Keep the
                        // reasoning and any text, but do not offer a tool call to Pi.
                        const leading = second.content[0];
                        const suffix = leading?.type === "thinking" ? leading : undefined;
                        const rest = suffix ? second.content.slice(1) : second.content;
                        const blocks = second.stopReason === "length" ? rest.filter(block => block.type !== "toolCall") : rest;
                        const combined = { ...thought, thinking: thought.thinking + (suffix?.thinking ?? "") };
                        const outputTokens = first.usage.output + second.usage.output;
                        // Pi uses this as the size of one logical transcript prefix.
                        // The native stream hooks observe actual usage for each HTTP request.
                        const usage = { ...first.usage, output: outputTokens, totalTokens: initialPrompt + outputTokens };
                        first = { ...second, timestamp: first.timestamp, content: [combined, ...blocks], usage };
                        if (first.stopReason === "stop" && !blocks.some(block =>
                            block.type === "toolCall" || block.type === "text" && block.text.trim()))
                            first.stopReason = "length";

                        const partial = { ...first, content: [combined] };
                        if (suffix)
                            output.push({ type: "thinking_delta", contentIndex: 0, delta: suffix.thinking, partial });
                        output.push({ type: "thinking_end", contentIndex: 0, content: combined.thinking, partial });
                        thinkingEnd = undefined;
                        for (const [index, block] of blocks.entries()) {
                            const contentIndex = index + 1;
                            const partial = { ...first, content: first.content.slice(0, contentIndex + 1) };
                            if (block.type === "toolCall") {
                                output.push({ type: "toolcall_start", contentIndex, partial });
                                output.push({ type: "toolcall_end", contentIndex, partial, toolCall: block });
                            } else if (block.type === "text") {
                                output.push({ type: "text_start", contentIndex, partial });
                                output.push({ type: "text_delta", contentIndex, partial, delta: block.text });
                                output.push({ type: "text_end", contentIndex, partial, content: block.text });
                            } else {
                                output.push({ type: "thinking_start", contentIndex, partial });
                                output.push({ type: "thinking_delta", contentIndex, partial, delta: block.thinking });
                                output.push({ type: "thinking_end", contentIndex, partial, content: block.thinking });
                            }
                        }
                    }
                }
            } catch (error) {
                if (!first) throw error;
                if (signal.aborted)
                    first = { ...first, stopReason: "aborted", errorMessage: "Continuation cancelled or deadline reached" };
            } finally {
                if (thinkingEnd) output.push(thinkingEnd);
            }
            if (!first) throw new Error("Provider returned no response");
            if (first.stopReason === "error" || first.stopReason === "aborted")
                output.push({ type: "error", reason: first.stopReason, error: first });
            else if (first.stopReason !== "pending")
                output.push({ type: "done", reason: first.stopReason, message: first });
            else throw new Error("Provider returned an unfinished stream");
            output.end();
        })().catch(error => {
            const reason = signal.aborted ? "aborted" : "error";
            output.push({type: "error", reason, error: {
                role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
                content: [], stopReason: reason, errorMessage: String(error),
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            }});
            output.end();
        });
        return output;
    };
}
