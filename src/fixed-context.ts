import { getCurrentSystemMessage, getSystemMessageText } from "@earendil-works/pi-ai";
import { convertToLlm, type BeforeAgentStartEvent, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Messages, ToolShape } from "./budget.js";

const PROTECTED = new Set(["read", "bash", "edit", "write", "tuck_recall", "tuck_search"]);
const DOC_KEYS = new Set(["description", "title", "examples", "$comment"]);
export const CONTRACT_MARK = "[fixed-context contract]";
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const textOf = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content)
    ? content.map(block => object(block) && typeof block.text === "string" ? block.text : "").join("") : "";

/** Only schema locations are traversed. Names in maps and literal values in const/enum/default remain data. */
export function schemaWithoutDocs(schema: unknown): unknown {
    if (typeof schema === "boolean") return schema;
    if (!object(schema)) throw new Error("Unexpected tool schema");
    const maps = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
    const singles = new Set(["additionalProperties", "unevaluatedProperties", "propertyNames", "contains", "not", "if", "then", "else", "additionalItems", "unevaluatedItems", "contentSchema"]);
    const arrays = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
    return Object.fromEntries(Object.entries(schema).filter(([key]) => !DOC_KEYS.has(key)).map(([key, value]) => {
        if (maps.has(key)) {
            if (!object(value)) throw new Error("Unexpected schema map");
            return [key, Object.fromEntries(Object.entries(value).map(([name, child]) => [name, schemaWithoutDocs(child)]))];
        }
        if (arrays.has(key) || (key === "items" && Array.isArray(value))) {
            if (!Array.isArray(value)) throw new Error("Unexpected schema alternatives");
            return [key, value.map(schemaWithoutDocs)];
        }
        if (singles.has(key) || key === "items") return [key, schemaWithoutDocs(value)];
        if (key === "dependencies") {
            if (!object(value)) throw new Error("Unexpected schema dependencies");
            return [key, Object.fromEntries(Object.entries(value).map(([name, child]) => [name, Array.isArray(child) ? child : schemaWithoutDocs(child)]))];
        }
        return [key, value];
    }));
}

/** Two consecutive errors of this tool restore it permanently on this branch. A success resets its streak. */
export function failureBackstop(entries: readonly unknown[]) {
    const streaks = new Map<string, number>(), full = new Set<string>(), carriers = new Set<string>();
    for (const entry of entries) {
        if (!object(entry) || entry.type !== "message") continue;
        const message = entry.message;
        if (!object(message)) throw new Error("Unexpected session message");
        if (message.role !== "toolResult") continue;
        const { toolName: name, toolCallId: id, isError } = message;
        if (typeof name !== "string" || typeof id !== "string" || typeof isError !== "boolean") throw new Error("Unexpected tool result");
        if (full.has(name)) continue;
        const streak = isError ? (streaks.get(name) ?? 0) + 1 : 0;
        streaks.set(name, streak);
        if (streak >= 2) full.add(name);
        else if (isError) carriers.add(id);
    }
    return { full, carriers };
}

interface Definition extends ToolShape { promptGuidelines?: string[]; constrainedSampling?: unknown }
const shortNames = (tools: readonly Definition[], full: ReadonlySet<string>) =>
    new Set(tools.filter(tool => !PROTECTED.has(tool.name) && !full.has(tool.name)).map(tool => tool.name));
interface Model { api: string; contextWindow: number; cost: { input: number; output: number; cacheRead: number; cacheWrite: number } }
export interface FixedContextInput {
    model: Model | undefined;
    reserve: number;
    prompt: string;
    tools: readonly Definition[];
    entries: readonly unknown[];
    snippets?: Record<string, string>;
}
export interface FixedContextDecision {
    tools: readonly Definition[];
    thin: ReadonlySet<string>;
    carriers: ReadonlySet<string>;
}
const firstSentence = (text: string) => (text.trim().match(/^[\s\S]*?[.!?](?=\s|$)/)?.[0] ?? text.trim()).replace(/\s+/g, " ");

