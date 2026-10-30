import { createSemanticRecall, budgetSemantic, type SemanticRecallController } from "./semantic-recall";
import { DIAGNOSTIC_BUILD, IncidentRecorder, attachReceipt, permittedEntries, receiptId, findReceiptEntry, type Receipt, type RecorderOptions } from "./diagnostics.js";
import { createHash } from "node:crypto";
import { exportSource } from "./source-export.js";
import { isDeepStrictEqual } from "node:util";
import { assertNativeToolRounds } from "./protocol.js";
import { projectedMessages } from "./omissions.js";
import { bandOf, chooseCut, conversationTokens, decideCut, gateCut, incomingEventTokens, incomingTokens, measurableConversationTokens, planningReserve, projectedConversationTokens, requestTokens, systemPart,
    type AgentMessage, type Messages, type Plan, type Target, type ToolShape } from "./budget.js";
import { isContextOverflow } from "@earendil-works/pi-ai";
import { convertToLlm, SessionManager, SettingsManager, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { RecallPolicy } from "./recall.js";
import { MAX_RECALL_CHARACTERS, MAX_RECALL_ENTRY_ID_CHARACTERS, MAX_RECALL_QUERY_CHARACTERS } from "./recall.js";

import { tuck, tuckDraft, tuckObservedDraft, tuckRecall } from "./tuck.js";
import { ImageRecallInput, historyImage, historyAround } from "./history-image.js";
import { eligibilityKey, eligibilityKeyMoved, memoizedEligibleSources } from "./eligibility-cache";

const query = Type.String({ minLength: 1, maxLength: MAX_RECALL_QUERY_CHARACTERS });
const entryId = Type.String({ minLength: 1, maxLength: MAX_RECALL_ENTRY_ID_CHARACTERS });
const paging = {
	offset: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_RECALL_CHARACTERS })),
};
const RecallInput = Type.Union([
    Type.Object({ entryId, outputPath: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    Type.Object({ index: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), outputPath: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    ImageRecallInput,
    Type.Object({ around: entryId, before: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })), after: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })) }, { additionalProperties: false }),
	Type.Object({ query }, { additionalProperties: false }),
	Type.Object({ continuation: Type.Object({
		query, throughEntryId: entryId,
		offset: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
	}, { additionalProperties: false }) }, { additionalProperties: false }),
	Type.Object({ entryId, query: Type.Optional(query), ...paging }, { additionalProperties: false }),
	Type.Object({ index: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), query: Type.Optional(query), ...paging }, { additionalProperties: false }),
	Type.Object(paging, { additionalProperties: false }),
]);
const SearchInput = Type.Object({query,priorResults:Type.Optional(Type.Array(Type.Object({entryId,sourceSha:Type.String({minLength:64,maxLength:64}),start:Type.Integer({minimum:0}),end:Type.Integer({minimum:0})},{additionalProperties:false}),{maxItems:20}))},{additionalProperties:false});
const reply = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });
class CapacityError extends Error {}
/** The most a seed or an overflow raise may set the calibration factor to. A paired reply's own ratio is not bounded by it. */
export const CALIBRATION_CEILING = 1.5;
/** How many recent paired replies (and overflow bounds, and the seed while it is among them) the calibration factor is the maximum of. */
export const CALIBRATION_WINDOW = 32;
/** Measured provider-input undercount by model, as "provider/id". An identity with no usable receipt of its own starts its window with this entry, which
 * ages out after CALIBRATION_WINDOW later entries; every other model starts at 1. Empty: an undercount of 1.18 once measured for openai/gpt-6.1-sol
 * was replayed reasoning, which the estimate now counts; with it counted, the first 32 requests of a real session measured at most 0.97. */
export const MEASURED_CALIBRATION: Readonly<Record<string, number>> = {};
/** The window of an identity with no usable receipt of its own: the model's measured undercount (at most CALIBRATION_CEILING), else 1. `key` is
 * `identityFor`'s [provider, api, id]. */
function initialWindow(key: string): number[] {
    try { const [provider, , id] = JSON.parse(key) as [string, string, string]; return [Math.min(MEASURED_CALIBRATION[`${provider}/${id}`] ?? 1, CALIBRATION_CEILING)]; } catch { return [1]; }
}
/** The calibration window a session starts with under accounting identity `key`: the newest compaction on the branch that carries this package's
 * receipt decides, and no older receipt is consulted. A receipt without the identity field (written before it existed) or from another identity gives `initialWindow`.
 * Otherwise its `calibrationWindow` (an array of 1..CALIBRATION_WINDOW finite numbers, oldest first) is the window, each entry clamped to
 * [0, CALIBRATION_CEILING]; without a valid one, the window is its `calibrationFactor` clamped to [1, CALIBRATION_CEILING] as one entry, else
 * `initialWindow`. A usable receipt of the identity's own wins over the measured seed, as a learned window replaces it: a Resume from a receipt
 * written before the seed existed, or after it aged out, starts at that receipt's window (as low as 1). Reads only; a malformed receipt never throws. */
