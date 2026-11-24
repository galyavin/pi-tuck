import { createAssistantMessageEventStream, type Api, type AssistantMessage, type AssistantMessageEvent, type Model, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";

export interface LlamaContinuation {
    model: string;
    extraTokens: number;
    deadlineMs: number;
}

type Wire = Record<string, unknown>;
const completions = "openai-completions";
const wire = (value: unknown): Wire => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a Chat Completions request");
    return value as Wire;
};
const promptTokens = (message: AssistantMessage) => message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;

export function llamaContinuationStream(profile: LlamaContinuation, native: NonNullable<ReturnType<typeof getApiProvider>>["streamSimple"]) {
    return (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => {
        if (`${model.provider}/${model.id}` !== profile.model || (options && "disableContinuation" in options && options.disableContinuation) || !model.reasoning)
            return native(model, context, options);
        const output = createAssistantMessageEventStream();
        const signal = options?.signal
            ? AbortSignal.any([options.signal, AbortSignal.timeout(profile.deadlineMs)])
            : AbortSignal.timeout(profile.deadlineMs);

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
                const thought = first.content.length === 1 && first.content[0]?.type === "thinking" && first.content[0].thinking;
                const request = firstRequest;
                const originalCap = request?.max_completion_tokens ?? request?.max_tokens;
                // Only exhaustions at the full configured cap qualify. An input-clamped or
                // server-clipped reply is Pi's capacity recovery case.
                const remainder = Math.min(profile.extraTokens, model.contextWindow - promptTokens(first) - first.usage.output - 4096);
                if (!signal.aborted && first.stopReason === "length" && thought && thinkingEnd && request && Array.isArray(request.messages) &&
                    originalCap === model.maxTokens && first.usage.output === model.maxTokens &&
                    Number.isSafeInteger(remainder) && remainder > 0 && promptTokens(first) > 0 &&
                    request.n_predict === undefined && request.continue_final_message === undefined) {
                    const messages = [...request.messages, { role: "assistant", content: "", reasoning_content: thought }];
                    const payload = { ...request, messages, max_completion_tokens: remainder, add_generation_prompt: false, continue_final_message: "reasoning_content" } as Wire;
                    delete payload.max_tokens;
                    // The native parser keeps streaming, handles cancellation and validates tool
                    // arguments. Only the completed combined response is returned to the agent loop.
                    const continuation = native(model, context, {
                        ...options, signal, maxTokens: remainder, maxRetries: 0,
                        onPayload: async (_value, actualModel) => {
                            const expected = JSON.stringify(payload);
                            const next = (await options?.onPayload?.(payload, actualModel)) ?? payload;
                            if (JSON.stringify(next) !== expected) throw new Error("Continuation request changed by a provider hook");
                            return next;
                        },
                    });
                    // The continuation is bounded. Keep only its final result until its
                    // usage proves that it followed the expected prompt and reasoning.
                    const second = await continuation.result();
                    if (signal.aborted) {
                        first = { ...first, stopReason: "aborted", errorMessage: "Continuation cancelled or deadline reached" };
                    } else if (second.stopReason !== "error" && second.stopReason !== "aborted" &&
                        promptTokens(second) === promptTokens(first) + first.usage.output &&
                        Number.isSafeInteger(second.usage.output) && second.usage.output > 0 && second.usage.output <= remainder) {
                        // A length stop cannot certify complete arguments. Keep the
                        // reasoning and any text, but do not offer a tool call to Pi.
                        const blocks = second.stopReason === "length"
                            ? second.content.filter(block => block.type !== "toolCall")
                            : [...second.content];
                        const suffix = blocks[0]?.type === "thinking" ? blocks.shift() : undefined;
                        const initialThought = first.content[0];
                        if (initialThought?.type !== "thinking") throw new Error("Expected unfinished reasoning");
                        const combined = { ...initialThought, thinking: thought + (suffix?.type === "thinking" ? suffix.thinking : "") };
                        const outputTokens = first.usage.output + second.usage.output;
                        // Pi uses this as the size of one logical transcript prefix.
                        // The native stream hooks observe actual usage for each HTTP request.
                        const usage = { ...first.usage, output: outputTokens, totalTokens: promptTokens(first) + outputTokens };
                        first = { ...second, timestamp: first.timestamp, content: [combined, ...blocks], usage };
                        if (first.stopReason === "stop" && !blocks.some(block => block.type === "text" && block.text.trim()))
                            first.stopReason = "length";

                        const partial = { ...first, content: [combined] };
                        if (suffix?.type === "thinking")
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
