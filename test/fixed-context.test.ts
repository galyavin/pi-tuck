import { expect, test } from "vitest";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { CONTRACT_MARK, decideFixedContext, failureBackstop, fixedContext, schemaWithoutDocs, type FixedContextInput } from "../src/fixed-context";
import { requestTokens, systemPart, type Messages } from "../src/budget";

const model = { api: "openai-completions", contextWindow: 32000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const tool = (name = "lookup") => ({ name, description: "Look up records. " + "Long documentation. ".repeat(1800),
    promptGuidelines: ["Use stable record identifiers."], parameters: { type: "object", additionalProperties: false, required: ["query"],
        properties: { query: { type: "string", description: "Search terms", minLength: 1, maxLength: 100 } } } });
const input = (): FixedContextInput => ({ model, reserve: 8000, prompt: "Full prompt", tools: [tool()], entries: [] });
const result = (id: string, error: boolean, name = "lookup", text = "result") => ({ type: "message", message: {
    role: "toolResult", toolName: name, toolCallId: id, isError: error, content: [{ type: "text", text }], timestamp: 0 } });

test("all three conditions are required independently, including every price field", () => {
    expect([...decideFixedContext(input()).thin]).toEqual(["lookup"]);
    for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
        const value = input(); value.model = { ...model, cost: { ...model.cost, [field]: 0.001 } };
        expect(decideFixedContext(value).tools).toBe(value.tools);
    }
    for (const changed of [{ ...model, api: "anthropic-messages" }, { ...model, contextWindow: 1000000 }]) {
        const value = { ...input(), model: changed };
        expect(decideFixedContext(value).tools).toBe(value.tools);
    }
    const value = { ...input(), reserve: model.contextWindow };
    expect(decideFixedContext(value).tools).toBe(value.tools);
    const small = { ...input(), tools: [{ ...tool(), description: "Small." }] };
    expect(decideFixedContext(small).tools).toBe(small.tools);
    const wire = JSON.stringify(small.tools.map(({ name, description, parameters }) => ({ type: "function", function: { name, description, parameters } })));
    const boundary = (small.prompt.length + wire.length) / 3.95 * 4;
    expect(decideFixedContext({ ...small, model: { ...model, contextWindow: Math.ceil(boundary) + small.reserve } }).thin.size).toBe(0);
    expect(decideFixedContext({ ...small, model: { ...model, contextWindow: Math.floor(boundary) + small.reserve } }).thin.size).toBe(1);
});

test("schema form preserves nested constraints, named properties and literal values", () => {
    const schema = { title: "Root", description: "Docs", $comment: "Docs", examples: [{}], type: "object", required: ["description"],
        properties: {
            description: { description: "A property with a documentation name", type: "string", pattern: "^id-", default: { description: "literal" } },
            legs: { type: "array", minItems: 1, maxItems: 3, uniqueItems: true, items: { type: "object", additionalProperties: false,
                properties: { id: { const: "main", title: "Docs" }, scope: { enum: [{ title: "literal" }], examples: ["Docs"] } }, required: ["id", "scope"] } },
        },
        patternProperties: { description: { type: "number", minimum: 1, maximum: 3, description: "Docs" } },
        $defs: { title: { anyOf: [{ type: "null", description: "Docs" }, { $ref: "#/$defs/other" }] } },
        dependentSchemas: { description: { allOf: [{ not: { const: false, description: "Docs" } }] } },
        dependencies: { description: ["title"], title: { type: "boolean", title: "Docs" } },
        if: { properties: { title: { const: { examples: ["literal"] } } } }, then: false, else: true,
        additionalProperties: { type: "array", prefixItems: [{ type: "string", title: "Docs" }], items: false },
    };
    const stripped = schemaWithoutDocs(schema) as typeof schema;
    expect(stripped).not.toHaveProperty("description");
    expect(stripped.properties.description).toEqual({ type: "string", pattern: "^id-", default: { description: "literal" } });
    expect(stripped.properties.legs.items).toEqual({ type: "object", additionalProperties: false,
        properties: { id: { const: "main" }, scope: { enum: [{ title: "literal" }] } }, required: ["id", "scope"] });
    expect(stripped.properties.legs).toMatchObject({ minItems: 1, maxItems: 3, uniqueItems: true });
    expect(stripped.patternProperties.description).toEqual({ type: "number", minimum: 1, maximum: 3 });
    expect(stripped.$defs.title.anyOf).toEqual([{ type: "null" }, { $ref: "#/$defs/other" }]);
    expect(stripped.dependencies).toEqual({ description: ["title"], title: { type: "boolean" } });
    expect(stripped.if).toEqual(schema.if);
    expect(schema.properties.description.description).toContain("property");
});

