import { expect, test } from "vitest";
import { harness } from "./budget-fixture";

test("a fresh thinking-only response at the full output allowance is preserved without a retry or capacity fault", async () => {
    const h = await harness({
        at: "prompt", complete: 0, noHistory: true, noOpening: true, host: 0, systemTokens: 19_000,
        limits: { contextWindow: 65_536, maxTokens: 32_768 }, reserveTokens: 16_384, piRequestPath: true,
        model: { provider: "openai", id: "gpt-4o" }, thinkingOnlyLength: request => request === 1,
        compaction: { requestReserve: undefined },
    });
    try {
        await h.session.prompt("Build a procedural office simulator.");
        // No retry: the next request is the act-now turn, at the same allowance, with the stalled reply left out of its context.
        expect(h.state.requestOptions.map(request => request.baseMaxTokens)).toEqual([32_768, 32_768]);
        expect(h.faults).toEqual([]);
        const branch = h.manager.getBranch();
        expect(branch.some(entry => entry.type === "compaction")).toBe(false);
        expect(branch.some(entry => entry.type === "custom" && entry.customType === "pi-tuck-capacity")).toBe(false);
        expect(branch.find(entry => entry.type === "message" && entry.message.role === "assistant"))
            .toMatchObject({ message: { stopReason: "length", content: [{ type: "thinking" }] } });
    } finally {
        await h.cleanup();
    }
});
