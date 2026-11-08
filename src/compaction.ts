import { createSemanticRecall, budgetSemantic, type SemanticRecallController } from "./semantic-recall";
import { DIAGNOSTIC_BUILD, IncidentRecorder, attachReceipt, permittedEntries, receiptId, findReceiptEntry, type Receipt, type RecorderOptions } from "./diagnostics.js";
import { createHash } from "node:crypto";
import { exportSource } from "./source-export.js";
import { isDeepStrictEqual } from "node:util";
import { assertNativeToolRounds } from "./protocol.js";
import { projectedMessages } from "./omissions.js";
import { applyClips, clipBudgets, clipFor, type Clip } from "./clip.js";
import { DEFAULT_CUT_AT, bandOf, chooseCut, conversationTokens, gateCut, incomingEventTokens, incomingTokens, measurableConversationTokens, planningReserve, projectedConversationTokens, systemPart, validCutAt,
    type AgentMessage, type Messages, type Plan, type Target, type ToolShape } from "./budget.js";
import { getCurrentSystemMessage, isContextOverflow, type ImageContent, type ToolResultMessage } from "@earendil-works/pi-ai";
import { calculateContextTokens, convertToLlm, estimateTokens, shouldCompact, SessionManager, SettingsManager, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { RecallPolicy } from "./recall.js";
import { MAX_RECALL_CHARACTERS, MAX_RECALL_ENTRY_ID_CHARACTERS, MAX_RECALL_QUERY_CHARACTERS } from "./recall.js";

import { tuck, tuckDraft, tuckObservedDraft, tuckRecall } from "./tuck.js";
import { ImageRecallInput, historyImage, historyAround } from "./history-image.js";
import { eligibilityKey, eligibilityKeyMoved, memoizedEligibleSources } from "./eligibility-cache";
import { applyHistoryTools, hasTuckCut, historyToolDeclarations, historyToolNames, stageHistoryTools } from "./history-tools.js";

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
const SearchInput = Type.Object({query,priorResults:Type.Optional(Type.Array(Type.Object({sourceSha:Type.String({minLength:64,maxLength:64}),read:Type.Object({entryId,offset:Type.Integer({minimum:0}),limit:Type.Integer({minimum:0})},{additionalProperties:false})},{additionalProperties:false}),{maxItems:20}))},{additionalProperties:false});
const reply = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });
/** The compactor's verdict that this attempt cannot be made: the cut it needs cannot be made, or the request cannot fit. Like every failure but
 * a `CommitFault`, it ends with its attempt (`forgetFailure`), and the next attempt plans afresh from the session as it is. */
class Refusal extends Error {}
/** A cut this compactor supplied that Pi then failed to commit. Pi appends a cut to the session in memory before it writes the file, so the
 * session may hold a cut its file lacks; what is written after would build on it. The one failure that stays until the session restarts. */
class CommitFault extends Error {}
/** A refusal for want of room, which the user can remedy: it carries advice. */
class CapacityError extends Refusal {}
/** What a capacity refusal tells the operator. When the provider has counted far more input than pi-tuck's estimate, the refusal most
 * likely comes from that counting (an upstream behind a router can spend much more context on tool schemas), so the notice says so. */
export const refusalNotice = (message: string, factor: number): string =>
    message + "; shorten the input, use a model with a larger window, or lower Pi's compaction.reserveTokens, then retry." +
    (factor >= 1.5 ? ` This provider has counted up to ${factor.toFixed(1)}x the input pi-tuck estimates; through a router such as OpenRouter, a different upstream may count less.` : "");
/** What the operator hears when the provider refuses a request pi-tuck admitted as over its window: the bound that reply puts on the counting, and
 * what pi-tuck did with it. A bound pi-tuck cannot carry (above the ceiling) says so rather than implying the next request is planned at it. */