export function seedWindow(branch: readonly SessionEntry[], key: string): number[] {
    for (let i = branch.length; i--;) {
        const entry = branch[i]!;
        const receipt = entry.type === "compaction" ? (entry.details as { diagnosticReceipt?: { settings?: Partial<Receipt["settings"]> } | null } | undefined)?.diagnosticReceipt : undefined;
        if (receipt === undefined) continue;
        const { calibrationIdentity, calibrationFactor, calibrationWindow } = receipt?.settings ?? {}, stored: unknown = calibrationWindow;
        if (calibrationIdentity !== key) return initialWindow(key);
        if (Array.isArray(stored) && stored.length >= 1 && stored.length <= CALIBRATION_WINDOW && stored.every(n => typeof n === "number" && Number.isFinite(n)))
            return stored.map(n => Math.min(Math.max(n, 0), CALIBRATION_CEILING));
        if (typeof calibrationFactor === "number" && Number.isFinite(calibrationFactor)) return [Math.min(Math.max(calibrationFactor, 1), CALIBRATION_CEILING)];
        return initialWindow(key);
    }
    return initialWindow(key);
}
export interface CompactionOptions {
 semanticRecall?: SemanticRecallController;
 /** Optional host-owned transient operator preference; handle operations never call back. */
 onSemanticSetting?: (enabled: boolean) => Promise<unknown>;
 semanticStatus?: () => unknown;
 diagnostics?: RecorderOptions;
	/** Optional estimated complete-input ceiling, separate from physical output reservation.
	 * The host owns final serialization/transport counting; this is not an exact wire-token cap. */
	activeInputTokens?: number | ((ctx: ExtensionContext) => number);
	/** The response reserve: the input room is the context window less this. By default the room never exceeds the window less the model's
	 * catalogue maximum output, because a transport may omit the output cap and the reply can then grow to that maximum. A host that knows its
	 * transport's behavior declares an exact reserve with `responseExact: true`, and the room is then the window less `response` exactly. */
	requestReserve?: (ctx: ExtensionContext) => { response: number; responseExact?: true };
	/** The exact messages the host's `context` hook adds to every final request beyond the saved conversation (for example a role
	 * view), in the form the hook injects them. Cut triggers, the cut planner and the post-cut checks count them with the same
	 * function that the complete-context guard counts the request with. Called once per decision, and again after the awaited cut
	 * of an incoming prompt. Omit it when the host injects nothing. */
	hostMessages?: (ctx: ExtensionContext) => AgentMessage[];
	settings?: SettingsManager;
	active?: () => boolean;
 recallPolicy?: RecallPolicy;
	assertAccess?: () => void;
	/** Host-owned rejection policy; an irrevocable host veto still requires host recovery. */
	fail?: (error: unknown) => void;
}

