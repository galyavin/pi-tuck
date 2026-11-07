import { expect, test, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { Type } from "typebox";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { getCurrentSystemMessage, type Model } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installCompaction } from "../src/compaction";
import { createSemanticRecall } from "../src/semantic-recall";
import { requestTokens, type Messages } from "../src/budget";
import { CONTRACT_MARK } from "../src/fixed-context";
import { scriptedModelRuntime } from "./model-fixture";

interface Payload {
    messages: { role: string; content: unknown }[];
    tools: { type: string; function: { name: string; description: string; parameters: unknown; strict?: boolean } }[];
}

// Real Pi, its validator, extension runner, OpenAI serializer and HTTP stream. All replies are scripted on localhost.
test("real Pi sends schema tools, preserves the failure prefix and skills, and passes through with conditions off", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-fixed-context-"));
    let replies: { tool?: string; args?: unknown; text?: string }[] = [], payloads: Payload[] = [];
    const server = createServer((req, res) => {
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", () => {
            payloads.push(JSON.parse(body));
            const reply = replies.shift() ?? { text: "done" }, base = { id: "fake", object: "chat.completion.chunk", created: 0, model: "offline" };
            res.writeHead(200, { "content-type": "text/event-stream" });
            const send = (delta: unknown, finish_reason: string | null) => res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
            if (reply.tool) {
                send({ role: "assistant", tool_calls: [{ index: 0, id: `call_${payloads.length}`, type: "function", function: { name: reply.tool, arguments: JSON.stringify(reply.args ?? {}) } }] }, null);
                send({}, "tool_calls");
            } else {
                send({ role: "assistant", content: reply.text ?? "done" }, null);
                send({}, "stop");
            }
            res.end("data: [DONE]\n\n");
        });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw Error("No localhost address");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const realFetch = globalThis.fetch;
    const network = vi.spyOn(globalThis, "fetch").mockImplementation((url, options) => {
        if (!String(url instanceof Request ? url.url : url).startsWith(baseUrl + "/")) throw Error("Unexpected non-local HTTP");
        return realFetch(url, options);
    });
    const description = "Look up records. " + "Detailed owner documentation. ".repeat(2600);
    const parameters = Type.Object({ query: Type.String({ minLength: 1, maxLength: 100, description: "Terms to look up" }) }, { additionalProperties: false });
    const skill = { name: "fixture-skill", description: "Full skill description and its essential trigger tail.", filePath: join(dir, "skills/fixture-skill/SKILL.md"), baseDir: join(dir, "skills/fixture-skill"),
        sourceInfo: { path: dir, source: "user", scope: "user" as const, origin: "top-level" as const }, disableModelInvocation: false };
    const run = async (prune: boolean, priced = false, big = false, scripted = false) => {
        payloads = [];
        replies = scripted ? [
            { tool: "lookup", args: {} }, // real Pi validation fails before tool_call/tool_result
            { tool: "noop" }, { tool: "noop" },
            { tool: "lookup", args: {} }, // second error restores the declaration
            { tool: "lookup", args: { query: "valid" } }, { text: "done" },
        ] : [{ text: "done" }];
        const runtime = await scriptedModelRuntime({ contextWindow: big ? 1000000 : 81920, maxTokens: 16384 });
        const original = runtime.getModel("openai-codex", "gpt-6.1-sol")!;
        const model: Model<"openai-completions"> = { ...original, api: "openai-completions", baseUrl, reasoning: false,
            cost: { input: priced ? 1 : 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsMidConvoSystemMessages: false } };
        Object.assign(original, model);
        // Invoke Pi's real OpenAI transport, with an inert key and the local-only fetch guard above.
        const stream = vi.spyOn(runtime, "streamSimple").mockImplementation((_model, context, options) => streamSimple(model, context as never, { ...options, apiKey: "offline", cacheRetention: "none" }));
        const manager = SessionManager.inMemory(dir), faults: string[] = [], seen: Messages[] = [], counted: number[] = [];
        const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 0 } });
        let api: ExtensionAPI | undefined, handle: Awaited<ReturnType<typeof installCompaction>> | undefined;
        const semantic = createSemanticRecall();
        const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings, noExtensions: true,
            noContextFiles: true, noSkills: true, noThemes: true, noPromptTemplates: true,
            skillsOverride: () => ({ skills: [skill], diagnostics: [] }),
            extensionFactories: [async pi => {
                api = pi;
                handle = await installCompaction(pi, { semanticRecall: semantic, settings, search: false, cutAt: 1, fixedContextPruning: prune, fail: error => faults.push(String(error)) });
                pi.on("context_with_system", (event, ctx) => {
                    seen.push(structuredClone(event.messages));
                    // The transformed prompt is carried by the leading message; ctx still exposes Pi's unmodified full prompt.
                    const head = getCurrentSystemMessage(event.messages as never);
                    const prompt = typeof head?.content === "string" ? head.content : ctx.getSystemPrompt();
                    counted.push(requestTokens(event.messages, prompt));
                });
            }] });
        await loader.reload();
        expect(loader.getExtensions().errors).toEqual([]);
        let executed = 0;
        const { session } = await createAgentSession({ cwd: dir, modelRuntime: runtime, model, sessionManager: manager, settingsManager: settings, resourceLoader: loader,
            tools: ["read", "bash", "edit", "write", "tuck_recall", "lookup", "noop"], customTools: [
                { name: "lookup", label: "Lookup", description, promptSnippet: "Look up records with stable identifiers.", promptGuidelines: ["LOOKUP RULE: use stable identifiers."], parameters,
                    execute: async () => { executed++; return { content: [{ type: "text", text: "found" }], details: {} }; } },
                { name: "noop", label: "Noop", description: "Do nothing. No documentation needed.", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }) },
            ] });
        try {
            await session.bindExtensions({ uiContext: new Proxy({ notify: () => {} }, { get: (target, key) => key in target ? (target as never)[key] : () => undefined }) as never,
                abortHandler: () => { void session.abort(); } });
            const fullPrompt = session.systemPrompt;
            const fullTools = api!.getAllTools();
            await session.prompt("Exercise the offline fixture.");
            expect(faults).toEqual([]);
            expect(payloads.length).toBe(scripted ? 6 : 1);
            const wire = structuredClone(payloads);
            return { wire, fullPrompt, fullTools, seen, counted, executed, entries: structuredClone(manager.getBranch()) };
        } finally {
            await session.abort(); session.dispose(); await handle?.close(); stream.mockRestore();
        }
    };
    try {
        const on = await run(true, false, false, true);
        const lookup = (payload: Payload) => payload.tools.find(tool => tool.function.name === "lookup")!.function;
        expect(lookup(on.wire[0]!).description.length).toBe("Look up records with stable identifiers.".length);
        expect(lookup(on.wire[0]!)).not.toHaveProperty("strict");
        expect(lookup(on.wire[0]!).parameters).toEqual({ type: "object", properties: { query: { type: "string", minLength: 1, maxLength: 100 } }, required: ["query"], additionalProperties: false });
        expect(on.executed).toBe(1); // valid first calls run immediately, no block
        for (const payload of on.wire.slice(0, 4)) expect(payload.tools).toEqual(on.wire[0]!.tools);
        for (let n = 2; n < on.wire.length; n++) expect(on.wire[n]!.messages.slice(0, on.wire[n - 1]!.messages.length)).toEqual(on.wire[n - 1]!.messages);
        expect(lookup(on.wire[4]!).description).toBe(description);
        expect(JSON.stringify(on.wire[1]!.messages)).toContain(CONTRACT_MARK);
        expect(JSON.stringify(on.entries)).not.toContain(CONTRACT_MARK);
        const skills = (prompt: string) => prompt.match(/<skills>[\s\S]*?<\/skills>/)?.[0];
        const fullSkills = skills(on.fullPrompt);
        expect(fullSkills).toContain(skill.description);
        for (const payload of on.wire) {
            const prompt = String(payload.messages[0]!.content);
            expect(skills(prompt)).toBe(fullSkills);
            expect(prompt).not.toContain("LOOKUP RULE:");
            for (const name of ["read", "bash", "edit", "write", "tuck_recall"]) {
                const full = on.fullTools.find(tool => tool.name === name)!;
                expect(payload.tools.find(tool => tool.function.name === name)!.function).toMatchObject({ name, description: full.description, parameters: full.parameters });
            }
        }
        for (let i = 0; i < on.wire.length; i++) {
            const declarations = getCurrentSystemMessage(on.seen[i]! as never)!.toolsAdded!.map(({ name, description, parameters }) => ({ name, description, parameters }));
            expect(on.wire[i]!.tools.map(tool => ({ name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters }))).toEqual(declarations);
            expect(on.counted[i]).toBeGreaterThan(0);
        }
        for (const [priced, big] of [[true, false], [false, true]]) {
            const off = await run(false, priced, big), pass = await run(true, priced, big);
            expect(JSON.stringify(pass.wire)).toBe(JSON.stringify(off.wire));
            expect(lookup(pass.wire[0]!).description).toBe(description);
            expect(String(pass.wire[0]!.messages[0]!.content)).toContain("LOOKUP RULE:");
        }
        const switchedOff = await run(false);
        expect(lookup(switchedOff.wire[0]!).description).toBe(description);
    } finally {
        network.mockRestore();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        rmSync(dir, { recursive: true, force: true });
    }
}, 300000);