export const overflowNotice = (contextWindow: number, bound: number, learned: boolean): string =>
    `pi-tuck: the provider refused this request as over its ${contextWindow}-token window, so the input counted at least ${bound.toFixed(2)}x what pi-tuck estimated` +
    (learned ? "; the next request is planned at that." : "; too far out to be a low estimate, so the factor is unchanged.");
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
 /** Whether `tuck_search` exists: false where semantic recall cannot run (off Apple silicon), so the model is offered word recall only. */
 search?: boolean;
 /** Optional host-owned transient operator preference; handle operations never call back. */
 onSemanticSetting?: (enabled: boolean) => Promise<unknown>;
 semanticStatus?: () => unknown;
 diagnostics?: RecorderOptions;
	/** Optional estimated complete-input ceiling, separate from physical output reservation.
	 * The host owns final serialization/transport counting; this is not an exact wire-token cap. */
	activeInputTokens?: number | ((ctx: ExtensionContext) => number);
	/** An explicit cut point: a fraction of the input room, above 0 and at most 1. A cut is triggered at, and preferably planned to, the band,
	 * which is the room less 2% of it, or this fraction of the room when that is lower; a lower value cuts earlier and leaves less. The exact room
	 * stays the limit of every throw, fault and the complete-context guard. If omitted, the band adapts to the last cut. */
	cutAt?: number;
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
    const cutAt = options.cutAt ?? DEFAULT_CUT_AT;
    if (!validCutAt(cutAt)) throw new Error("Invalid cut point: cutAt must be a number above 0 and at most 1");
    const semantic = options.semanticRecall ?? createSemanticRecall(), search = options.search ?? true;
    const hostAccess = () => {
        if (!active()) throw new Error("Compaction host is inactive");
        options.assertAccess?.();
    };
    let semanticTransition: Promise<void> = Promise.resolve();
    let semanticRequest = 0;
    const semanticPending = new Set<Promise<unknown>>();
    // Semantic indexing outlives any one attempt, so it checks only that the host still grants access: a compactor failure, which ends with its
    // attempt, must not read as a revocation (that disables semantic recall and deletes its index for the rest of the session).
    const semanticProvider = (ctx: ExtensionContext) => () => memoizedEligibleSources(ctx, options.recallPolicy, hostAccess);
    const recorder = new IncidentRecorder(options.diagnostics);
    let proposalId: string | undefined;
    const observe = (ctx: ExtensionContext) => recorder.measureInline(() => {
        if (!active() || failure) return;
        if (!proposalId) return;
        const found = findReceiptEntry(ctx.sessionManager.getBranch(), proposalId);
        if (found) { recorder.capture("observed-entry", "current-native-branch-memory-not-durable", { entryId: found.id, diagnosticReceiptId: proposalId, details: found.type === "compaction" ? found.details : undefined }); recorder.cut(); proposalId = undefined; }
    });
    const captureDraft = (draft: NonNullable<ReturnType<typeof tuckDraft>["compaction"]>, ctx: ExtensionContext, reserve: number, reason: string, tokensBefore: number, retainCurrentInput: boolean, operatorManual: boolean, previousSummary?: string, budget?: { response: number; host: number; mandatory: number; target: Target; margin: number }) => recorder.measureInline(() => {
        const attached = attachReceipt(draft, reason, reserve, ctx.model?.contextWindow ?? 0, { responseReserveTokens: budget?.response, hostInputTokens: budget?.host, mandatoryInputTokens: budget?.mandatory, target: budget?.target, triggerMarginTokens: budget?.margin, ...(cutAt === 1 ? {} : { cutAt }), calibrationFactor: factor, calibrationWindow: [...ratios], calibrationIdentity: identity, activeInputCeilingTokens: lastCeiling });
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
    const planReserve = (target: Target, room: number, band: number, mandatory: number, ctx: ExtensionContext) => {
        identityFor(ctx);
        return planningReserve(ctx.model?.contextWindow ?? 0, target === "band" ? band : room, factor, mandatory);
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
        // Either way the operator hears it from pi-tuck. The estimate is what admitted the request, and a turn that ended in the provider's error
        // with no word from pi-tuck read as a hang: every other refusal says why, and this is the path that skipped it.
        if (overflow) {
            const bound = (ctx.model.contextWindow + 1) / paired.tokens;
            const learned = bound <= CALIBRATION_CEILING;
            ctx.ui.notify(overflowNotice(ctx.model.contextWindow, bound, learned), "warning");
            if (learned) learn(bound);
            return;
        }
        const usage = message.usage;
        if (!usage) return;
        const counts = [usage.input, usage.cacheRead, usage.cacheWrite];
        if (!counts.every(n => Number.isSafeInteger(n) && n >= 0)) return;
        const input = counts.reduce((a, b) => a + b, 0), ratio = input / paired.tokens;
        // A request that was answered cannot have held more than the model's window, so a report above it describes something that never happened.
        // Learning from one sets the factor for the requests after it: a 60,000-token cache read reported in a 32,768-token window made a
        // 6,000-token prompt refuse. The overflow branch above learns from a refusal, where the count is a lower bound, and the ceiling is unchanged.
        if (input > 0 && input <= ctx.model.contextWindow && Number.isSafeInteger(input) && Number.isFinite(ratio)) learn(ratio);
    });
    pi.on("agent_start", () => { admittedRun = true; pending = undefined; phase = "idle"; });
    pi.on("agent_settled", () => { admittedRun = false; pending = undefined; phase = "idle"; forgetFailure(); clips.clear(); promptCut = undefined; });
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
    // Every throw, fault and complete-context guard uses the exact room.
    const limits = (ctx: ExtensionContext) => {
        const { response } = requestReserve(ctx), room = inputRoom(response, ctx);
        return { response, room };
    };
    const decisionBand = (ctx: ExtensionContext, room: number, system: number) => {
        const last = ctx.sessionManager.getBranch().findLast(entry => entry.type === "compaction");
        const after = last?.type === "compaction" ? (last.details as { tokensAfter?: unknown } | undefined)?.tokensAfter : undefined;
        return bandOf(room, cutAt, options.cutAt === undefined && typeof after === "number" && Number.isFinite(after) && after >= 0
            ? { system, tokensAfter: after, factor } : undefined);
    };
    const fits = (tokens: number, limit: number, ctx: ExtensionContext) => corrected(tokens, ctx) < limit;
    // The saved conversation and a cut's quantities are counted by the one function the guard counts with (strict, as the context hook is).
    const measureFor = (ctx: ExtensionContext) => (messages: Messages) => projectedConversationTokens(applyClips(messages, clips), ctx, options.recallPolicy);
    // The planner counts with the same function, except that it does not fail on a summary in another format: a cut can replace one
    // (an operator's /compact repairs a session whose saved summary is foreign). Identical to the strict one for this compactor's summaries.
    const plannerMeasureFor = (ctx: ExtensionContext) => Object.assign(
        (messages: Messages) => measurableConversationTokens(applyClips(messages, clips), ctx, options.recallPolicy),
        { messageTokens: (message: Messages[number]) => conversationTokens(applyClips([message], clips)) });
    const hostTokens = (ctx: ExtensionContext) => options.hostMessages ? conversationTokens(options.hostMessages(ctx)) : 0;
    const toolShapes = (names: Iterable<string>): ToolShape[] => {
        const selected = new Set(names);
        return pi.getAllTools().filter(tool => selected.has(tool.name)).map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
    };
    // Every decision prices the declaration set a cut must carry, even before the first cut enables our tools on the wire.
    const requestSystemPart = (observedPrompt: string, names: readonly string[], saved: Messages, guardPrompt: string) => {
        const shapes = toolShapes(historyToolNames(pi, names, true));
        // Keep the guard's observed schemas (Pi may enrich a host tool's schema), and add our future declarations to that same view.
        // Taking max(current guard, future raw shapes) alone could lose the enrichment when the future shapes are larger.
        const future = saved.some(message => message.role === "system") ? historyToolDeclarations(saved, shapes, true) : saved;
        return systemPart(observedPrompt, shapes, future, guardPrompt);
    };
    // Pi reports a manual cut with nothing to do as a failed compaction; the thrown error lacks the event's "Compaction failed: " prefix.
    const isNoWork = (message: string | undefined) => ["Already compacted", "Nothing to compact (session too small)"].includes(message?.replace(/^Compaction failed: /, "") ?? "");
    // A missing model is configuration, not capacity.
    const missingModel = () => new Error("No context model for the request budget");
    // A prompt's cut, until its run saves it at its first boundary: every request of that run carries it (the context hook). A run that ends
    // before a boundary drops it, and the next prompt decides afresh.
    type CutEntry = { type: "compaction"; summary: string; firstKeptEntryId: string; tokensBefore: number; details?: unknown };
    let promptCut: CutEntry | undefined;
    // Where the branch ended when the prompt's cut was planned: the prompt is the entry Pi appends there. A cut that keeps nothing of the conversation
    // before it names no entry to keep from, and read as it stands that drops the prompt too, so the model never sees it.
    let promptCutAt = 0;
    const keptFrom = (cut: CutEntry, ctx: ExtensionContext) => cut.firstKeptEntryId || ctx.sessionManager.getBranch()[promptCutAt]?.id || "";
    let failure: Error | undefined;
    let pendingBoundaryCommit = false;
    // Fresh tool results the room cannot hold, by call id: each request of the run carries the clip in their place; the session keeps them
    // whole. A clip ends with its run like any failure would: the next run plans from the session as it is, where the result is no longer fresh.
    const clips = new Map<string, Clip>();
	const fail = (error: unknown, ctx: ExtensionContext) => {
		recorder.stop("native-attempt-failed");
        // Every refusal says why, once per attempt: a capacity error with what the user can change, a cut Pi failed to commit with what that
        // means for the session, anything else as it is (an attempt that ended with no word looked like a hang).
        const notify = !failure;
		// A CommitFault stays whatever fails after it.
		if (!(failure instanceof CommitFault)) failure = error instanceof Error ? error : new Error(String(error));
        pendingBoundaryCommit = false;
        pending = undefined;
        promptCut = undefined;
		try { options.fail?.(error); } finally {
            try { if (notify) ctx.ui.notify(failure instanceof CapacityError ? refusalNotice(failure.message, factor) : failure instanceof CommitFault
                ? `pi-tuck: ${failure.message}; the session holds a cut its file may lack, so start a new session.`
                : `pi-tuck could not plan this request (${failure.message}); the next prompt is planned afresh.`, "error"); }
            finally { ctx.abort(); }
        }
	};
	// The one place a failure is dropped: when its attempt has settled, when a prompt arrives, and when the operator asks for a cut. A run that no
	// input started (a custom message) has only the first of these. No failure but a CommitFault outlives its attempt.
	const forgetFailure = () => { if (!(failure instanceof CommitFault)) failure = undefined; };
	const access = () => {
		if (failure) throw failure;
		hostAccess();
	};
    // Abort alone is insufficient: Pi starts a fresh abort controller after
    // before_agent_start. Keep this attempt blocked, then recheck on new idle input.
    // "decided": `input` has decided for the run it starts, so that run's before_agent_start does not decide again. "starting": a run is
    // between before_agent_start and agent_start, where Pi 1.1 still reports idle but a message joins that run.
    let phase: "idle" | "decided" | "starting" = "idle";
    pi.on("input", async (event, ctx) => {
        if (!ctx.isIdle() || phase === "starting") return; // a steering or follow-up message joins the running request
        forgetFailure();
        phase = "decided";
        try { syncHistoryTools(ctx); await preflight(ctx, incomingTokens(event.text, event.images), ctx.getSystemPrompt(), pi.getActiveTools()); syncHistoryTools(ctx); }
        catch (error) { fail(error, ctx); }
    });
	pi.registerTool({
		name: "tuck_recall", label: "pi-tuck history", parameters: RecallInput,
        description: "Keyword lookup locates particular text in your current branch. {query} returns ranked passages with read coordinates; punctuation separates words. Pass the returned next as {continuation} unchanged. " + (search ? "Use tuck_search for historical information relevant to a question, including different wording and qualifications. " : "") + "Knowing an identifier does not itself justify narrowing discovery. {entryId} or {index} (a summary sourceIndex or #N) reads one source, optionally with query, offset and limit in UTF-16 characters (limit defaults to 8000). {} browses history; {around} expands neighbors; {entryId,image} reads an image; outputPath writes an original to a file with the native write tool. Hidden reasoning and system records are excluded.",
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
    if (search) pi.registerTool({name:"tuck_search",label:"History search",parameters:SearchInput,
        description:"Find historical information relevant to a question, including different wording and related qualifications. Combines keyword and local embedding search. Knowing a name or identifier does not imply keyword-only lookup is sufficient. Returns original evidence up to 20000 characters; not exhaustive. Semantic search may be off or incomplete, which is not the same as no matches. Read exact originals and their context with tuck_recall at the returned locators. priorResults lists sources already read: pass each returned source's sourceSha and read unchanged.",
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
            const related=await semantic.search(input.query,provider,signal,(input.priorResults??[]).map(({sourceSha,read})=>({entryId:read.entryId,sourceSha,start:read.offset,end:read.offset+read.limit})),words);
            access();if(signal?.aborted)throw Object.assign(new Error('Semantic recall cancelled'),{name:'AbortError'});const now=provider();
            if(initialSnapshot.id!==now.id||(eligibilityKeyMoved(ctx,initialKey)&&wordText!==JSON.stringify(wordOffer())))return{...reply({status:"snapshot_invalidated",notice:"Search source eligibility or version changed; no earlier evidence delivered. Request a fresh query."}),isError:true};
            const page=budgetSemantic(related,20000-wordText.length-1);
            return{content:[{type:"text" as const,text:wordText},{type:"text" as const,text:JSON.stringify(page)}],details:{semantic:{status:page.status,snapshotId:page.coverage.snapshotId}}};
        }});

	pi.on("session_before_compact", (event, ctx) => {
		try {
			if (!active()) return { cancel: true };
			if (event.signal.aborted || ctx.signal?.aborted) { recorder.stop("cut-cancelled"); return { cancel: true }; }
            // Pi checks its own threshold after a prompt's input and before the run starts: the prompt's cut, planned with the prompt counted,
            // is the answer, and it is saved before the first request.
            if (promptCut && !admittedRun && event.reason === "threshold") {
                access();
                const { type: _, ...compaction } = promptCut;
                promptCut = undefined;
                return { compaction };
            }
            const operatorManual = event.reason === "manual";
            if (operatorManual && !admittedRun) forgetFailure();
			access();
			if (event.customInstructions?.trim()) {
				recorder.stop("no-cut-custom-instructions");
                ctx.ui.notify("pi-tuck does not accept summarization instructions; use /compact without arguments.", "warning");
				return { cancel: true };
			}
            const { response, room } = limits(ctx);
            const retain = operatorManual || admittedRun;
            // A cut Pi asks for (an operator's /compact, Pi's threshold or overflow recovery) charges what the request must carry whatever is
            // cut: the system part and the host input. A prompt's cut is pi-tuck's own and never comes here.
            const saved = ctx.sessionManager.buildSessionProjection().messages;
            const host = hostTokens(ctx);
            const system = requestSystemPart(ctx.getSystemPrompt(), pi.getActiveTools(), saved, ctx.getSystemPrompt());
            const mandatory = system + host, band = decisionBand(ctx, room, system);
            const before = plannerMeasureFor(ctx)(saved);
            // Pi's own usage threshold (reason "threshold") counts the last reply's output tokens, reasoning included, plus the messages after
            // it: a basis this compactor does not plan on. It may ask for a cut on a request that fits. This compactor cuts only where its own
            // trigger would: nothing below the band, an opportunistic cut inside it, a due cut at or above the room. A refusal is a plain
            // cancel (Pi reports it as aborted), never a failure.
            let thresholdOpportunistic = false;
            if (event.reason === "threshold") {
                const gate = gateCut({ total: before + mandatory, mandatory, room, band, fits: (tokens, limit) => fits(tokens, limit, ctx) });
                if (gate.kind !== "plan") return { cancel: true };
                thresholdOpportunistic = gate.opportunistic;
            }
            // Pi checks old history before appending a new idle prompt. During an active run/manual cut the latest admitted input stays protected.
            const decision = chooseCut({
                before, mandatory, room, band, fits: (tokens, limit) => fits(tokens, limit, ctx), usefulOnly: options.cutAt === undefined,
                opportunistic: thresholdOpportunistic,
                unreduced: "Compaction did not reduce context within the estimated request budget",
                plan: (target): Plan<{ compaction: NonNullable<ReturnType<typeof tuckDraft>["compaction"]>; reserve: number }> => {
                    const reserve = planReserve(target, room, band, mandatory, ctx);
                    // Every cut asked while no run is admitted (an operator's cut) is planned for a run that has not begun: the session has moved on
                    // from any run that ended. A retry is inside its run.
                    const draft = tuckDraft(tuck, event, ctx, reserve, plannerMeasureFor(ctx), options.recallPolicy, retain, operatorManual, operatorManual || !admittedRun);
                    return draft.compaction ? { draft: true, after: draft.after, mode: draft.mode, compaction: draft.compaction, reserve }
                        : { draft: false, capacityRejected: Boolean(draft.capacityRejected), reason: draft.unavailable };
                },
            });
            if (decision.kind === "cut") { return { compaction: captureDraft(decision.plan.compaction, ctx, decision.plan.reserve, event.reason, event.preparation.tokensBefore,
                retain, operatorManual, event.preparation.previousSummary, { response, host, mandatory, target: decision.target, margin: room - band }) }; }
            // An opportunistic cut inside the band that cannot reach it is no fault: the request goes to the guard.
            if (decision.kind === "none") return { cancel: true };
			recorder.stop("no-cut");
            ctx.ui.notify(decision.message, "warning");
			if (!operatorManual) fail(new (decision.capacity ? CapacityError : Refusal)(decision.message), ctx);
			return { cancel: true };
		} catch (error) {
			try { fail(error, ctx); } finally { return { cancel: true }; }
		}
	});
	pi.on("session_before_tree", (event) => event.preparation.userWantsSummary ? { cancel: true } : undefined);
    pi.on("session_start", () => { clips.clear(); promptCut = undefined; recorder.stop("session-transition"); proposalId = undefined; failure = undefined; admittedRun = false; pendingBoundaryCommit = false; identity = ""; factor = 1; pending = undefined; phase = "idle"; });
    const historyToolsEnabled = (ctx: ExtensionContext) => Boolean(promptCut) || hasTuckCut(ctx.sessionManager.getBranch());
    const syncHistoryTools = (ctx: ExtensionContext) => { if (active()) applyHistoryTools(pi, historyToolsEnabled(ctx)); };
    pi.on("session_start", (_event, ctx) => syncHistoryTools(ctx));
    pi.on("session_tree", (_event, ctx) => syncHistoryTools(ctx));
    pi.on("session_compact", (_event, ctx) => { if (!admittedRun) syncHistoryTools(ctx); });
    pi.on("turn_start", (_event, ctx) => syncHistoryTools(ctx));
    pi.on("agent_settled", (_event, ctx) => syncHistoryTools(ctx));
    // The session as it will be once a cut that is not saved yet is saved, and its conversation as the next request carries it.
    const cutSession = (ctx: ExtensionContext, cut: CutEntry) => {
        const header = ctx.sessionManager.getHeader();
        if (!header) throw new Error("Missing native session header for the prompt's cut");
        const preview = SessionManager.inMemory(ctx.cwd, undefined, [header, ...ctx.sessionManager.getBranch()]);
        preview.appendCompaction(cut.summary, keptFrom(cut, ctx), 0, cut.details, true);
        return preview;
    };
    const withCut = (ctx: ExtensionContext, cut: CutEntry) => cutSession(ctx, cut).buildSessionProjection().messages;
    // The cut before a run, decided on `input` while the session is idle; before_agent_start decides only for a run no input started (one a
    // custom message starts). The cut is pi-tuck's own, planned as at a tool boundary. It is not Pi's: Pi's cut finder keeps the last
    // keepRecentTokens, and where those are the whole conversation it has nothing to cut, so every later prompt was refused for good (t06 at
    // Pi's defaults on a 32k window). Each request of the run carries the cut, and the run's first boundary saves it.
    const preflight = (ctx: ExtensionContext, incomingPart: number, observedPrompt: string, tools: readonly string[], hostSnapshot?: number) => {
        promptCut = undefined;
        promptCutAt = ctx.sessionManager.getBranch().length;
        if (!active()) return;
        access();
        if (!settingsFor().getCompactionSettings(ctx.model).enabled) return;
        if (!ctx.model) throw missingModel();
        const { response, room } = limits(ctx);
        // Public early view only: later handlers, image normalization and tool-loop growth remain the complete-context guard's responsibility.
        const saved = ctx.sessionManager.buildSessionProjection().messages;
        const system = requestSystemPart(observedPrompt, tools, saved, ctx.getSystemPrompt());
        const band = decisionBand(ctx, room, system);
        const host = hostSnapshot ?? hostTokens(ctx), measure = measureFor(ctx), before = measure(saved);
        const incoming = incomingPart + system, mandatory = incoming + host;
        if (!fits(incoming, room, ctx))
            throw new CapacityError("Incoming Pi prompt and response reserve cannot fit the estimated request budget");
        // A cut removes only conversation. If the mandatory request, host input included, does not fit by itself, no cut can
        // help: leave it to the complete-context guard, which fails closed.
        const gate = gateCut({ total: before + mandatory, mandatory, room, band, fits: (tokens, limit) => fits(tokens, limit, ctx) });
        if (gate.kind !== "plan") return;
        const previousSummary = saved.find(message => message.role === "compactionSummary")?.summary;
        const decision = chooseCut({
            before, mandatory, room, band, fits: (tokens, limit) => fits(tokens, limit, ctx), usefulOnly: options.cutAt === undefined, opportunistic: gate.opportunistic,
            unreduced: "Incoming prompt compaction did not reduce context within the estimated request budget",
            plan: (target): Plan<{ compaction: NonNullable<ReturnType<typeof tuckObservedDraft>["compaction"]>; reserve: number }> => {
                const reserve = planReserve(target, room, band, mandatory, ctx);
                // Only a due cut re-renders a summary that sits alone in the session: inside the band a cut is opportunistic, and a smaller summary
                // there buys nothing the request needed and costs history the next recall would have found.
                const draft = tuckObservedDraft(tuck, { branchEntries: ctx.sessionManager.getBranch(), tokensBefore: before, previousSummary, newPrompt: true, reRenderSummary: !gate.opportunistic }, ctx, reserve, plannerMeasureFor(ctx), options.recallPolicy, false);
                if (!draft.compaction) return { draft: false, capacityRejected: Boolean(draft.capacityRejected), reason: draft.unavailable };
                const messages = withCut(ctx, { type: "compaction", ...draft.compaction, tokensBefore: before });
                assertNativeToolRounds(messages);
                return { draft: true, after: measure(messages), mode: draft.mode, compaction: draft.compaction, reserve };
            },
        });
        // An opportunistic cut inside the band that cannot reach it is no fault: the request goes to the guard.
        if (decision.kind === "none") return;
        if (decision.kind === "fault") throw new (decision.capacity ? CapacityError : Refusal)(decision.message);
        const compaction = captureDraft(decision.plan.compaction, ctx, decision.plan.reserve, "prompt", before, false, false, previousSummary,
            { response, host, mandatory, target: decision.target, margin: room - band });
        promptCut = { type: "compaction", summary: compaction.summary, firstKeptEntryId: compaction.firstKeptEntryId, tokensBefore: before, details: compaction.details };
    };
    pi.on("before_agent_start", async (event, ctx) => {
        const prompted = phase === "decided";
        phase = "starting";
        try {
            syncHistoryTools(ctx);
            if (prompted) access(); // decided on input; a failure latched there still stops the run
            else await preflight(ctx, incomingEventTokens(event), event.systemPrompt,
                historyToolNames(pi, event.systemPromptOptions.selectedTools, historyToolsEnabled(ctx)));
            // Pi declares tool changes before turn_start, then snapshots executable tools in prepareRequest. Introduce our tools in
            // the request projection: recording an activation message here would shift every later session-global recall index.
            if (historyToolsEnabled(ctx)) stageHistoryTools(pi, ctx.sessionManager.buildSessionProjection().messages);
            else applyHistoryTools(pi, false);
            const staged = pi.getActiveTools();
            event.systemPromptOptions.selectedTools = historyToolNames(pi, event.systemPromptOptions.selectedTools, true).filter(name =>
                name !== "tuck_recall" && name !== "tuck_search" || staged.includes(name));
        } catch (error) { fail(error, ctx); }
    });
    // The incoming user message is about to be appended (including steering inside a run), and later before_agent_start/turn_start
    // handlers have run. Pi's prepareRequest has not yet snapshotted executable tools. A first cut discovered in context_with_system
    // would be too late for that snapshot, even if its declarations were repaired there, so make the late prompt decision here.
    pi.on("message_end", (event, ctx) => {
        if (event.message.role !== "user" || !active() || !admittedRun || promptCut) return;
        try {
            access();
            if (!ctx.model) throw missingModel();
            const message = event.message;
            const incoming = incomingTokens(typeof message.content === "string" ? message.content : message.content.flatMap(b => b.type === "text" ? [b.text] : []).join("\n"),
                typeof message.content === "string" ? [] : message.content.filter((b): b is ImageContent => b.type === "image"));
            const saved = ctx.sessionManager.buildSessionProjection().messages;
            const host = hostTokens(ctx);
            const system = requestSystemPart(ctx.getSystemPrompt(), pi.getActiveTools(), saved, ctx.getSystemPrompt());
            if (fits(conversationTokens(saved) + system + incoming + host, limits(ctx).room, ctx)) return;
            preflight(ctx, incoming, ctx.getSystemPrompt(), pi.getActiveTools(), host);
            syncHistoryTools(ctx);
        } catch (error) { fail(error, ctx); }
    });
    // A cut at a public boundary, drafted against the boundary's own preview: "tool-loop" between the rounds of a run, "run-end" once its
    // last reply is in. A run-end cut is made only at or above the band, as a tool-loop one, so the next prompt starts from below it: an
    // input cut is bound by Pi's keepRecentTokens, and a large prompt right after a cut could leave it nothing to cut. A run-end cut that
    // cannot be planned is no fault: the run is over, and the next prompt decides afresh. Only a tool-loop boundary has fresh results to clip.
    const boundaryCut = (event: { entries: readonly unknown[]; context: { contextMessages: Messages; pendingMessages: readonly unknown[] }; toolResults?: Parameters<typeof clipFor>[0] }, ctx: ExtensionContext, reason: "tool-loop" | "run-end") => {
        access();
        // Earlier boundary drafts have a public preview but no original-source compiler
        // contract. Preserve them and leave admission to the final guard.
        if (event.entries.length || !isDeepStrictEqual(event.context.contextMessages,
            ctx.sessionManager.buildSessionProjection().messages)) return;
        if (!ctx.model) return;
        const { response, room } = limits(ctx);
        const measure = measureFor(ctx), saved = event.context.contextMessages;
        // One snapshot per decision. Messages queued for the next request (steering, follow-ups) are in that request but not in the
        // saved conversation. Pi's peek returns the steering queue, else the follow-up queue; a follow-up is not in the very next
        // request while tools still run, so it can be counted early: conservative, and nothing else would cut at that later boundary.
        const system = requestSystemPart(ctx.getSystemPrompt(), pi.getActiveTools(), saved, ctx.getSystemPrompt());
        const band = decisionBand(ctx, room, system);
        const host = hostTokens(ctx);
        const queued = event.context.pendingMessages.length ? conversationTokens(event.context.pendingMessages as Messages) : 0;
        const mandatory = system + host + queued;
        // Without usable provider usage, Pi's own threshold uses its unwrapped message estimate as the compiler's density input.
        // Our declarations are request-only, so Pi can miss that threshold. Preserve the same density input at settlement; every
        // budget decision below still uses `system` and the complete conversation measure, including the summary envelope.
        let densityTokens: number | undefined;
        const lastAssistant = saved.findLast(message => message.role === "assistant");
        const lastCut = ctx.sessionManager.getBranch().findLast(entry => entry.type === "compaction");
        if (reason === "run-end" && lastAssistant && (!lastCut || lastAssistant.timestamp > Date.parse(lastCut.timestamp)) &&
            !saved.some(message => message.role === "assistant" &&
            !["error", "aborted"].includes(message.stopReason) && message.usage && calculateContextTokens(message.usage) > 0)) {
            const forecast = historyToolDeclarations(saved, toolShapes(historyToolNames(pi, pi.getActiveTools(), true)), true);
            if (forecast !== saved) {
                const head = getCurrentSystemMessage(convertToLlm(forecast));
                const native = (head ? estimateTokens(head) : 0) + saved.reduce((sum, message) => sum + (message.role === "system" ? 0 : estimateTokens(message)), 0);
                if (shouldCompact(native, ctx.model.contextWindow, settingsFor().getCompactionSettings(ctx.model))) densityTokens = native;
            }
        }
        const previousSummary = saved.find(message => message.role === "compactionSummary")?.summary;
        // The cut previews this decision has built, in the order it built them. The clip retry below measures them for what a cut leaves the
        // request besides the fresh results. Reset per decision, so a retry sizes itself against the cut it is retrying, not an earlier attempt's.
        let previews: Messages[] = [];
        let floorKept: number | undefined;
        const decide = () => {
            previews = [];
            floorKept = undefined;
            const before = measure(saved);
            const gate = gateCut({ total: before + mandatory, mandatory, room, band, fits: (tokens, limit) => fits(tokens, limit, ctx) });
            if (gate.kind !== "plan") return gate;
            return chooseCut({
            opportunistic: gate.opportunistic, mandatory, before, room, band, fits: (tokens, limit) => fits(tokens, limit, ctx), usefulOnly: options.cutAt === undefined,
            unreduced: "Tool-loop preflight compaction did not reduce context within the estimated request budget",
            plan: (target): Plan<{ compaction: NonNullable<ReturnType<typeof tuckObservedDraft>["compaction"]>; reserve: number }> => {
                const reserve = planReserve(target, room, band, mandatory, ctx);
                const draft = tuckObservedDraft(tuck, { branchEntries: ctx.sessionManager.getBranch(), tokensBefore: densityTokens ?? before, previousSummary }, ctx, reserve, plannerMeasureFor(ctx), options.recallPolicy, true);
                if (!draft.compaction) {
                    // The planner's own floor, so a clip's second budget is measured against what the smallest cut really keeps.
                    if (draft.floorMessages && event.toolResults) {
                        const fresh = new Set(event.toolResults.map(result => result.toolCallId));
                        const kept = measure(draft.floorMessages.filter(message =>
                            !(message.role === "toolResult" && fresh.has((message as ToolResultMessage).toolCallId))));
                        // Both targets must leave their protected openings beside the clip.
                        floorKept = Math.max(floorKept ?? kept, kept);
                    }
                    return { draft: false, capacityRejected: Boolean(draft.capacityRejected), reason: draft.unavailable };
                }
                const header = ctx.sessionManager.getHeader();
                if (!header) throw new Error("Missing native session header at tool-loop boundary");
                const preview = SessionManager.inMemory(ctx.cwd, undefined, [header, ...ctx.sessionManager.getBranch()]);
                preview.appendCompaction(draft.compaction.summary, draft.compaction.firstKeptEntryId, before, draft.compaction.details, true);
                const messages = preview.buildSessionProjection().messages;
                assertNativeToolRounds(messages);
                previews.push(messages);
                return { draft: true, after: measure(messages), mode: draft.mode, compaction: draft.compaction, reserve };
            },
            });
        };
        let decision = decide();
        // Only a request that would be refused is clipped. A fresh result is kept whole by every cut (it has not reached the model yet), so a round
        // larger than the room refuses the run; in its place the request carries the result's head and tail with a tuck_recall locator to the rest.
        // clipBudgets states the budgets tried and why they are counted in the estimate's units; `kept` is measured from the previews this decision
        // built, so the second budget is the cut's own floor and not a new formula. When nothing is clipped or the decision still faults, the
        // refusal stands.
        if (decision.kind === "fault" && event.toolResults) {
            const branch = ctx.sessionManager.getBranch();
            const entryIdOf = (toolCallId: string) => branch.findLast(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === toolCallId)?.id;
            const fresh = new Set(event.toolResults.map(result => result.toolCallId));
            const kept = previews.length ? Math.max(...previews.map(preview => measure(preview.filter(message =>
                !(message.role === "toolResult" && fresh.has((message as ToolResultMessage).toolCallId)))))) : floorKept;
            for (const budget of clipBudgets(room, factor, mandatory, kept)) {
                const round = clipFor(event.toolResults, entryIdOf, budget);
                if (!round.length) continue;
                for (const clip of round) clips.set(clip.toolCallId, clip);
                const clippedDecision = decide();
                if (clippedDecision.kind === "fault") for (const clip of round) clips.delete(clip.toolCallId);
                else { decision = clippedDecision; break; }
            }
        }
        const before = measure(saved);
        if (decision.kind === "fault" && reason === "tool-loop") throw new (decision.capacity ? CapacityError : Refusal)(decision.message);
        if (decision.kind !== "cut") return;
        const compaction = captureDraft(decision.plan.compaction, ctx, decision.plan.reserve, reason, before, true, false, previousSummary,
            { response, host, mandatory, target: decision.target, margin: room - band });
        return { entries: [{ type: "compaction" as const, summary: compaction.summary,
            firstKeptEntryId: compaction.firstKeptEntryId, details: compaction.details }] };
    };
    // A boundary's cut. The run's first boundary also saves the prompt's cut, after any entries an earlier handler proposed, and decides on
    // the session as it is with that cut: a fresh result can still need a cut of its own there.
    type Boundary = Parameters<typeof boundaryCut>[0];
    const atBoundary = (event: Boundary, ctx: ExtensionContext, reason: "tool-loop" | "run-end", decide: boolean) => {
        if (!promptCut) return decide ? boundaryCut(event, ctx, reason) : undefined;
        const entry = promptCut;
        promptCut = undefined;
        const preview = cutSession(ctx, entry), view: ExtensionContext = Object.create(ctx, { sessionManager: { value: preview } });
        const more = decide && !event.entries.length
            ? boundaryCut({ ...event, context: { ...event.context, contextMessages: preview.buildSessionProjection().messages } }, view, reason) : undefined;
        const { tokensBefore: _, ...cut } = entry;
        const saved = { ...cut, firstKeptEntryId: keptFrom(entry, ctx) };
        // As for a cut Pi makes (session_compact): the history the cut leaves behind is indexed, once Pi has committed the entries.
        setImmediate(() => { semantic.indexAtCut(semanticProvider(ctx)); });
        return { entries: [...event.entries as CutEntry[], saved, ...(more?.entries ?? [])] };
    };
    pi.on("turn_end", (event, ctx) => {
        try {
            if (!active() || !admittedRun) return;
            const decide = event.outcome === "completed" && !ctx.signal?.aborted && event.context.canContinue && event.toolResults.length > 0 &&
                settingsFor().getCompactionSettings(ctx.model).enabled;
            if (!promptCut && !decide) return;
            const result = atBoundary(event, ctx, "tool-loop", decide);
            if (result) {
                pendingBoundaryCommit = true;
            }
            return result;
        } catch (error) { fail(error, ctx); }
        finally {
            // Keep our part of Pi's next declaration snapshot unchanged; turn_start restores the branch-derived executable set before
            // prepareRequest. This avoids an extra persisted system message at the first cut and on later rounds/runs.
            if (active()) {
                if (historyToolsEnabled(ctx)) stageHistoryTools(pi, ctx.sessionManager.buildSessionProjection().messages);
                else applyHistoryTools(pi, false);
            }
        }
    });
    // A request of a run whose prompt's cut is not saved yet: the saved conversation in it, which other handlers may surround, is replaced by
    // the conversation with the cut applied. Pi sends the saved system message apart from the request's messages, so neither side carries it
    // here. A request that does not carry the saved conversation as it stands cannot take the cut.
    const cutRequest = <M,>(messages: M[], ctx: ExtensionContext, cut: CutEntry): M[] => {
        const conversation = (all: Messages) => all.filter(message => message.role !== "system") as unknown[];
        const saved = conversation(ctx.sessionManager.buildSessionProjection().messages);
        for (let at = 0; at + saved.length <= messages.length; at++)
            if (saved.every((message, i) => isDeepStrictEqual(messages[at + i], message)))
                return [...messages.slice(0, at), ...conversation(withCut(ctx, cut)) as M[], ...messages.slice(at + saved.length)];
        throw new Error("The prompt's cut cannot be applied: the request does not carry the saved conversation");
    };
    pi.on("context", (event, ctx) => {
        try {
            if (!active()) return;
            // Before a cut, Pi owns the whole request, including its object identities and system-message serialization.
            if (!historyToolsEnabled(ctx)) return clips.size ? { messages: applyClips(event.messages, clips) } : undefined;
            access();
            return { messages: applyClips(projectedMessages(promptCut ? cutRequest(event.messages, ctx, promptCut) : event.messages, ctx, options.recallPolicy), clips) };
        } catch (error) { try { fail(error, ctx); } finally { return historyToolsEnabled(ctx) ? { messages: [] } : undefined; } }
    });
	pi.on("session_compact_failed", (event, ctx) => {
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
		if (active() && !event.aborted) fail(new (event.fromExtension ? CommitFault : Error)(event.errorMessage ?? "Compaction failed"), ctx);
	});
    pi.on("agent_before_settle", (event, ctx) => {
        if (pendingBoundaryCommit) {
            if (event.outcome === "error") return void fail(new CommitFault("Native tool-loop boundary draft remained unconfirmed at error settlement"), ctx);
            pendingBoundaryCommit = false;
        }
        // Pi commits these entries before the run settles.
        try {
            if (!active() || !admittedRun || failure || !settingsFor().getCompactionSettings(ctx.model).enabled) return;
            const decide = event.outcome === "completed" && !ctx.signal?.aborted;
            if (promptCut ? event.outcome === "error" : !decide) return;
            return atBoundary(event, ctx, "run-end", decide);
        } catch (error) { fail(error, ctx); }
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
            syncHistoryTools(ctx);
            const messages = historyToolsEnabled(ctx) ? historyToolDeclarations(event.messages, toolShapes(pi.getActiveTools()), true) : event.messages;
            const system = requestSystemPart(ctx.getSystemPrompt(), pi.getActiveTools(), messages, ctx.getSystemPrompt());
            const tokens = system + conversationTokens(messages);
			if (!fits(tokens, limits(ctx).room, ctx))
				throw new CapacityError("Complete Pi context and response reserve exceed the estimated request budget");
            if (recorder.enabled && !recorder.waitingForCut) recorder.measureInline(() => {
                recorder.request();
                // No system prompt or hidden assistant blocks; no provider payload/headers.
                const permitted = messages.filter(m => m.role !== "system" &&
                    !(m.role === "assistant" && m.content.some(b => b.type === "thinking")) &&
                    !(m.role === "custom" && options.recallPolicy?.privateCustomTypes?.includes(m.customType)));
                recorder.capture("prepared-request", "public-context-with-system-hook-before-later-transforms-not-wire", { messages: permitted, estimatedInputTokens: tokens }, permitted.length !== event.messages.length);
            });
            if (tokens > 0 && Number.isSafeInteger(tokens)) pending = {
                identity: identityFor(ctx), tokens, messages, snapshot: structuredClone(convertToLlm(messages)),
            };
            if (messages !== event.messages) return { messages };

		} catch (error) { fail(error, ctx); }
	});
    return {close:async()=>{semanticRequest++;recorder.stop("caller-close");await semantic.close();await Promise.allSettled([...semanticPending]);}, semanticRecall:semantic, setSemanticEnabled, semanticStatus};
}

function checkedInput(raw: unknown) { if (!Check(RecallInput, raw)) throw new Error("Invalid recall input"); return structuredClone(raw); }