export async function installCompaction(pi: ExtensionAPI, options: CompactionOptions = {}) {
    const semantic = options.semanticRecall ?? createSemanticRecall();
    let semanticTransition: Promise<void> = Promise.resolve();
    let semanticRequest = 0;
    const semanticPending = new Set<Promise<unknown>>();
    const semanticProvider = (ctx: ExtensionContext) => () => memoizedEligibleSources(ctx, options.recallPolicy, access);
    const recorder = new IncidentRecorder(options.diagnostics);
    let proposalId: string | undefined;
    const observe = (ctx: ExtensionContext) => recorder.measureInline(() => {
        if (!active() || failure) return;
        if (!proposalId) return;
        const found = findReceiptEntry(ctx.sessionManager.getBranch(), proposalId);
        if (found) { recorder.capture("observed-entry", "current-native-branch-memory-not-durable", { entryId: found.id, diagnosticReceiptId: proposalId, details: found.type === "compaction" ? found.details : undefined }); recorder.cut(); proposalId = undefined; }
    });
    const captureDraft = (draft: NonNullable<ReturnType<typeof tuckDraft>["compaction"]>, ctx: ExtensionContext, reserve: number, reason: string, tokensBefore: number, retainCurrentInput: boolean, operatorManual: boolean, previousSummary?: string, budget?: { response: number; host: number; mandatory: number; target: Target; margin: number }) => recorder.measureInline(() => {
        const attached = attachReceipt(draft, reason, reserve, ctx.model?.contextWindow ?? 0, { responseReserveTokens: budget?.response, hostInputTokens: budget?.host, mandatoryInputTokens: budget?.mandatory, target: budget?.target, triggerMarginTokens: budget?.margin, calibrationFactor: factor, calibrationWindow: [...ratios], calibrationIdentity: identity, activeInputCeilingTokens: lastCeiling });
        proposalId = receiptId(attached);
        if (recorder.enabled) { try {
            const filtered = permittedEntries(ctx.sessionManager.getEntries(), options.recallPolicy);
            recorder.capture("replay-input", "reconstruction-from-existing-native-history", { build: DIAGNOSTIC_BUILD, receiptId: proposalId, entries: filtered.entries, branchEntryIds: ctx.sessionManager.getBranch().map(e => e.id), header: ctx.sessionManager.getHeader(), contextWindow: ctx.model?.contextWindow, reserve, tokensBefore, retainCurrentInput, operatorManual, previousSummary }, filtered.partial || Boolean(options.recallPolicy?.readAttemptMarker));
            recorder.capture("proposal", "selected-draft-not-saved", attached);
        } catch { recorder.stop("capture-failed-gap"); } }
        return attached;
    });
    pi.registerCommand("tuck-incident", { description: "Record this session's compaction decisions for a bug report: on, next, off, status", handler: async (args, ctx) => {
        const command = args.trim();
        if (command === "on" || command === "next") { access(); recorder.start(ctx.cwd, command === "next", status => ctx.ui.notify(status, "info")); }
        else if (command === "off") { recorder.stop("operator-cancelled"); }
        else if (command && command !== "status") ctx.ui.notify("Use /tuck-incident on|next|off|status", "warning");
        ctx.ui.notify(JSON.stringify(recorder.status()), "info");
    } });
    pi.on("session_compact", (_event, ctx) => observe(ctx));
    // A saved cut moves entries out of view: index them now, in the background, even for a session that has not searched or whose worker the idle limit stopped.
    pi.on("session_compact", (_event, ctx) => { semantic.indexAtCut(semanticProvider(ctx)); });
    pi.on("session_shutdown", async () => { semanticRequest++; recorder.stop("session-shutdown"); await semantic.close(); await Promise.allSettled([...semanticPending]); });
    pi.on("session_start", () => { semanticRequest++; semanticTransition = semantic.close();void semanticTransition.catch(error => { options.fail?.(error); }); });
    pi.on("turn_end", (_event,ctx) => { semantic.schedule(semanticProvider(ctx)); });
    const applySemanticEnabled = async (enabled: boolean, ctx: ExtensionContext) => {
        const request = ++semanticRequest;
        if (!enabled) { semanticTransition = semantic.disable(); await semanticTransition; return semantic.status(); }
        await semanticTransition;
        if (request !== semanticRequest) return semantic.status();
        access();
        if (!semantic.status().configured) await semantic.configureExternal(ctx.cwd);
        if (request !== semanticRequest) return semantic.status();
        access(); semantic.enable(); semantic.schedule(semanticProvider(ctx));
        return semantic.status();
    };
    const setSemanticEnabled = (enabled: boolean, ctx: ExtensionContext) => {
        const operation = applySemanticEnabled(enabled,ctx);
        semanticPending.add(operation);
        void operation.then(()=>semanticPending.delete(operation),()=>semanticPending.delete(operation));
        return operation;
    };
    const semanticStatus = () => ({local:semantic.status(),...(options.semanticStatus ? {host:options.semanticStatus()} : {})});
    pi.registerCommand("tuck-semantic", {description:"Semantic recall for this session: on, off or status. To turn it off everywhere, set \"semanticRecall\": false in pi-tuck.json in Pi's agent folder.",handler:async(args,ctx)=>{
        const command=args.trim();
        if (!["on","off","status"].includes(command)) { ctx.ui.notify("Use on, off or status","warning"); return; }
        const errors: string[] = [];
        if (command!=="status") {
            const enabled=command==="on";
            // Both owners start directly. Off must attempt every host handle even if this one fails.
            const operations=[setSemanticEnabled(enabled,ctx)];
            if(options.onSemanticSetting) operations.push(Promise.resolve().then(()=>options.onSemanticSetting!(enabled)).then(()=>semantic.status()));
            for(const result of await Promise.allSettled(operations)) if(result.status==="rejected") errors.push(String(result.reason));
        }
        ctx.ui.notify(JSON.stringify({...semanticStatus(),...(errors.length?{errors}:{})}),errors.length?"warning":"info");
    }});
    // Pi's native start/settled events bracket the run and its post-turn cuts.
    let admittedRun = false;
    // One serial request, one accounting identity; observations never certify new content. A new identity (the first request after a session
    // start, or a model switch) starts with the window its branch's newest receipt recorded for that identity, else that receipt's factor, else the model's measured undercount or 1 (`seedWindow`).
    let identity = "", factor = 1, ratios: number[] = [];
    let lastCeiling: number | null = null;
    let pending: { identity: string; tokens: number; messages: Parameters<typeof convertToLlm>[0]; snapshot: ReturnType<typeof convertToLlm> } | undefined;
    const identityFor = (ctx: ExtensionContext) => {
        const key = ctx.model ? JSON.stringify([ctx.model.provider, ctx.model.api, ctx.model.id]) : "";
        if (key !== identity) { identity = key; ratios = seedWindow(ctx.sessionManager.getBranch(), key); factor = Math.max(1, ...ratios); pending = undefined; }
        return key;
    };
    // The factor is max(1, the last CALIBRATION_WINDOW paired ratios, overflow bounds and seed): it rises at once and a stale high ratio ages out.
    const learn = (value: number) => { ratios.push(value); if (ratios.length > CALIBRATION_WINDOW) ratios.shift(); factor = Math.max(1, ...ratios); };
    const corrected = (tokens: number, ctx: ExtensionContext) => { identityFor(ctx); return Math.ceil(tokens * factor); };
    // The cut planner's raw reserve for the target limit, on the same factor as every other consumer.
    const planReserve = (target: Target, room: number, mandatory: number, ctx: ExtensionContext) => {
        identityFor(ctx);
        return planningReserve(ctx.model?.contextWindow ?? 0, target === "band" ? bandOf(room) : room, factor, mandatory);
    };
    pi.on("message_end", (event, ctx) => {
        if (event.message.role !== "assistant") return;
        const responseMessage = event.message;
        if (recorder.enabled && !recorder.waitingForCut) recorder.measureInline(() => {
            if (!responseMessage.content.some(b => b.type === "thinking")) recorder.capture("response-actions", "native-public-message-end", responseMessage);
            else recorder.capture("response-actions", "hidden-material-excluded", { stopReason: responseMessage.stopReason }, true);
            recorder.responded(responseMessage.stopReason);
        });
        const paired = pending; pending = undefined;
        const key = identityFor(ctx), message = event.message;
        const overflow = message.stopReason === "error" && isContextOverflow(message);
        if (!paired || !key || paired.identity !== key || !active() || failure || ctx.signal?.aborted || (message.errorMessage && !overflow) ||
            message.provider !== ctx.model?.provider || message.model !== ctx.model.id || message.api !== ctx.model.api ||
            (!overflow && !["stop", "toolUse", "length"].includes(message.stopReason)) ||
            !isDeepStrictEqual(convertToLlm(paired.messages), paired.snapshot)) return;
        // The provider refused this exact request for exceeding the window: its true count was at least window + 1, a lower bound on the ratio. A
        // bound above the ceiling says the estimate is not merely low, so it is not learned: the overflow ends the attempt as it does without it.
        if (overflow) { const candidate = (ctx.model.contextWindow + 1) / paired.tokens; if (candidate <= CALIBRATION_CEILING) learn(candidate); return; }
        const usage = message.usage;
        if (!usage) return;
        const counts = [usage.input, usage.cacheRead, usage.cacheWrite];
        if (!counts.every(n => Number.isSafeInteger(n) && n >= 0)) return;
        const input = counts.reduce((a, b) => a + b, 0), ratio = input / paired.tokens;
        if (input > 0 && Number.isSafeInteger(input) && Number.isFinite(ratio)) learn(ratio);
    });
    pi.on("agent_start", () => { admittedRun = true; pending = undefined; phase = "idle"; });
    pi.on("agent_settled", () => { admittedRun = false; pending = undefined; phase = "idle"; });
	const active = () => options.active?.() ?? true;
	const settingsFor = () => options.settings ?? SettingsManager.inMemory(pi.getSettings());
	// The standalone default reserves the model's catalogue maximum output: a transport may omit the output cap, and then only that
	// reserve keeps input plus any reply inside the window.
	const reserveFor = (ctx: ExtensionContext) => Math.max(
		settingsFor().getCompactionSettings(ctx.model).reserveTokens, ctx.model?.maxTokens ?? 0);
	// The one place the response reserve is decided; every consumer takes its room from here. A host that knows how its transport caps
	// a reply declares an exact reserve (`responseExact: true`) and is held to it; without that flag the catalogue maximum is the floor.
	const requestReserve = (ctx: ExtensionContext) => {
        const budget: { response: number; responseExact?: true } = options.requestReserve?.(ctx) ?? { response: reserveFor(ctx) };
        if (!Number.isSafeInteger(budget.response) || budget.response < 0)
            throw new Error("Invalid host request reserve");
        return { response: budget.responseExact === true ? budget.response : Math.max(budget.response, ctx.model?.maxTokens ?? 0) };
    };
    const inputRoom = (response: number, ctx: ExtensionContext) => {
        const configured = options.activeInputTokens;
        const ceiling = typeof configured === "function" ? configured(ctx) : configured;
        lastCeiling = ceiling ?? null;
        if (ceiling !== undefined && (!Number.isSafeInteger(ceiling) || ceiling <= 0))
            throw new Error("Invalid active-input token ceiling");
        return Math.min((ctx.model?.contextWindow ?? 0) - response, ceiling ?? Infinity);
    };
    // The exact room, and the band a cut is triggered at (budget.ts); every throw and every fault uses the exact room.
    const limits = (ctx: ExtensionContext) => {
        const { response } = requestReserve(ctx), room = inputRoom(response, ctx);
        return { response, room, band: bandOf(room) };
    };
    const fits = (tokens: number, limit: number, ctx: ExtensionContext) => corrected(tokens, ctx) < limit;
    // The saved conversation and a cut's quantities are counted by the one function the guard counts with (strict, as the context hook is).
    const measureFor = (ctx: ExtensionContext) => (messages: Messages) => projectedConversationTokens(messages, ctx, options.recallPolicy);
    // The planner counts with the same function, except that it does not fail on a summary in another format: a cut can replace one
    // (an operator's /compact repairs a session whose saved summary is foreign). Identical to the strict one for this compactor's summaries.
    const plannerMeasureFor = (ctx: ExtensionContext) => (messages: Messages) => measurableConversationTokens(messages, ctx, options.recallPolicy);
    const hostTokens = (ctx: ExtensionContext) => options.hostMessages ? conversationTokens(options.hostMessages(ctx)) : 0;
    const toolShapes = (names: Iterable<string>): ToolShape[] => {
        const selected = new Set(names);
        return pi.getAllTools().filter(tool => selected.has(tool.name)).map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
    };
    // Pi reports a manual cut with nothing to do as a failed compaction; the thrown error lacks the event's "Compaction failed: " prefix.
    const isNoWork = (message: string | undefined) => ["Already compacted", "Nothing to compact (session too small)"].includes(message?.replace(/^Compaction failed: /, "") ?? "");
    // A missing model is configuration, not capacity.
    const missingModel = () => new Error("No context model for the request budget");
    // Scoped to one awaited initial-prompt cut; never a persisted controller. It carries that decision's snapshot.
    let pendingCut: { mandatory: number; before: number; host: number; opportunistic: boolean; proposed: boolean } | undefined;
    let failure: Error | undefined;
    let pendingBoundaryCommit = false;
	const fail = (error: unknown, ctx: ExtensionContext) => {
		recorder.stop("native-attempt-failed");
        const notify = !failure && error instanceof CapacityError;
		failure = error instanceof Error ? error : new Error(String(error));
        pendingBoundaryCommit = false;
        pending = undefined;
		try { options.fail?.(error); } finally {
            try { if (notify) ctx.ui.notify(failure.message + "; shorten the input, use a model with a larger window, or lower Pi's compaction.reserveTokens, then retry.", "error"); }
            finally { ctx.abort(); }
        }
	};
	const access = () => {
		if (failure) throw failure;
		if (!active()) throw new Error("Compaction host is inactive");
		options.assertAccess?.();
	};
    // Abort alone is insufficient: Pi starts a fresh abort controller after
    // before_agent_start. Keep this attempt blocked, then recheck on new idle input.
    // "decided": `input` has decided for the run it starts, so that run's before_agent_start does not decide again. "starting": a run is
    // between before_agent_start and agent_start, where Pi 1.1 still reports idle but a message joins that run.
    let phase: "idle" | "decided" | "starting" = "idle";
    pi.on("input", async (event, ctx) => {
        if (!ctx.isIdle() || phase === "starting") return; // a steering or follow-up message joins the running request
        if (failure instanceof CapacityError) failure = undefined;
        phase = "decided";
        try { await preflight(ctx, incomingTokens(event.text, event.images), ctx.getSystemPrompt(), pi.getActiveTools()); }
        catch (error) { fail(error, ctx); }
    });
	pi.registerTool({
		name: "tuck_recall", label: "pi-tuck history", parameters: RecallInput,
        description: "Keyword lookup locates particular text in your current branch. {query} returns ranked passages with read coordinates; punctuation separates words. Pass the returned next as {continuation} unchanged. Use tuck_search for historical information relevant to a question, including different wording and qualifications. Knowing an identifier does not itself justify narrowing discovery. {entryId} or {index} (a summary sourceIndex or #N) reads one source, optionally with query, offset and limit in UTF-16 characters (limit defaults to 8000). {} browses history; {around} expands neighbors; {entryId,image} reads an image; outputPath writes an original to a file with the native write tool. Hidden reasoning and system records are excluded.",
		async execute(_id, raw, signal, _update, ctx) {
			access();
            const input = checkedInput(raw);
            recorder.capture("recall-action", "authorized-native-tool-invocation-no-result-copy", input);
            const branch = ctx.sessionManager.getBranch();
            if ("outputPath" in input) {
                if (signal?.aborted) throw new Error("Source export cancelled before write");
                const source = exportSource(ctx.sessionManager.getEntries(), branch, input, options.recallPolicy);
                if (!source) return { ...reply({ status: "not_found", notice: "No unique eligible original readable source on this branch; no write requested." }), isError: true };
                const outcome = await ctx.executeTool("write", { path: input.outputPath, content: source.text }, { signal });
                return { ...reply({ status: outcome.isError ? "write_failed" : "write_completed", entryId: source.entryId,
                    index: source.index ?? null, role: source.role, sourceTime: source.sourceTime,
                    ...(source.stopReason !== undefined ? { stopReason: source.stopReason } : {}), outputPath: input.outputPath,
                    sourceCharacters: source.text.length, sourceUtf8Bytes: Buffer.byteLength(source.text, "utf8"),
                    sourceSha256: createHash("sha256").update(source.text, "utf8").digest("hex"),
                    notice: "Exact recorded readable text, not fresh evidence or unrecorded bytes. Source hash describes supplied text; native write completion does not independently verify an arbitrary writer's physical file. A failed write may have partial effects." }), isError: outcome.isError };
            }
            if ("image" in input) return historyImage(branch, input, options.recallPolicy);
            if ("around" in input) return reply(historyAround(branch, input, options.recallPolicy));
            return reply(tuckRecall(tuck, ctx.sessionManager.getEntries(), branch, input, options.recallPolicy));
		},
	});
    pi.registerTool({name:"tuck_search",label:"History search",parameters:SearchInput,
        description:"Find historical information relevant to a question, including different wording and related qualifications. Combines keyword and local embedding search. Knowing a name or identifier does not imply keyword-only lookup is sufficient. Returns original evidence up to 20000 characters; not exhaustive. Semantic search may be off or incomplete, which is not the same as no matches. Read exact originals and their context with tuck_recall at the returned locators. priorResults lists source ranges already read.",
        async execute(_id,raw,signal,_update,ctx){
            access();if(!Check(SearchInput,raw))throw new Error("Invalid broad search input");const input=structuredClone(raw);
            recorder.capture("recall-action","authorized-native-tool-invocation-no-result-copy",input);
            // Bind the actual independent lexical offer, including attribution derived
            // from custom markers and receipts excluded from semantic indexing. Rebuild
            // under current caller policy after await, when the session moved; never send this block to the encoder.
            const wordOffer=()=>tuckRecall(tuck,ctx.sessionManager.getEntries(),ctx.sessionManager.getBranch(),{query:input.query},options.recallPolicy);
            // The key is taken in the same synchronous step as the first lexical pass. After the await the second pass runs only if it moved (see eligibilityKey); a moved key alone invalidates nothing.
            // The snapshot id check covers every in-contract change (any branch change moves the id); the key-gated second pass is defence in depth for out-of-contract callers.
            const provider=semanticProvider(ctx),initialSnapshot=provider(),initialKey=eligibilityKey(ctx),words=wordOffer(),wordText=JSON.stringify(words);
            const related=await semantic.search(input.query,provider,signal,input.priorResults??[],words);
            access();if(signal?.aborted)throw Object.assign(new Error('Semantic recall cancelled'),{name:'AbortError'});const now=provider();
            if(initialSnapshot.id!==now.id||(eligibilityKeyMoved(ctx,initialKey)&&wordText!==JSON.stringify(wordOffer())))return{...reply({status:"snapshot_invalidated",notice:"Search source eligibility or version changed; no earlier evidence delivered. Request a fresh query."}),isError:true};
            const page=budgetSemantic(related,20000-wordText.length-1);
            return{content:[{type:"text" as const,text:wordText},{type:"text" as const,text:JSON.stringify(page)}],details:{semantic:{status:page.status,snapshotId:page.coverage.snapshotId}}};
        }});

	pi.on("session_before_compact", (event, ctx) => {
		try {
			if (!active()) return { cancel: true };
			if (event.signal.aborted || ctx.signal?.aborted) { recorder.stop("cut-cancelled"); return { cancel: true }; }
            // Pi also labels the awaited idle incoming preflight "manual".
            const incoming = pendingCut;
            const operatorManual = event.reason === "manual" && !(incoming && !admittedRun);
            if (operatorManual && !admittedRun && failure instanceof CapacityError) failure = undefined;
			access();
			if (event.customInstructions?.trim()) {
				recorder.stop("no-cut-custom-instructions");
                ctx.ui.notify("pi-tuck does not accept summarization instructions; use /compact without arguments.", "warning");
				return { cancel: true };
			}
            const { response, room, band } = limits(ctx);
            const retain = operatorManual || admittedRun;
            // The incoming-prompt preflight brings its own snapshot. Any other cut (operator manual, Pi's threshold or overflow
            // recovery) charges what the request must carry whatever is cut: the system part and the host input.
            const saved = ctx.sessionManager.buildSessionProjection().messages;
            const host = incoming ? incoming.host : hostTokens(ctx);
            const mandatory = incoming ? incoming.mandatory
                : systemPart(ctx.getSystemPrompt(), toolShapes(pi.getActiveTools()), saved, ctx.getSystemPrompt()) + host;
            const before = incoming ? incoming.before : plannerMeasureFor(ctx)(saved);
            // Pi's own usage threshold (reason "threshold") counts the last reply's output tokens, reasoning included, plus the messages after
            // it: a basis this compactor does not plan on. It may ask for a cut on a request that fits. This compactor cuts only where its own
            // trigger would: nothing below the band, an opportunistic cut inside it, a due cut at or above the room. A refusal is a plain
            // cancel (Pi reports it as aborted), never a failure.
            let thresholdOpportunistic = false;
            if (!incoming && event.reason === "threshold") {
                const gate = gateCut({ total: before + mandatory, mandatory, room, band, fits: (tokens, limit) => fits(tokens, limit, ctx) });
                if (gate.kind !== "plan") return { cancel: true };
                thresholdOpportunistic = gate.opportunistic;
            }
            // Pi checks old history before appending a new idle prompt. During an active run/manual cut the latest admitted input stays protected.
            const decision = chooseCut({
                before, mandatory, room, band, fits: (tokens, limit) => fits(tokens, limit, ctx),
                opportunistic: incoming?.opportunistic ?? thresholdOpportunistic,
                unreduced: incoming ? "Incoming Pi preflight compaction did not reduce context within the estimated request budget"
                    : "Compaction did not reduce context within the estimated request budget",
                plan: (target): Plan<{ compaction: NonNullable<ReturnType<typeof tuckDraft>["compaction"]>; reserve: number }> => {
                    const reserve = planReserve(target, room, mandatory, ctx);
                    const draft = tuckDraft(tuck, event, ctx, reserve, plannerMeasureFor(ctx), options.recallPolicy, retain, operatorManual);
                    return draft.compaction ? { draft: true, after: draft.after, mode: draft.mode, compaction: draft.compaction, reserve }
                        : { draft: false, capacityRejected: Boolean(draft.capacityRejected), reason: draft.unavailable };
                },
            });
            if (decision.kind === "cut") { if (incoming) incoming.proposed = true; return { compaction: captureDraft(decision.plan.compaction, ctx, decision.plan.reserve, event.reason, event.preparation.tokensBefore,
                retain, operatorManual, event.preparation.previousSummary, { response, host, mandatory, target: decision.target, margin: room - band }) }; }
            // An opportunistic cut inside the band that cannot reach it is no fault: the request goes to the guard.
            if (decision.kind === "none") return { cancel: true };
			recorder.stop("no-cut");
            ctx.ui.notify(decision.message, "warning");
			if (!operatorManual) fail(decision.capacity ? new CapacityError(decision.message) : new Error(decision.message), ctx);
			return { cancel: true };
		} catch (error) {
			try { fail(error, ctx); } finally { return { cancel: true }; }
		}
	});
	pi.on("session_before_tree", (event) => event.preparation.userWantsSummary ? { cancel: true } : undefined);
    pi.on("session_start", () => { recorder.stop("session-transition"); proposalId = undefined; failure = undefined; admittedRun = false; pendingBoundaryCommit = false; identity = ""; factor = 1; pending = undefined; phase = "idle"; });
    // The cut before a run. Pi 1.4 counts a run as started before before_agent_start, and ctx.compact() first aborts and waits for an
    // idle session, so a cut asked for there would wait on its own run. A prompt's cut is therefore made on `input`, while the session
    // is idle. before_agent_start decides only for a run no input started (one a custom message starts) and cuts only if the session is
    // still idle (Pi 1.1); otherwise it declines an opportunistic cut and fails a needed one closed.
    const preflight = async (ctx: ExtensionContext, incomingPart: number, observedPrompt: string, tools: readonly string[]) => {
        if (!active()) return;
        access();
        if (!settingsFor().getCompactionSettings(ctx.model).enabled) return;
        if (!ctx.model) throw missingModel();
        const { room, band } = limits(ctx);
        // Public early view only: later handlers, image normalization and tool-loop growth remain the complete-context
        // guard's responsibility. One snapshot per decision, taken again after the awaited cut.
        const snapshot = () => {
            const saved = ctx.sessionManager.buildSessionProjection().messages;
            const system = systemPart(observedPrompt, toolShapes(tools), saved, ctx.getSystemPrompt());
            const host = hostTokens(ctx);
            const before = measureFor(ctx)(saved);
            return { incoming: incomingPart + system, host, before, mandatory: incomingPart + system + host };
        };
        const first = snapshot(), total = first.before + first.mandatory;
        if (!fits(first.incoming, room, ctx))
            throw new CapacityError("Incoming Pi prompt and response reserve cannot fit the estimated request budget");
        // A cut removes only conversation. If the mandatory request, host input included, does not fit by itself, no cut can
        // help: leave it to the complete-context guard, which fails closed.
        const gate = gateCut({ total, mandatory: first.mandatory, room, band, fits: (tokens, limit) => fits(tokens, limit, ctx) });
        if (gate.kind !== "plan") return;
        if (!ctx.isIdle()) {
            if (gate.opportunistic) return;
            throw new CapacityError("The request needs a cut that Pi cannot make once the run has started");
        }
        const cut = pendingCut = { mandatory: first.mandatory, before: first.before, host: first.host, opportunistic: gate.opportunistic, proposed: false };
        try {
            // CompactOptions callbacks are Pi's supported terminal completion surface.
            await new Promise<void>((resolve, reject) => ctx.compact({ onComplete: () => resolve(),
                onError: error => {
                    // An opportunistic cut is not needed to send the request, which is below the room: the guard decides. However it ends (the
                    // planner declined it, Pi had nothing to compact, an earlier handler cancelled it) it is no fault, unless a failure is latched
                    // or the compactor proposed a cut that then failed to commit (the session may hold what the file lacks).
                    if (cut.opportunistic && !failure && !cut.proposed) resolve();
                    else reject(error.message === "Compaction cancelled" && failure instanceof CapacityError ? failure : error);
                } }));
        } finally { pendingCut = undefined; }
        access();
        // The cut awaited: take the snapshot again. An opportunistic cut never throws; the request is not over the room, and the guard decides.
        const next = snapshot(), after = next.before + next.mandatory, afterFits = fits(after, limits(ctx).room, ctx);
        if (!cut.opportunistic && (after >= total || !afterFits))
            throw new (afterFits ? Error : CapacityError)("Incoming Pi preflight compaction did not reduce context within the estimated request budget");
    };
    pi.on("before_agent_start", async (event, ctx) => {
        const prompted = phase === "decided";
        phase = "starting";
        try {
            if (prompted) access(); // decided on input; a failure latched there still stops the run
            else await preflight(ctx, incomingEventTokens(event), event.systemPrompt, event.systemPromptOptions.selectedTools);
        } catch (error) { fail(error, ctx); }
    });
    pi.on("turn_end", (event, ctx) => {
        try {
            if (!active() || !admittedRun || event.outcome !== "completed" || ctx.signal?.aborted ||
                !event.context.canContinue || !event.toolResults.length || !settingsFor().getCompactionSettings(ctx.model).enabled) return;
            access();
            // Earlier boundary drafts have a public preview but no original-source compiler
            // contract. Preserve them and leave admission to the final guard.
            if (event.entries.length || !isDeepStrictEqual(event.context.contextMessages,
                ctx.sessionManager.buildSessionProjection().messages)) return;
            if (!ctx.model) return;
            const { response, room, band } = limits(ctx);
            const measure = measureFor(ctx), saved = event.context.contextMessages;
            // One snapshot per decision. Messages queued for the next request (steering, follow-ups) are in that request but not in the
            // saved conversation. Pi's peek returns the steering queue, else the follow-up queue; a follow-up is not in the very next
            // request while tools still run, so it can be counted early: conservative, and nothing else would cut at that later boundary.
            const system = systemPart(ctx.getSystemPrompt(), toolShapes(pi.getActiveTools()), saved, ctx.getSystemPrompt());
            const host = hostTokens(ctx);
            const queued = event.context.pendingMessages.length ? conversationTokens(event.context.pendingMessages as Messages) : 0;
            const mandatory = system + host + queued;
            const before = measure(saved);
            const previousSummary = saved.find(message => message.role === "compactionSummary")?.summary;
            const decision = decideCut({
                total: before + mandatory, mandatory, before, room, band, fits: (tokens, limit) => fits(tokens, limit, ctx),
                unreduced: "Tool-loop preflight compaction did not reduce context within the estimated request budget",
                plan: (target): Plan<{ compaction: NonNullable<ReturnType<typeof tuckObservedDraft>["compaction"]>; reserve: number }> => {
                    const reserve = planReserve(target, room, mandatory, ctx);
                    const draft = tuckObservedDraft(tuck, { branchEntries: ctx.sessionManager.getBranch(), tokensBefore: before, previousSummary }, ctx, reserve, plannerMeasureFor(ctx), options.recallPolicy, true);
                    if (!draft.compaction) return { draft: false, capacityRejected: Boolean(draft.capacityRejected), reason: draft.unavailable };
                    const header = ctx.sessionManager.getHeader();
                    if (!header) throw new Error("Missing native session header at tool-loop boundary");
                    const preview = SessionManager.inMemory(ctx.cwd, undefined, [header, ...ctx.sessionManager.getBranch()]);
                    preview.appendCompaction(draft.compaction.summary, draft.compaction.firstKeptEntryId, before, draft.compaction.details, true);
                    const messages = preview.buildSessionProjection().messages;
                    assertNativeToolRounds(messages);
                    return { draft: true, after: measure(messages), mode: draft.mode, compaction: draft.compaction, reserve };
                },
            });
            if (decision.kind === "fault") throw new (decision.capacity ? CapacityError : Error)(decision.message);
            if (decision.kind !== "cut") return;
            const compaction = captureDraft(decision.plan.compaction, ctx, decision.plan.reserve, "tool-loop", before, true, false, previousSummary,
                { response, host, mandatory, target: decision.target, margin: room - band });
            pendingBoundaryCommit = true;
            return { entries: [{ type: "compaction" as const, summary: compaction.summary,
                firstKeptEntryId: compaction.firstKeptEntryId, details: compaction.details }] };
        } catch (error) { fail(error, ctx); }
    });
    pi.on("context", (event, ctx) => {
        try {
            if (!active()) return;
            access();
            return { messages: projectedMessages(event.messages, ctx, options.recallPolicy) };
        } catch (error) { try { fail(error, ctx); } finally { return { messages: [] }; } }
    });
	pi.on("session_compact_failed", (event, ctx) => {
        // The end of an opportunistic cut that proposed nothing, however it came about, is no event for the recorder or for failure handling;
        // a latched failure still is, and so is the failure of a cut the compactor proposed.
        if (pendingCut?.opportunistic && !failure && !pendingCut.proposed) return;
        // This compactor's own refusal of a Pi threshold ask (the gate, or an opportunistic cut that cannot reach the band) reaches here as a
        // threshold compaction cancelled and not from an extension: no event for the recorder.
        if (event.reason === "threshold" && event.aborted && !event.fromExtension) return;
        // Pi's one compact-and-retry for a context overflow or a recoverable length stop was already used (the extension was not consulted):
        // not a compactor failure. The run ends with the provider's own error or length message, which the host's attempt handling owns.
        // Classified by the event's fields alone. No fail() and no abort: an abort would end the run as aborted and hide that message.
        const exhausted = event.reason === "overflow" && !event.aborted && !event.fromExtension;
        recorder.stop(exhausted ? "pi-recovery-exhausted" : event.aborted ? "cut-cancelled" : "cut-failed"); proposalId = undefined;
		if (exhausted) return;
		// Pi reports manual no-work as failures; an accepted pi-tuck draft cannot be a no-op.
		if (event.reason === "manual" && !event.fromExtension && !event.aborted && isNoWork(event.errorMessage)) return;
		if (active() && !event.aborted) fail(new Error(event.errorMessage ?? "Compaction failed"), ctx);
	});
    pi.on("agent_before_settle", (event, ctx) => {
        if (!pendingBoundaryCommit) return;
        if (event.outcome === "error") fail(new Error("Native tool-loop boundary draft remained unconfirmed at error settlement"), ctx);
        else pendingBoundaryCommit = false;
    });
	pi.on("context_with_system", (event, ctx) => {
        // Reaching the next request boundary proves native commit returned, not durable storage.
        pendingBoundaryCommit = false;
        pending = undefined;
		try {
			if (!active()) return;
			access();
            observe(ctx);
			assertNativeToolRounds(event.messages);
			if (!ctx.model) throw missingModel();
			// The complete request, counted after Pi's conversion (summary/custom/bash envelopes), with the effective system once.
			// Pi applies a forced prompt after this hook; the public prompt already observes it.
            const tokens = requestTokens(event.messages, ctx.getSystemPrompt());
			if (!fits(tokens, limits(ctx).room, ctx))
				throw new CapacityError("Complete Pi context and response reserve exceed the estimated request budget");
            if (recorder.enabled && !recorder.waitingForCut) recorder.measureInline(() => {
                recorder.request();
                // No system prompt or hidden assistant blocks; no provider payload/headers.
                const permitted = event.messages.filter(m => m.role !== "system" &&
                    !(m.role === "assistant" && m.content.some(b => b.type === "thinking")) &&
                    !(m.role === "custom" && options.recallPolicy?.privateCustomTypes?.includes(m.customType)));
                recorder.capture("prepared-request", "public-context-with-system-hook-before-later-transforms-not-wire", { messages: permitted, estimatedInputTokens: tokens }, permitted.length !== event.messages.length);
            });
            if (tokens > 0 && Number.isSafeInteger(tokens)) pending = {
                identity: identityFor(ctx), tokens, messages: event.messages, snapshot: structuredClone(convertToLlm(event.messages)),
            };

		} catch (error) { fail(error, ctx); }
	});
    return {close:async()=>{semanticRequest++;recorder.stop("caller-close");await semantic.close();await Promise.allSettled([...semanticPending]);}, semanticRecall:semantic, setSemanticEnabled, semanticStatus};
}

function checkedInput(raw: unknown) { if (!Check(RecallInput, raw)) throw new Error("Invalid recall input"); return structuredClone(raw); }
