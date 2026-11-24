import { describe, expect, test } from "vitest";
import { createAssistantMessageEventStream, normalizeContext, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { ApiStreamSimpleFunction } from "@earendil-works/pi-ai/compat";
import { llamaContinuationStream } from "../src/llama-continuation";

const model: Model<"openai-completions"> = {
    api: "openai-completions", provider: "test-llama", id: "local", name: "local",
    baseUrl: "http://127.0.0.1:1234/v1", input: ["text"], contextWindow: 8192, maxTokens: 8,
    reasoning: true, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const context = normalizeContext({ messages: [{ role: "user", content: "Compute 6 × 7", timestamp: 0 }] });
const profile = { model: "test-llama/local", extraTokens: 32, deadlineMs: 5000 };
const thought = { type: "thinking" as const, thinking: "Six times" };
const tool = { type: "toolCall" as const, name: "record_answer", id: "call_1", arguments: { answer: 42 } };

function fixture(secondInput: number, secondStop: "toolUse" | "length" | "cancel" = "toolUse", cached = 119) {
    const payloads: unknown[] = [];
    const controller = new AbortController();
    const native: ApiStreamSimpleFunction = (model, _context, options) => {
        const stream = createAssistantMessageEventStream();
        void (async () => {
            const payload = await options?.onPayload?.({ messages: context.messages, max_completion_tokens: model.maxTokens }, model);
            payloads.push(payload);
            const first = payloads.length === 1;
            if (!first)
                await options?.onProviderStreamEvent?.({ prompt_progress: { total: 120, cache: cached, processed: cached } }, model);
            const input = first ? 112 : secondInput;
            const output = first ? 8 : 16;
            const reason = first ? "length" : secondStop === "cancel" ? "aborted" : secondStop;
            const message: AssistantMessage = {
                api: model.api, provider: model.provider, model: model.id, timestamp: 0, role: "assistant",
                content: first ? [thought] : [{ type: "thinking", thinking: " seven equals 42." }, tool],
                stopReason: reason,
                usage: { input, output, totalTokens: input + output, cacheRead: 0, cacheWrite: 0,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            };
            if (reason === "aborted") {
                controller.abort();
                stream.push({ type: "error", reason: "aborted", error: message });
            } else {
                stream.push({ type: "start", partial: message });
                if (first) stream.push({ type: "thinking_end", contentIndex: 0, content: thought.thinking, partial: message });
                stream.push({ type: "done", reason, message });
            }
            stream.end();
        })();
        return stream;
    };
    return { payloads, controller, run: llamaContinuationStream(profile, native) };
}

describe("bounded llama.cpp continuation", () => {
    test("continues a full-cap reasoning response and exposes one terminal tool call with logical usage", async () => {
        const f = fixture(120);
        const stream = f.run(model, context);
        const events = [];
        for await (const event of stream) events.push(event);
        expect(f.payloads).toHaveLength(2);
        expect(f.payloads[1]).toMatchObject({
            messages: [...context.messages, { role: "assistant", reasoning_content: thought.thinking }],
            max_completion_tokens: 32, add_generation_prompt: false, continue_final_message: "reasoning_content",
        });
        expect(events.filter(event => event.type === "done" || event.type === "error")).toHaveLength(1);
        expect(events.filter(event => event.type === "toolcall_end")).toHaveLength(1);
        expect(await stream.result()).toMatchObject({
            stopReason: "toolUse", content: [{ type: "thinking", thinking: "Six times seven equals 42." }, tool],
            usage: { input: 112, output: 24, totalTokens: 136 },
        });
    });

    test("holds back a continuation whose input usage no longer matches the original prefix", async () => {
        const f = fixture(121);
        const result = await f.run(model, context).result();
        expect(f.payloads).toHaveLength(2);
        expect(result).toMatchObject({ stopReason: "length", content: [thought], usage: { output: 8 } });
    });

    test("keeps the reasoning but offers no tool action after a second length stop", async () => {
        const f = fixture(120, "length");
        const stream = f.run(model, context);
        const events = [];
        for await (const event of stream) events.push(event);
        expect(events.some(event => event.type === "toolcall_end")).toBe(false);
        expect(await stream.result()).toMatchObject({
            stopReason: "length", content: [{ type: "thinking", thinking: "Six times seven equals 42." }],
            usage: { output: 24 },
        });
    });

    test("abandons a cold replay and preserves the first response without executing its tool", async () => {
        const f = fixture(120, "toolUse", 0);
        const result = await f.run(model, context).result();
        expect(f.payloads).toHaveLength(2);
        expect(result).toMatchObject({
            stopReason: "length", content: [thought], usage: { output: 8 },
            errorMessage: expect.stringContaining("without rebuilding context"),
        });
    });

    test("respects cancellation and keeps the original reasoning", async () => {
        const f = fixture(120, "cancel");
        const result = await f.run(model, context, { signal: f.controller.signal }).result();
        expect(f.payloads).toHaveLength(2);
        expect(result).toMatchObject({ stopReason: "aborted", content: [thought] });
    });

    test("does not request continuation when the remaining context cannot accommodate it", async () => {
        const f = fixture(120);
        const result = await f.run({ ...model, contextWindow: 4200 }, context).result();
        expect(f.payloads).toHaveLength(1);
        expect(result).toMatchObject({ stopReason: "length", content: [thought] });
    });
});