test("protected tools remain the exact full definitions; the owner's snippet wins", () => {
    const value = input();
    value.tools = [tool(), ...["read", "bash", "edit", "write", "tuck_recall", "tuck_search"].map(name => tool(name))];
    value.snippets = { lookup: "Owner's line. Includes coverage." };
    const decision = decideFixedContext(value);
    expect(decision.tools[0]!.description).toBe(value.snippets.lookup);
    for (let i = 1; i < value.tools.length; i++) expect(decision.tools[i]).toBe(value.tools[i]);
    expect(decideFixedContext(input()).tools[0]!.description).toBe("Look up records.");
});

test("backstop is branch-derived, per tool, permanent, and keeps only pre-restoration failure carriers", () => {
    const branch = [result("a", true), result("other", true, "other"),
        result("b", true), result("c", false), result("d", true)];
    expect([...failureBackstop(branch).full]).toEqual(["lookup"]);
    expect([...failureBackstop(branch).carriers]).toEqual(["a", "other"]);
    expect([...failureBackstop([result("a", true), result("b", false), result("c", true)]).full]).toEqual([]);
    expect([...failureBackstop(branch.slice(0, 2)).full]).toEqual([]); // fork before the second failure
    const value = { ...input(), entries: branch };
    expect(decideFixedContext(value).tools[0]).toBe(value.tools[0]);
    expect([...decideFixedContext({ ...input(), entries: JSON.parse(JSON.stringify(branch)) }).carriers]).toEqual(["a", "other"]); // resume
});

test("unknown shapes and exceptions fail open without partial changes", () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    const values = [
        { ...input(), model: undefined },
        { ...input(), model: { ...model, cost: { input: 0 } } },
        { ...input(), tools: [{ ...tool(), parameters: null }] },
        { ...input(), tools: [{ ...tool(), parameters: { properties: [] } }] },
        { ...input(), tools: [{ ...tool(), constrainedSampling: { type: "grammar" } }] },
        { ...input(), tools: [{ ...tool(), parameters: cyclic }] },
        { ...input(), tools: [{ ...tool(), get parameters() { throw Error("broken schema"); } }] },
        { ...input(), entries: [{ type: "message", message: { role: "toolResult" } }] },
    ];
    for (const value of values) {
        const decision = decideFixedContext(value as FixedContextInput);
        expect(decision.tools).toBe(value.tools);
        expect(decision.thin.size).toBe(0);
    }
});