/** The single eligibility/declaration decision, recomputed at every consumer. No decision or backstop is persisted. */
export function decideFixedContext(input: FixedContextInput): FixedContextDecision {
    const unchanged = { tools: input.tools, thin: new Set<string>(), carriers: new Set<string>() };
    try {
        const { model, reserve, prompt, tools, entries, snippets = {} } = input;
        if (!model || model.api !== "openai-completions" || !model.cost ||
            ![model.cost.input, model.cost.output, model.cost.cacheRead, model.cost.cacheWrite].every(cost => cost === 0)) return unchanged;
        if (typeof prompt !== "string" || !Number.isFinite(model.contextWindow) || !Number.isSafeInteger(reserve) || reserve < 0 ||
            !Array.isArray(tools) || !Array.isArray(entries)) return unchanged;
        const names = new Set<string>();
        for (const tool of tools) {
            if (!object(tool) || typeof tool.name !== "string" || names.has(tool.name) || typeof tool.description !== "string" ||
                !object(tool.parameters) || (tool.constrainedSampling !== undefined &&
                    (!object(tool.constrainedSampling) || tool.constrainedSampling.type !== "json_schema"))) return unchanged;
            names.add(tool.name);
        }
        // The prototype's calibration (3.95 chars/token), applied to full function JSON.
        const wire = tools.map(tool => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
        const room = model.contextWindow - reserve;
        if (!(room > 0) || (prompt.length + JSON.stringify(wire).length) / 3.95 <= 0.25 * room) return unchanged;
        const { full, carriers } = failureBackstop(entries);
        const thin = shortNames(tools, full);
        const declarations = tools.map(tool => thin.has(tool.name) ? {
            name: tool.name,
            description: snippets[tool.name] ? snippets[tool.name]!.replace(/\s+/g, " ").trim() : firstSentence(tool.description),
            parameters: schemaWithoutDocs(tool.parameters),
        } : tool);
        // Detect cycles, throwing getters, and non-JSON values before changing any request.
        JSON.stringify(declarations);
        return { tools: declarations, thin, carriers };
    } catch { return unchanged; }
}

/** Request-only projection. Pi's transcript and executable/validation schemas stay full. */
export function fixedContext(pi: ExtensionAPI, reserve: (ctx: ExtensionContext) => number, enabled: () => boolean) {
    // Prompt metadata only, never an eligibility flag or per-tool state. Pi rebuilds these options at each run.
    let promptView: { full: string; short: string; snippets: Record<string, string> } | undefined;
    const snippetsFrom = (prompt: string) => Object.fromEntries([...(prompt.match(/<tools>\n([\s\S]*?)\n<\/tools>/)?.[1] ?? "")
        .matchAll(/^- ([\w.-]+): ([^\n]*)$/gm)].map(match => [match[1]!, match[2]!]));
    const decide = (ctx: ExtensionContext, prompt: string, tools: readonly Definition[]) => {
        if (!enabled()) return { tools, thin: new Set<string>(), carriers: new Set<string>() };
        return decideFixedContext({ model: ctx.model, reserve: reserve(ctx), prompt, tools, entries: ctx.sessionManager.getBranch(),
            snippets: promptView?.full === prompt ? promptView.snippets : snippetsFrom(prompt) });
    };
    const prepare = (event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
        promptView = undefined;
        try {
            if (!enabled()) return;
            const opts = event.systemPromptOptions, full = event.systemPrompt;
            if (!object(opts) || !object(opts.toolGuidelines) || !object(opts.toolSnippets) || !Array.isArray(opts.skills)) return;
            const tools = pi.getAllTools().filter(tool => opts.selectedTools.includes(tool.name));
            // Render the possible short prompt independently of eligibility: a later request can switch model/price/window.
            const thin = shortNames(tools, failureBackstop(ctx.sessionManager.getBranch()).full), original = opts.toolGuidelines;
            // Render exactly the tools-only prototype's rules change, then restore the options. The final request applies it atomically
            // with the declarations, so an exception cannot leave a partly pruned prompt in the saved session.
            try {
                opts.toolGuidelines = Object.fromEntries(Object.entries(original).map(([name, rules]) => [name, thin.has(name) ? [] : rules]));
                promptView = { full, short: event.systemPrompt, snippets: { ...opts.toolSnippets } };
            } finally { opts.toolGuidelines = original; }
        } catch { promptView = undefined; }
    };
    const view = (ctx: ExtensionContext, prompt: string, names: Iterable<string>, messages: Messages) => {
        const selected = new Set(names);
        let tools: Definition[] = [];
        try {
            tools = pi.getAllTools().filter(tool => selected.has(tool.name));
            const current = getCurrentSystemMessage(convertToLlm(messages));
            const native = new Map(current?.toolsAdded?.map(tool => [tool.name, tool]));
            // getAllTools also contains owner rules/exposure/source metadata. Count only declarations, just as Pi's transcript does.
            const declarations = tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters,
                ...(native.get(tool.name)?.constrainedSampling === undefined ? {} : { constrainedSampling: native.get(tool.name)!.constrainedSampling }) }));
            const decision = decide(ctx, prompt, declarations);
            if (!decision.thin.size && !decision.carriers.size) return { prompt, tools, messages };
            const short = promptView?.full === prompt ? promptView.short : prompt;
            const projected: Messages = current && getSystemMessageText(current) === prompt ? [{ role: "system", content: short, timestamp: current.timestamp,
                toolsAdded: [...decision.tools] } as Messages[number], ...messages.filter(message => message.role !== "system")] : messages;
            return { prompt: short, tools: [...decision.tools], messages: notes(projected, decision, tools) };
        } catch { return { prompt, tools, messages }; }
    };
    const annotate = (ctx: ExtensionContext, messages: Messages) => {
        try {
            const tools = pi.getAllTools().filter(tool => pi.getActiveTools().includes(tool.name));
            return notes(messages, decide(ctx, ctx.getSystemPrompt(), tools), tools);
        } catch { return messages; }
    };
    const request = (ctx: ExtensionContext, messages: Messages) => {
        try {
            // Missing/changed prompt metadata is an unknown shape. Leave the entire request untouched.
            if (!promptView || promptView.full !== ctx.getSystemPrompt()) return { prompt: ctx.getSystemPrompt(), messages };
            const current = getCurrentSystemMessage(convertToLlm(messages));
            if (!current || getSystemMessageText(current) !== ctx.getSystemPrompt()) return { prompt: ctx.getSystemPrompt(), messages };
            const prompt = ctx.getSystemPrompt(), tools = current.toolsAdded ?? [];
            const decision = decide(ctx, prompt, tools);
            if (!decision.thin.size && !decision.carriers.size) return { prompt, messages };
            const short = promptView?.full === prompt ? promptView.short : prompt;
            const definitions = pi.getAllTools();
            const { sections: _, ...head } = current;
            // openai-completions sends the current prompt and tool set. Folding here lets the guard count those very declarations.
            const projected: Messages = [{ ...head, content: short, toolsAdded: [...decision.tools] } as Messages[number], ...messages.filter(message => message.role !== "system")];
            return { prompt: short, messages: notes(projected, decision, definitions) };
        } catch { return { prompt: ctx.getSystemPrompt(), messages }; }
    };
    const payload = (value: unknown, ctx: ExtensionContext) => {
        try {
            if (!promptView || promptView.full !== ctx.getSystemPrompt() || !object(value) || !Array.isArray(value.tools)) return;
            if (!value.tools.every(tool => object(tool) && tool.type === "function" && object(tool.function) && typeof tool.function.name === "string")) return;
            const names = new Set(value.tools.map(tool => tool.function.name));
            const tools = pi.getAllTools().filter(tool => names.has(tool.name));
            if (tools.length !== names.size) return;
            const decision = decide(ctx, ctx.getSystemPrompt(), tools);
            if (!decision.thin.size) return;
            // Pi adds strict:false during serialization. The prototype omits it on short declarations.
            return { ...value, tools: value.tools.map(tool => {
                if (!decision.thin.has(tool.function.name)) return tool;
                const { strict: _, ...fn } = tool.function;
                return { ...tool, function: fn };
            }) };
        } catch { return; }
    };
    const reset = () => { promptView = undefined; };
    return { prepare, view, request, payload, annotate, reset };
}

function notes(messages: Messages, decision: FixedContextDecision, definitions: readonly Definition[]): Messages {
    return messages.map(message => {
        if (message.role !== "toolResult" || PROTECTED.has(message.toolName) || !decision.carriers.has(message.toolCallId) || textOf(message.content).includes(CONTRACT_MARK)) return message;
        const tool = definitions.find(tool => tool.name === message.toolName);
        if (!tool) return message;
        if (!Array.isArray(message.content)) throw new Error("Unexpected tool result content");
        const rules = tool.promptGuidelines?.filter(Boolean) ?? [];
        const note = `\n\n${CONTRACT_MARK} The call to ${tool.name} failed. ${tool.name} was listed with a short definition to save context; here is its full contract. Fix the arguments by it and call again.\n\nDescription:\n${tool.description}\n\nParameters (JSON Schema):\n${JSON.stringify(tool.parameters)}` +
            (rules.length ? `\n\nRules:\n${rules.map(rule => `- ${rule}`).join("\n")}` : "");
        return { ...message, content: [...message.content, { type: "text" as const, text: note }] };
    });
}