test("eligibility is recomputed for each request, including a model becoming free during the run", () => {
    const definitions = [tool()], rules = definitions[0]!.promptGuidelines;
    const opts = { selectedTools: ["lookup"], skills: [], toolGuidelines: { lookup: rules }, toolSnippets: {} };
    const event = { get systemPrompt() { return `Full prompt\n<rules>\n${opts.toolGuidelines.lookup.join("\n")}\n</rules>`; }, systemPromptOptions: opts };
    const prompt = event.systemPrompt;
    const ctx = { model: { ...model, cost: { ...model.cost, input: 1 } }, getSystemPrompt: () => prompt, sessionManager: { getBranch: () => [] } };
    const fixed = fixedContext({ getAllTools: () => definitions, getActiveTools: () => ["lookup"] } as never, () => 8000, () => true);
    fixed.prepare(event as never, ctx as never);
    expect(opts.toolGuidelines.lookup).toBe(rules);
    const native = definitions.map(({ name, description, parameters }) => ({ name, description, parameters }));
    const messages: Messages = [{ role: "system", content: prompt, toolsAdded: native, timestamp: 0 }];
    expect(fixed.request(ctx as never, messages).messages).toBe(messages);
    ctx.model.cost.input = 0;
    const active = fixed.request(ctx as never, messages);
    expect(active.prompt).not.toContain(rules[0]);
    expect(active.messages[0]!.role === "system" && active.messages[0]!.toolsAdded![0]!.description).toBe("Look up records.");
    ctx.model.cost.input = 1;
    expect(fixed.request(ctx as never, messages).messages).toBe(messages);
});

test("every count uses the request's declaration JSON, also after restoration; notes preserve the prefix", () => {
    const definitions = [tool()], prompt = "Full system prompt", branch: unknown[] = [];
    const native = definitions.map(({ name, description, parameters }) => ({ name, description, parameters }));
    const pi = { getAllTools: () => definitions, getActiveTools: () => ["lookup"] };
    const ctx = { model, getSystemPrompt: () => prompt, sessionManager: { getBranch: () => branch } };
    const fixed = fixedContext(pi as never, () => 8000, () => true);
    const opts = { selectedTools: ["lookup"], skills: [], toolGuidelines: {}, toolSnippets: {} };
    fixed.prepare({ systemPrompt: prompt, systemPromptOptions: opts } as never, ctx as never);
    let previous: Messages = [];
    for (const failed of [0, 1, 2, 3]) {
        if (failed) branch.push(result(String(failed), true));
        const messages = [{ role: "system", content: prompt, toolsAdded: native, timestamp: 0 }, ...branch.map(entry => (entry as ReturnType<typeof result>).message)] as Messages;
        const outgoing = fixed.request(ctx as never, messages);
        const counted = fixed.view(ctx as never, prompt, ["lookup"], messages);
        const wireTools = outgoing.messages[0]!.role === "system" ? outgoing.messages[0]!.toolsAdded! : [];
        expect(JSON.stringify(counted.tools)).toBe(JSON.stringify(wireTools));
        expect(systemPart(counted.prompt, counted.tools, counted.messages, counted.prompt)).toBe(requestTokens([outgoing.messages[0]!], outgoing.prompt));
        expect(requestTokens(outgoing.messages, outgoing.prompt)).toBe(estimateTokens(outgoing.messages[0]!) + outgoing.messages.slice(1).reduce((n, message) => n + estimateTokens(message), 0));
        if (failed === 1) expect(JSON.stringify(outgoing.messages)).toContain(CONTRACT_MARK);
        if (failed >= 2) {
            expect(wireTools[0]!.description).toBe(definitions[0]!.description);
            expect(outgoing.messages.slice(1, previous.length)).toEqual(previous.slice(1));
            expect(JSON.stringify(outgoing.messages.at(-1))).not.toContain(CONTRACT_MARK);
        }
        expect(messages).not.toEqual(outgoing.messages); // only the request projection changes
        previous = outgoing.messages;
    }
    const original = [{ role: "system", content: prompt, toolsAdded: definitions, timestamp: 0 }] as Messages;
    const disabled = fixedContext(pi as never, () => 8000, () => false);
    expect(disabled.request(ctx as never, original).messages).toBe(original);
    const broken = fixedContext({ ...pi, getAllTools: () => { throw Error("broken"); } } as never, () => 8000, () => true);
    expect(() => broken.prepare({ systemPrompt: prompt, systemPromptOptions: opts } as never, ctx as never)).not.toThrow();
    expect(broken.request(ctx as never, original).messages).toBe(original);
});
