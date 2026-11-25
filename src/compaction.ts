import { textOf } from "./tuck/core/content.js";
import { PendingCut, StartingPrompt, Run, type CutEntry } from "./run.js";
import { requestReplyFloor, carriesPrompt, thinkingOnlyLength, piContextSafetyMargin, loadPiRequestMath } from "./request-capacity.js";
import { BUILD_ID } from "./build-id.js";
import { DIAGNOSTIC_BUILD, IncidentRecorder, attachReceipt, permittedEntries, receiptId, findReceiptEntry, type Receipt, type RecorderOptions } from "./diagnostics.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { exportSource } from "./source-export.js";
import { isDeepStrictEqual } from "node:util";
import { assertNativeToolRounds, isDiscardedResponse } from "./protocol.js";
import { projectedMessages } from "./omissions.js";
import { applyClips, clipBudgets, clipFor, type Clip } from "./clip.js";
import { DEFAULT_CUT_AT, bandOf, chooseCut, conversationTokens, gateCut, incomingEventTokens, incomingTokens, measurableConversationTokens, planningReserve, projectedConversationTokens, systemPart, validCutAt,
    type AgentMessage, type Decision, type Messages, type Plan, type Target } from "./budget.js";
import { getCurrentSystemMessage, isContextOverflow, normalizeContext, type ImageContent, type ToolResultMessage } from "@earendil-works/pi-ai";
import { calculateContextTokens, convertToLlm, estimateTokens, shouldCompact, SettingsManager, type ExtensionAPI, type ExtensionContext, type SessionEntry, type SessionBoundaryDraft, type TurnEndEvent } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { RecallPolicy } from "./recall.js";
import { MAX_RECALL_CHARACTERS, MAX_RECALL_ENTRY_ID_CHARACTERS, MAX_RECALL_QUERY_CHARACTERS } from "./recall.js";

import { tuck, tuckDraft, tuckObservedDraft, tuckRecall } from "./tuck.js";
import { CONTINUATION_CACHE_MISS, LOADED_VERSION, statusText } from "./status.js";
import { ImageRecallInput, historyImage, historyAround } from "./history-image.js";
import { notify } from "./notify.js";
import { applyHistoryTools, historyToolDeclarations, historyToolNames, stageHistoryTools } from "./history-tools.js";

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
const reply = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });
/** The compactor's verdict that this attempt cannot be made: the cut it needs cannot be made, or the request cannot fit. Like every failure but
 * a `CommitFault`, it ends with its attempt (`resetRun`), and the next attempt plans afresh from the session as it is. */
class Refusal extends Error {}
/** Pi could not confirm a pi-tuck cut on disk. Keep this fault until restart because a failed boundary may leave memory and disk out of sync. */
class CommitFault extends Error {}
/** A refusal for want of room, which the user can remedy: it carries advice. */
class CapacityError extends Refusal {}
/** Explain a high planning factor, which can come from reported usage or an overflow estimate. */
export const refusalNotice = (message: string, factor: number): string =>
    message + "; shorten the input, use a model with a larger window, or lower Pi's compaction.reserveTokens, then retry." +
    (factor >= 1.5 ? ` pi-tuck is planning with ${factor.toFixed(1)}x its base input estimate. Through a router such as OpenRouter, a different upstream may count less.` : "");
/** Keep the provider rejection distinct from the assumption used to estimate a planning factor. */
export const overflowNotice = (contextWindow: number, bound: number, learned: boolean): string =>
    `pi-tuck: the provider refused this request for context overflow. Using the configured ${contextWindow}-token window as the input limit gives a planning factor of ${bound.toFixed(2)}x.` +
    (learned ? " pi-tuck added this estimate to its calibration." : " This exceeds the calibration ceiling, so the factor is unchanged.");
/** The most a seed or an overflow raise may set the calibration factor to. A paired reply's own ratio is not bounded by it. */
export const CALIBRATION_CEILING = 1.5;
/** How many recent paired replies (and overflow bounds, and the seed while it is among them) the calibration factor is the maximum of. */
export const CALIBRATION_WINDOW = 32;
export const CALIBRATION_RECEIPT = 'pi-tuck-calibration';
/** Read the newest applicable calibration receipt on the branch for `key` ([provider, api, id]). A custom
 * observation for another identity is skipped. A compaction receipt for another or missing identity resets
 * the seed to [1]. A matching receipt supplies its recent ratios clamped to [0, CALIBRATION_CEILING],
 * or its legacy factor clamped to [1, CALIBRATION_CEILING]. Without a usable seed, start at [1]. */
export function seedWindow(branch: readonly SessionEntry[], key: string): number[] {
    for (let i = branch.length; i--;) {
        const entry = branch[i]!;
        const receipt = entry.type === "custom" && entry.customType === CALIBRATION_RECEIPT ? { settings: entry.data as Partial<Receipt["settings"]> | undefined }
            : entry.type === "compaction" ? (entry.details as { diagnosticReceipt?: { settings?: Partial<Receipt["settings"]> } | null } | undefined)?.diagnosticReceipt : undefined;
        if (receipt === undefined) continue;
        const { calibrationIdentity, calibrationFactor, calibrationWindow } = receipt?.settings ?? {}, stored: unknown = calibrationWindow;
        if (calibrationIdentity !== key) {
            if (entry.type === "custom") continue; // Another model's new observation does not hide this model's last saved seed.
            return [1];
        }
        if (Array.isArray(stored) && stored.length >= 1 && stored.length <= CALIBRATION_WINDOW && stored.every(n => typeof n === "number" && Number.isFinite(n)))
            return stored.map(n => Math.min(Math.max(n, 0), CALIBRATION_CEILING));
        if (typeof calibrationFactor === "number" && Number.isFinite(calibrationFactor)) return [Math.min(Math.max(calibrationFactor, 1), CALIBRATION_CEILING)];
        return [1];
    }
    return [1];
}
/** One accounting owner. Session start still defers receipt loading until the first budget read;
 * tree moves load immediately. */
class Calibration {
    identity = '';
    factor = 1;
    ratios: number[] = [];
    pending: { identity: string; tokens: number; messages: Parameters<typeof convertToLlm>[0]; snapshot: ReturnType<typeof convertToLlm> } | undefined;
    lastCeiling: number | null = null;
    estimatedTokens = 0;
    private seededIdentity = '';
    static key(ctx: ExtensionContext) { return ctx.model ? JSON.stringify([ctx.model.provider, ctx.model.api, ctx.model.id]) : ''; }
    select(ctx: ExtensionContext) { this.identity = Calibration.key(ctx); }
    needsSeed() { return this.seededIdentity !== this.identity; }
    reseed(ctx: ExtensionContext, reason: 'identity' | 'session' | 'tree') {
        this.identity = Calibration.key(ctx);
        this.pending = undefined;
        if (reason === 'session') {
            this.factor = 1; this.estimatedTokens = 0;
            // Keep the old ratios/ceiling until their existing readers replace them, as in 1.1.1.
            this.seededIdentity = '';
            return;
        }
        this.seededIdentity = this.identity;
        if (reason === 'tree' && !this.identity) return;
        const branch = ctx.sessionManager.getBranch();
        this.ratios = seedWindow(branch, this.identity);
        this.factor = Math.max(1, ...this.ratios);
    }
    learn(value: number, ctx: ExtensionContext, append: (kind: string, data: unknown) => void) {
        this.ratios.push(value); if (this.ratios.length > CALIBRATION_WINDOW) this.ratios.shift(); this.factor = Math.max(1, ...this.ratios);
        // D7: compare what a cold instance would seed, including the existing clamps.
        if (!isDeepStrictEqual(seedWindow(ctx.sessionManager.getBranch(), this.identity), this.ratios.map(n => Math.min(Math.max(n, 0), CALIBRATION_CEILING))))
            append(CALIBRATION_RECEIPT, { calibrationIdentity: this.identity, calibrationWindow: [...this.ratios] });
    }
}
export type CompactionState = { kind: "active" } | { kind: "standingDown"; reason: string };
/** Only evidenced prerequisites disable our request/summary transforms. A missing model keeps the existing explicit error. */
export function compactionState(model: { api: string; contextWindow?: number } | undefined, enabled: boolean): CompactionState {
    const reason = !enabled ? "compaction is disabled" : model?.api === "pi-virtual" ? "pi-virtual model" : !model ? undefined
        : model.contextWindow === undefined ? "context window is missing"
        : !Number.isFinite(model.contextWindow) ? "context window is not finite"
        : model.contextWindow <= 0 ? "context window is zero or negative" : undefined;
    return reason ? { kind: "standingDown", reason } : { kind: "active" };
}
export interface CompactionOptions {
 diagnostics?: RecorderOptions;
 /** Optional read-only observation of actual corrected budget checks; no request content. */
 observeBudget?: (measurement: { rawTokens: number; tokens: number; factor: number; response: number; room: number; hardLine?: number; context: ExtensionContext }) => void;
	/** Optional estimated complete-input ceiling, separate from physical output reservation.
	 * The host owns final serialization/transport counting; this is not an exact wire-token cap. */
	activeInputTokens?: number | ((ctx: ExtensionContext) => number);
	/** An explicit cut point: a fraction of the input room, above 0 and at most 1. A cut is triggered at, and preferably planned to, the band,
	 * which is the room less 2% of it, or this fraction of the room when that is lower; a lower value cuts earlier and leaves less. The room
	 * owns cut targets; standalone final capacity admission uses the branch reply floor. If omitted, the band adapts to the last cut. */
	cutAt?: number;
	/** Models where a usable cached prefix is more valuable than an early cut. */
	cacheSensitiveModels?: readonly string[];
	/** Host response reserve. `responseExact: true` uses it as declared. Otherwise the SDK
	 * keeps the catalogue maximum as a floor for existing callers. Standalone uses Pi’s soft reserve. */
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
    const piMath = await loadPiRequestMath();
    const piMargin = options.requestReserve ? 0 : await piContextSafetyMargin(piMath);
    const piClamp = piMath?.clampMaxTokensToContext;
    const cutAt = options.cutAt ?? DEFAULT_CUT_AT;
    if (!validCutAt(cutAt)) throw new Error("Invalid cut point: cutAt must be a number above 0 and at most 1");
    const hostAccess = () => {
        if (!active()) throw new Error("Compaction host is inactive");
        options.assertAccess?.();
    };
    const view = (ctx: ExtensionContext, threshold = false) => (threshold && run?.expired ? liveCut : run?.cut ?? liveCut).view(ctx);
    const liveCut = new PendingCut();
    const recorder = new IncidentRecorder(options.diagnostics);
    let proposalId: string | undefined;
    const observe = (ctx: ExtensionContext) => recorder.measureInline(() => {
        if (!active() || failure()) return;
        if (!proposalId) return;
        const found = findReceiptEntry(ctx.sessionManager.getBranch(), proposalId);
        if (found) { recorder.capture("observed-entry", "current-native-branch-memory-not-durable", { entryId: found.id, diagnosticReceiptId: proposalId, details: found.type === "compaction" ? found.details : undefined }); recorder.cut(); proposalId = undefined; }
    });
    const captureDraft = (draft: NonNullable<ReturnType<typeof tuckDraft>["compaction"]>, ctx: ExtensionContext, reserve: number, reason: string, tokensBefore: number, retainCurrentInput: boolean, operatorManual: boolean, previousSummary?: string, budget?: { response: number; host: number; mandatory: number; target: Target; margin: number }) => recorder.measureInline(() => {
        const attached = attachReceipt(draft, reason, reserve, contextWindow(ctx), { responseReserveTokens: budget?.response, hostInputTokens: budget?.host, mandatoryInputTokens: budget?.mandatory, target: budget?.target, triggerMarginTokens: budget?.margin, ...(cutAt === 1 ? {} : { cutAt }), calibrationFactor: calibration.factor, calibrationWindow: [...calibration.ratios], calibrationIdentity: calibration.identity, activeInputCeilingTokens: calibration.lastCeiling });
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
    pi.on("session_shutdown", () => { recorder.stop("session-shutdown"); });
    pi.registerCommand("tuck", { description: "pi-tuck's state in this session: version, cuts, cut point, search", handler: async (_args, ctx) => {
        ctx.ui.notify(statusText({ version: LOADED_VERSION, active: active(), compaction: stateFor(ctx), branch: ctx.sessionManager.getBranch(), cutAt: options.cutAt, cacheSensitive: preservePrefix(ctx), pending: view(ctx).pending }), "info");
    } });
    // Pi's native start/settled events bracket the run and its post-turn cuts.
    let run: Run | undefined;
    // A commit-failed phase survives attempts/tree moves until session_start: native memory may be ahead of disk.
    const failure = () => run?.error;
    const protectedPrompt = (ctx: ExtensionContext) => run?.prompt?.id(ctx.sessionManager.getBranch());
    const clips = () => run?.clips ?? emptyClips;
    const emptyClips = new Map<string, Clip>();
    const restoreClips = (snapshot: ReadonlyMap<string, Clip>) => {
        const current = clips();
        current.clear();
        for (const [id, clip] of snapshot) current.set(id, clip);
    };
    const resetRun = (session = false) => {
        if (!session && run?.phase === "commit-failed") run.clear(); else run = undefined;
        calibration.pending = undefined;
    };
    const beginRun = (phase: "decided" | "starting" | "admitted") => {
        if (run?.phase === "commit-failed") run.clear(); else run = new Run(phase);
    };
    const stateFor = (ctx: ExtensionContext) => compactionState(ctx.model, settingsFor().getCompactionSettings(ctx.model).enabled);
    // A prerequisite can change with the model/settings; discard the old plan before returning control to native.
    const standDown = (ctx: ExtensionContext) => {
        if (stateFor(ctx).kind === "active") return false;
        resetRun();
        lengthStop = undefined;
        return true;
    };
    const promptRefusal = () => new Refusal("Prompt check failed: the whole starting prompt cannot fit after cutting to the band and room, shrinking the summary and clipping fresh results. Shorten the prompt or choose a model with a larger context window, then retry");
    const calibration = new Calibration();
    const identityFor = (ctx: ExtensionContext) => {
        calibration.select(ctx);
        if (calibration.needsSeed()) calibration.reseed(ctx, "identity");
        return calibration.identity;
    };
    pi.on("model_select", (_event, ctx) => {
        calibration.select(ctx);
        if (run) run.rejectedBudget = undefined;
    });
    const contextWindow = (ctx: ExtensionContext) => ctx.model?.contextWindow ?? 0;
    // The factor is max(1, the last CALIBRATION_WINDOW paired ratios, overflow bounds and seed): it rises at once and a stale high ratio ages out.
    const learn = (value: number, ctx: ExtensionContext) => calibration.learn(value, ctx, (kind, data) => pi.appendEntry(kind, data));
    const corrected = (tokens: number, ctx: ExtensionContext) => { identityFor(ctx); return Math.ceil(tokens * calibration.factor); };
    const observeBudget = (rawTokens: number, ctx: ExtensionContext) => {
        if (options.observeBudget) options.observeBudget({ rawTokens, tokens: corrected(rawTokens, ctx), factor: calibration.factor, ...limits(ctx), context: ctx });
    };
    // The cut planner's raw reserve for the target limit, on the same factor as every other consumer.
    const planReserve = (target: Target, room: number, band: number, mandatory: number, ctx: ExtensionContext) => {
        identityFor(ctx);
        return planningReserve(ctx.model?.contextWindow ?? 0, target === "band" ? band : room, calibration.factor, mandatory);
    };
    pi.on("message_end", (event, ctx) => {
        if (event.message.role !== "assistant") return;
        if (standDown(ctx)) return;
        const responseMessage = event.message;
        if (recorder.enabled && !recorder.waitingForCut) recorder.measureInline(() => {
            if (!responseMessage.content.some(b => b.type === "thinking")) recorder.capture("response-actions", "native-public-message-end", responseMessage);
            else recorder.capture("response-actions", "hidden-material-excluded", { stopReason: responseMessage.stopReason }, true);
            recorder.responded(responseMessage.stopReason);
        });
        const paired = calibration.pending; calibration.pending = undefined;
        const key = identityFor(ctx), message = event.message;
        const overflow = message.stopReason === "error" && isContextOverflow(message);
        if (!paired || !key || paired.identity !== key || !active() || failure() || ctx.signal?.aborted || (message.errorMessage && !overflow) ||
            message.provider !== ctx.model?.provider || message.model !== ctx.model.id || message.api !== ctx.model.api ||
            (!overflow && !["stop", "toolUse", "length"].includes(message.stopReason)) ||
            !isDeepStrictEqual(convertToLlm(paired.messages), paired.snapshot)) return;
        // The error alone does not report the server's window or whether it counted input plus output. Use the configured
        // input limit as a planning assumption and keep that assumption explicit in the notice.
        if (overflow) {
            if (run?.phase === "admitted" && !options.requestReserve && piClamp) {
                const { estimate, cap } = requestClamp(paired.messages, ctx);
                if (cap !== undefined) run.rejectedBudget = { input: estimate, output: cap };
            }
            const window = contextWindow(ctx), bound = (window + 1) / paired.tokens;
            const learned = bound <= CALIBRATION_CEILING;
            notify(ctx, overflowNotice(window, bound, learned), "warning");
            if (learned) learn(bound, ctx);
            return;
        }
        const usage = message.usage;
        if (!usage) return;
        const counts = [usage.input, usage.cacheRead, usage.cacheWrite];
        if (!counts.every(n => Number.isSafeInteger(n) && n >= 0)) return;
        const input = counts.reduce((a, b) => a + b, 0), ratio = input / paired.tokens;
        // Reject usage above the configured window for calibration. Learning from a reported 60,000-token
        // cache read with a 32,768-token window once made a subsequent 6,000-token prompt refuse.
        if (input > 0 && input <= ctx.model.contextWindow && Number.isSafeInteger(input) && Number.isFinite(ratio)) learn(ratio, ctx);
    });
    // The operator's length-stop notice is decided at settle and is not attempt state: a run reset before then (a tree move inside another
    // extension's agent_settled, a failure) must not erase it. Only the final assistant reply decides it; a successful retry clears it.
    let lengthStop: { kind: "thinking" | "output"; cacheMiss: boolean } | undefined;
    pi.on("agent_start", (_event, ctx) => { if (standDown(ctx)) return; run ??= new Run("starting"); if (!failure()) run.transition("admitted"); lengthStop = undefined; calibration.pending = undefined; });
    pi.on("message_end", event => {
        if (event.message.role !== "assistant") return;
        lengthStop = event.message.stopReason === "length" ? {
            kind: event.message.content && thinkingOnlyLength(event.message) ? "thinking" : "output",
            cacheMiss: event.message.errorMessage === CONTINUATION_CACHE_MISS,
        } : undefined;
    });
    pi.on("agent_settled", (_event, ctx) => {
        try {
            if (standDown(ctx) || !lengthStop || !active()) return;
            const { kind, cacheMiss } = lengthStop;
            const message = kind === "thinking"
                ? "pi-tuck: the model exhausted its output allowance before producing an answer or tool call. The unfinished response is saved in the session."
                : "pi-tuck: the last reply ended with a length stop and may be cut off. Ask the agent to continue.";
            lengthStop = undefined;
            notify(ctx, kind === "thinking" && cacheMiss ? `${message} ${CONTINUATION_CACHE_MISS}` : message, "warning");
        } finally { resetRun(); }
    });
	const active = () => options.active?.() ?? true;
	const settingsFor = () => options.settings ?? SettingsManager.inMemory(pi.getSettings?.());
	// Pi’s configured reserve is the standalone cut target, separate from the output cap.
	const responseReserve = (ctx: ExtensionContext) => {
        const host = options.requestReserve?.(ctx);
        const budget = host ?? { response: settingsFor().getCompactionSettings(ctx.model).reserveTokens };
        if (!Number.isSafeInteger(budget.response) || budget.response < 0)
            throw new Error("Invalid host request reserve");
        const floor = host && host.responseExact !== true;
        return floor ? Math.max(budget.response, ctx.model?.maxTokens ?? 0) : budget.response;
    };
    const inputRoom = (response: number, ctx: ExtensionContext) => {
        const configured = options.activeInputTokens;
        const ceiling = typeof configured === "function" ? configured(ctx) : configured;
        calibration.lastCeiling = ceiling ?? null;
        if (ceiling !== undefined && (!Number.isSafeInteger(ceiling) || ceiling <= 0))
            throw new Error("Invalid active-input token ceiling");
        return Math.min(contextWindow(ctx) - response, ceiling ?? Infinity);
    };
    // Room still owns every existing cut/clip attempt. Only final capacity admission uses the hard line.
    const limits = (ctx: ExtensionContext) => {
        const response = responseReserve(ctx), room = inputRoom(response, ctx);
        const floor = options.requestReserve || !ctx.model ? response : requestReplyFloor(ctx.sessionManager.getBranch(), response, ctx.model);
        const hardLine = Math.min(Math.max(room, contextWindow(ctx) - piMargin - floor), calibration.lastCeiling ?? Infinity);
        return { response, room, hardLine, replyFloor: floor };
    };
    const preservePrefix = (ctx: ExtensionContext) => ctx.model !== undefined &&
        options.cacheSensitiveModels?.includes(`${ctx.model.provider}/${ctx.model.id}`);
    const decisionBand = (ctx: ExtensionContext, room: number, system: number, current?: ReturnType<typeof view>) => {
        if (preservePrefix(ctx)) return room;
        const last = (current ?? view(ctx)).session.getBranch().findLast(entry => entry.type === "compaction");
        const after = last?.type === "compaction" ? (last.details as { tokensAfter?: unknown } | undefined)?.tokensAfter : undefined;
        return bandOf(room, cutAt, options.cutAt === undefined && typeof after === "number" && Number.isFinite(after) && after >= 0
            ? { system, tokensAfter: after, factor: calibration.factor } : undefined);
    };
    const fits = (tokens: number, limit: number, ctx: ExtensionContext) => corrected(tokens, ctx) < limit;
    // The saved conversation and a cut's quantities are counted by the one function the guard counts with (strict, as the context hook is).
    const measureFor = (ctx: ExtensionContext) => (messages: Messages) => projectedConversationTokens(applyClips(messages, clips()), ctx, options.recallPolicy);
    // The planner counts with the same function, except that it does not fail on a summary in another format: a cut can replace one
    // (an operator's /compact repairs a session whose saved summary is foreign). Identical to the strict one for this compactor's summaries.
    const plannerMeasureFor = (ctx: ExtensionContext) => Object.assign(
        (messages: Messages) => measurableConversationTokens(applyClips(messages, clips()), ctx, options.recallPolicy),
        { messageTokens: (message: Messages[number]) => conversationTokens(applyClips([message], clips())) });
    const hostMessages = (ctx: ExtensionContext) => options.hostMessages?.(ctx) ?? [];
    const toolShapes = (names: Iterable<string>) => {
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
    const clampMessage = "Pi's request clamp leaves less than the reply floor";
    // Both the guard and the early projections ask Pi about the very same converted context. Pi's cap uses its own estimator,
    // whereas our hard line is in corrected units; fitting that line alone need not leave the branch's reply floor.
    const requestClamp = (messages: Messages, ctx: ExtensionContext) => {
        const context = normalizeContext({ messages: convertToLlm(messages) });
        const cap = piClamp?.(ctx.model!, context, ctx.model!.maxTokens);
        const estimate = piMath ? piMath.estimateContextTokens(context).tokens : 0;
        const fitsWindow = cap !== undefined && cap > 0 && estimate + piMargin + cap <= contextWindow(ctx);
        // The native clamp bottoms out at one even when the estimate leaves no room.
        return { cap, leavesFloor: cap === undefined || fitsWindow && cap >= limits(ctx).replyFloor, estimate, fitsWindow };
    };
    const projectedRequest = (messages: Messages, ctx: ExtensionContext, host: Messages, incoming: Messages, prompt: string, tools: readonly string[], cut: boolean) => {
        const enabled = cut || historyToolsEnabled(ctx), shapes = toolShapes(historyToolNames(pi, tools, enabled));
        const saved = messages.some(message => message.role === "system") ? messages :
            [{ role: "system" as const, content: prompt, toolsAdded: shapes, timestamp: 0 }, ...messages];
        const declared = enabled ? historyToolDeclarations(saved, shapes, true) : saved;
        return applyClips([...host, ...(enabled ? projectedMessages(declared, ctx, options.recallPolicy) : declared), ...incoming], clips());
    };
    const clampAboveRoom = <D extends object>(decision: Decision<D>, ctx: ExtensionContext, room: number, target: number,
        total: (decision: Decision<D>) => number, project: (decision: Decision<D>) => Messages, replan: (target: number) => Decision<D>, deepest: () => Decision<D>): Decision<D> => {
        if (options.requestReserve || !piClamp) return decision;
        const lastAttempt = (): Decision<D> => {
            const previousClips = new Map(clips());
            const candidate = deepest();
            if (candidate.kind === "cut" && fits(total(candidate), limits(ctx).hardLine, ctx) && requestClamp(project(candidate), ctx).leavesFloor)
                return candidate;
            restoreClips(previousClips);
            return { kind: "fault", capacity: true, message: clampMessage };
        };
        for (let retry = 0; ; retry++) {
            if (decision.kind !== "cut" && decision.kind !== "none") return decision;
            if (corrected(total(decision), ctx) <= room) return decision;
            const check = requestClamp(project(decision), ctx);
            if (check.leavesFloor) return decision;
            if (retry === 3) return lastAttempt();
            // Shrink in the planner's units by Pi's measured shortfall, at most three times. Once we reach the original room,
            // use its existing band/room policy; admission below the room is deliberately unchanged.
            target = Math.max(room, Math.floor(target * (contextWindow(ctx) - piMargin - limits(ctx).replyFloor) / check.estimate));
            decision = replan(target);
            if (decision.kind === "defer" || decision.kind === "fault") return lastAttempt();
        }
    };
    // Pi reports a manual cut with nothing to do as a failed compaction; the thrown error lacks the event's "Compaction failed: " prefix.
    const isNoWork = (message: string | undefined) => ["Already compacted", "Nothing to compact (session too small)"].includes(message?.replace(/^Compaction failed: /, "") ?? "");
    // A missing model is configuration, not capacity.
    const missingModel = () => new Error("No context model for the request budget");
    type CutPlan = { compaction: NonNullable<ReturnType<typeof tuckDraft>["compaction"]>; reserve: number; messages: Messages };
    const receipt = (kind: "refusal" | "above-room" | "native-floor", reason: string, ctx: ExtensionContext, check?: ReturnType<typeof requestClamp>) => {
        let room: number | null = null, hardLine: number | null = null;
        try { ({ room, hardLine } = limits(ctx)); } catch { /* Invalid configuration has no usable capacity. Preserve its original failure. */ }
        pi.appendEntry("pi-tuck-capacity", { kind, reason, estimatedTokens: calibration.estimatedTokens, room, hardLine, buildId: BUILD_ID,
            ...(check ? { piEstimateTokens: check.estimate, piCap: check.cap } : {}) });
    };
	const fail = (error: unknown, ctx: ExtensionContext) => {
		recorder.stop("native-attempt-failed");
        // Every refusal says why, once per attempt: a capacity error with what the user can change, a cut Pi failed to commit with what that
        // means for the session, anything else as it is (an attempt that ended with no word looked like a hang).
        const previous = failure();
        const fault = previous instanceof CommitFault ? previous : error instanceof Error ? error : new Error(String(error));
        const receipted = run?.refusalReceipted;
        calibration.pending = undefined;
        // Keep the same terminal run until Pi settles; later start hooks cannot admit it.
        run ??= new Run("starting"); run.clear();
        run.transition(fault instanceof CommitFault ? "commit-failed" : "failed", fault);
        run.refusalReceipted = true;
        try {
            if (!receipted) receipt("refusal", fault.message, ctx);
            options.fail?.(error);
        } finally {
            try { if (!receipted) notify(ctx, fault instanceof CapacityError ? refusalNotice(fault.message, calibration.factor) : fault instanceof CommitFault
                ? `pi-tuck: ${fault.message}; the session holds a cut its file may lack, so start a new session.`
                : `pi-tuck could not plan this request (${fault.message}); the next prompt is planned afresh.`, "error"); }
            finally { ctx.abort(); }
        }
    };

	const access = () => {
		if (failure()) throw failure();
		hostAccess();
	};
    pi.on("input", async (event, ctx) => {
        if (!ctx.isIdle() || run?.phase === "starting") return; // steering joins the existing run
        beginRun("decided");
        const decision = run!;
        try { syncHistoryTools(ctx); await preflight(ctx, incomingTokens(event.text, event.images),
            [{ role: "user", content: [{ type: "text", text: event.text }, ...(event.images ?? [])], timestamp: 0 }], ctx.getSystemPrompt(), pi.getActiveTools()); syncHistoryTools(ctx); }
        catch (error) { fail(error, ctx); }
        // Pi normally reaches its pre-run threshold check within microtasks. Auth I/O or a later extension's input I/O can make a
        // real prompt expire too; safely fall back to carrying its cut in the request and saving it at the first boundary.
        setImmediate(() => { if (run === decision && decision.phase === "decided") decision.transition("expired"); });
    });

	pi.registerTool({
		name: "tuck_recall", label: "pi-tuck history", parameters: RecallInput,
        description: "Keyword lookup locates particular text in your current branch. {query} returns ranked passages with read coordinates; punctuation separates words. Pass the returned next as {continuation} unchanged. Knowing an identifier does not itself justify narrowing discovery. {entryId} or {index} (a summary sourceIndex or #N) reads one source, optionally with query, offset and limit in UTF-16 characters (limit defaults to 8000). {} browses history; {around} expands neighbors; {entryId,image} reads an image; outputPath writes an original to a file with the native write tool. Hidden reasoning and system records are excluded.",
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

	pi.on("session_before_compact", (event, ctx) => {
		try {
			if (standDown(ctx)) return;
			if (!active()) return { cancel: true };
			if (event.signal.aborted || ctx.signal?.aborted) { recorder.stop("cut-cancelled"); return { cancel: true }; }
            // Pi checks its own threshold after a prompt's input and before the run starts: the prompt's cut, planned with the prompt counted,
            // is the answer, and it is saved before the first request.
            if ((run?.phase === "decided" || run?.phase === "claimed") && event.reason === "threshold") {
                run.transition("claimed");
                if (view(ctx).pending) {
                    access();
                    const current = view(ctx), { type: _, ...compaction } = run.cut.take(ctx)!;
                    return { compaction: { ...compaction, firstKeptEntryId: current.keptFromId! } };
                }
            }
            // Capacity is decided when there is another request to send. A threshold
            // notification after exhausted reasoning must not put that response away.
            if (event.reason === "threshold" && lengthStop?.kind === "thinking") return { cancel: true };
            const operatorManual = event.reason === "manual";
            if (operatorManual && run?.phase !== "admitted") resetRun();
			access();
			// pi-tuck's summary is built from the session itself, so text after /compact cannot steer it. The operator asked for a cut: make the one
			// plain /compact makes and say the text was not used, rather than cancel (which Pi shows as an error, with no cut).
			if (event.customInstructions?.trim()) notify(ctx, "pi-tuck: /compact ignores the text after it, since pi-tuck builds its summary from the session itself. Cutting as plain /compact does.", "info");
            const { response, room } = limits(ctx);
            const retain = operatorManual || run?.phase === "admitted";
            // A cut Pi asks for (an operator's /compact, Pi's threshold or overflow recovery) charges what the request must carry whatever is
            // cut: the system part and the host input. A prompt's cut is pi-tuck's own and never comes here.
            const saved = ctx.sessionManager.buildSessionProjection().messages;
            const hostInput = hostMessages(ctx), host = conversationTokens(hostInput);
            const systemPrompt = ctx.getSystemPrompt(), tools = pi.getActiveTools();
            const system = requestSystemPart(systemPrompt, tools, saved, systemPrompt);
            const project = (messages: Messages, cut: boolean) => projectedRequest(messages, ctx, hostInput, [], systemPrompt, tools, cut);
            const mandatory = system + host, band = decisionBand(ctx, room, system, view(ctx, event.reason === "threshold"));
            const before = plannerMeasureFor(ctx)(saved);
            observeBudget(before + mandatory, ctx);
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
            const decide = (targetRoom = room, targetBand = band) => chooseCut({
                before, mandatory, room: targetRoom, band: targetBand, fits: (tokens, limit) => fits(tokens, limit, ctx), usefulOnly: options.cutAt === undefined,
                opportunistic: thresholdOpportunistic,
                unreduced: "Compaction did not reduce context within the estimated request budget",
                plan: (target): Plan<CutPlan> => {
                    const reserve = planReserve(target, targetRoom, targetBand, mandatory, ctx);
                    // Every cut asked while no run is admitted (an operator's cut) is planned for a run that has not begun: the session has moved on
                    // from any run that ended. A retry is inside its run.
                    const draft = tuckDraft(tuck, event, ctx, reserve, plannerMeasureFor(ctx), options.recallPolicy, retain, operatorManual, operatorManual || run?.phase !== "admitted", run?.phase === "admitted" ? protectedPrompt(ctx) : undefined);
                    return draft.compaction ? { draft: true, after: draft.after, compaction: draft.compaction, reserve,
                        messages: plannedView(ctx, { type: "compaction", ...draft.compaction, tokensBefore: before }).session.buildSessionProjection().messages }
                        : { draft: false, capacityRejected: Boolean(draft.capacityRejected), reason: draft.unavailable };
                },
            });
            calibration.estimatedTokens = corrected(before + mandatory, ctx);
            let decision: Decision<CutPlan> = decide();
            const { hardLine } = limits(ctx);
            if (!operatorManual && hardLine > room && decision.kind === "fault") {
                decision = fits(before + mandatory, hardLine, ctx) ? { kind: "none" } : decide(hardLine, hardLine);
                decision = clampAboveRoom(decision, ctx, room, hardLine,
                    candidate => (candidate.kind === "cut" ? candidate.plan.after : before) + mandatory,
                    candidate => project(candidate.kind === "cut" ? candidate.plan.messages : saved, candidate.kind === "cut"),
                    target => target <= room ? decide() : decide(target, target),
                    () => deepestDecision(ctx, operatorManual || run?.phase !== "admitted", retain));
            }
            const rejected = event.reason === "overflow" && event.willRetry ? run?.rejectedBudget : undefined;
            if (rejected && decision.kind === "cut") {
                const prompt = run?.prompt;
                const canRetry = (candidate: CutPlan) => {
                    const messages = project(candidate.messages, true);
                    const { estimate, cap, leavesFloor } = requestClamp(messages, ctx);
                    const improves = leavesFloor && cap !== undefined && estimate < rejected.input &&
                        estimate + cap < rejected.input + rejected.output &&
                        fits(requestSystemPart(systemPrompt, tools, messages, systemPrompt) + conversationTokens(messages), hardLine, ctx) &&
                        (!prompt || carriesPrompt(messages, prompt.text(ctx.sessionManager.getBranch()), prompt.role));
                    recorder.capture("overflow-recovery", "estimated-before-provider-transforms", { rejected, input: estimate, output: cap, improves });
                    return improves;
                };
                if (!canRetry(decision.plan)) {
                    const previousClips = new Map(clips());
                    const deepest = deepestDecision(ctx, false, retain);
                    if (deepest.kind !== "cut" || !canRetry(deepest.plan)) {
                        restoreClips(previousClips);
                        recorder.stop("no-capacity-gain");
                        return { cancel: true };
                    }
                    decision = deepest;
                }
            }
            if (decision.kind === "cut") { return { compaction: captureDraft(decision.plan.compaction, ctx, decision.plan.reserve, event.reason, event.preparation.tokensBefore,
                retain, operatorManual, event.preparation.previousSummary, { response, host, mandatory, target: decision.target, margin: room - band }) }; }
            // An opportunistic cut inside the band that cannot reach it is no fault: the request goes to the guard.
            if (decision.kind === "none" || decision.kind === "defer") return { cancel: true };
			recorder.stop("no-cut");
            notify(ctx, decision.message, "warning");
            if (operatorManual) receipt("refusal", decision.message, ctx);
			if (!operatorManual) fail(new (decision.capacity ? CapacityError : Refusal)(decision.message), ctx);
			return { cancel: true };
		} catch (error) {
			try { fail(error, ctx); } finally { return { cancel: true }; }
		}
	});
	pi.on("session_before_tree", (event, ctx) => !standDown(ctx) && event.preparation.userWantsSummary ? { cancel: true } : undefined);
    pi.on("session_start", (_event, ctx) => { resetRun(true); recorder.stop("session-transition"); proposalId = undefined; calibration.reseed(ctx, "session"); });
    const historyToolsEnabled = (ctx: ExtensionContext) => stateFor(ctx).kind === "active" && view(ctx).hasTuckCut;
    const syncHistoryTools = (ctx: ExtensionContext) => { if (active()) applyHistoryTools(pi, historyToolsEnabled(ctx)); };
    pi.on("session_start", (_event, ctx) => syncHistoryTools(ctx));
    // A plan decided on `input` is for the branch it was decided on: moving in the tree leaves it planned for another branch, whose kept entry
    // may not be on this one.
    pi.on("session_tree", (_event, ctx) => { resetRun(); calibration.reseed(ctx, "tree"); syncHistoryTools(ctx); });
    pi.on("session_compact", (_event, ctx) => { if (run?.phase !== "admitted") syncHistoryTools(ctx); });
    pi.on("turn_start", (_event, ctx) => syncHistoryTools(ctx));
    pi.on("agent_settled", (_event, ctx) => syncHistoryTools(ctx));
    const plannedView = (ctx: ExtensionContext, cut: CutEntry) => {
        const preview = new PendingCut();
        preview.plan(cut, ctx);
        return preview.view(ctx);
    };
    // The shared final planner: preserve the compiler's prompt/protocol floor and spend nothing on optional history. Fresh text results
    // get the smallest existing head/tail + recall-locator representation; their originals remain in the session, as for ordinary clips.
    const deepestDecision = (ctx: ExtensionContext, newPrompt: boolean, retain: boolean, clipFresh = true): Decision<CutPlan> => {
        const saved = ctx.sessionManager.buildSessionProjection().messages;
        if (!newPrompt && clipFresh) {
            const at = saved.findLastIndex(message => message.role === "assistant" && !isDiscardedResponse(message));
            const response = saved[at];
            const calls = new Set(response?.role === "assistant" ? response.content.flatMap(block => block.type === "toolCall" ? [block.id] : []) : []);
            const results = saved.slice(at + 1).filter((message): message is ToolResultMessage => message.role === "toolResult" && calls.has(message.toolCallId));
            const entryIdOf = (id: string) => ctx.sessionManager.getBranch().findLast(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === id)?.id;
            for (const result of results) {
                let low = 0, high = conversationTokens([result]) - 1;
                if (!clipFor([result], entryIdOf, high).length) continue;
                while (low < high) {
                    const middle = Math.floor((low + high) / 2);
                    if (clipFor([result], entryIdOf, middle).length) high = middle; else low = middle + 1;
                }
                for (const clip of clipFor([result], entryIdOf, low)) clips().set(clip.toolCallId, clip);
            }
        }
        const before = measureFor(ctx)(saved);
        const draft = tuckObservedDraft(tuck, { branchEntries: ctx.sessionManager.getBranch(), tokensBefore: before,
            previousSummary: saved.find(message => message.role === "compactionSummary")?.summary, newPrompt, reRenderSummary: true,
            protectedPromptEntryId: newPrompt ? undefined : protectedPrompt(ctx), deepest: true }, ctx, 0, plannerMeasureFor(ctx), options.recallPolicy, retain);
        if (!draft.compaction) return { kind: "fault", capacity: Boolean(draft.capacityRejected), message: draft.unavailable };
        const messages = plannedView(ctx, { type: "compaction", ...draft.compaction }).session.buildSessionProjection().messages;
        assertNativeToolRounds(messages);
        return { kind: "cut", target: "room", plan: { draft: true, after: measureFor(ctx)(messages),
            compaction: draft.compaction, reserve: 0, messages } };
    };
    // Refusal path only: the hard line remains the cut target, but the compiler's floor may use Pi's remaining reply cap.
    // Read both the estimate and saturated clamp from the running Pi: a positive (minimum) cap alone does not prove window fit.
    // This does not relax thinking-only length recovery: retryLength still requires the observed reply floor before continuing,
    // and its pending retry cannot use this escape. No fresh content is clipped or edited by this admission attempt.
    const nativeFloorDecision = (ctx: ExtensionContext, newPrompt: boolean, retain: boolean,
        project: (candidate: Decision<CutPlan>) => Messages): Extract<Decision<CutPlan>, { kind: "cut" }> | undefined => {
        if (options.requestReserve || options.activeInputTokens !== undefined || !piMath || run?.lengthRetryPending) return;
        const candidate = deepestDecision(ctx, newPrompt, retain, false);
        if (candidate.kind !== "cut") return;
        const messages = project(candidate);
        if (run?.prompt && !carriesPrompt(messages, run.prompt.text(ctx.sessionManager.getBranch()), run.prompt.role)) return;
        if (requestClamp(messages, ctx).fitsWindow) return candidate;
    };
    // The cut before a run, decided on `input` while the session is idle; before_agent_start decides only for a run no input started (one a
    // custom message starts). The cut is pi-tuck's own, planned as at a tool boundary. It is not Pi's: Pi's cut finder keeps the last
    // keepRecentTokens, and where those are the whole conversation it has nothing to cut, so every later prompt was refused for good (t06 at
    // Pi's defaults on a 32k window). Each request carries the cut until the next boundary saves it. A late steer uses the same path with
    // its existing run owner's entry protected; an incoming prompt that starts a run has no saved owner yet.
    const preflight = (ctx: ExtensionContext, incomingPart: number, incomingMessages: Messages, observedPrompt: string, tools: readonly string[], hostSnapshot?: Messages, protectedId?: string) => {
        if (standDown(ctx)) return;
        run!.cut.clear();
        run!.nativeFloorPending = false;
        if (!active()) return;
        access();
        if (!settingsFor().getCompactionSettings(ctx.model).enabled) return;
        if (!ctx.model) throw missingModel();
        const { response, room } = limits(ctx);
        // Public early view only: later handlers, image normalization and tool-loop growth remain the complete-context guard's responsibility.
        const saved = ctx.sessionManager.buildSessionProjection().messages;
        const system = requestSystemPart(observedPrompt, tools, saved, ctx.getSystemPrompt());
        const band = decisionBand(ctx, room, system);
        const hostInput = hostSnapshot ?? hostMessages(ctx), host = conversationTokens(hostInput), measure = measureFor(ctx), before = measure(saved);
        const incoming = incomingPart + system, mandatory = incoming + host;
        observeBudget(before + mandatory, ctx);
        calibration.estimatedTokens = corrected(before + mandatory, ctx);
        if (!fits(incoming, limits(ctx).hardLine, ctx))
            throw new CapacityError("Incoming Pi prompt and response reserve cannot fit the estimated request budget");
        // A cut removes only conversation. If the mandatory request, host input included, does not fit by itself, no cut can
        // help: leave it to the complete-context guard, which fails closed.
        const gate = gateCut({ total: before + mandatory, mandatory, room, band, fits: (tokens, limit) => fits(tokens, limit, ctx) });
        if (gate.kind === "none") return;
        const previousSummary = saved.find(message => message.role === "compactionSummary")?.summary;
        const decide = (targetRoom: number, targetBand: number, opportunistic: boolean) => chooseCut({
            before, mandatory, room: targetRoom, band: targetBand, fits: (tokens, limit) => fits(tokens, limit, ctx), usefulOnly: options.cutAt === undefined, opportunistic,
            unreduced: "Incoming prompt compaction did not reduce context within the estimated request budget",
            plan: (target): Plan<CutPlan> => {
                const reserve = planReserve(target, targetRoom, targetBand, mandatory, ctx);
                // Only a due cut re-renders a summary that sits alone in the session: inside the band a cut is opportunistic, and a smaller summary
                // there buys nothing the request needed and costs history the next recall would have found.
                // A steer joins the admitted run: keep its starting prompt and the unexposed tool round, just as at a tool boundary.
                const draft = tuckObservedDraft(tuck, { branchEntries: ctx.sessionManager.getBranch(), tokensBefore: before, previousSummary,
                    newPrompt: !protectedId, protectedPromptEntryId: protectedId, reRenderSummary: !opportunistic }, ctx, reserve, plannerMeasureFor(ctx), options.recallPolicy, Boolean(protectedId));
                if (!draft.compaction) return { draft: false, capacityRejected: Boolean(draft.capacityRejected), reason: draft.unavailable };
                const candidate = new PendingCut();
                candidate.plan({ type: "compaction", ...draft.compaction, tokensBefore: before }, ctx);
                const messages = candidate.view(ctx).session.buildSessionProjection().messages;
                assertNativeToolRounds(messages);
                return { draft: true, after: measure(messages), compaction: draft.compaction, reserve, messages };
            },
        });
        let decision: Decision<CutPlan> = gate.kind === "plan" ? decide(room, band, gate.opportunistic) : { kind: "defer" };
        const { hardLine } = limits(ctx);
        if (hardLine > room && (decision.kind === "defer" || decision.kind === "fault")) {
            decision = fits(before + mandatory, hardLine, ctx) ? { kind: "none" } :
                fits(mandatory, hardLine, ctx) ? decide(hardLine, hardLine, false) : { kind: "defer" };
            decision = clampAboveRoom(decision, ctx, room, hardLine,
                candidate => (candidate.kind === "cut" ? candidate.plan.after : before) + mandatory,
                candidate => projectedRequest(candidate.kind === "cut" ? candidate.plan.messages : saved, ctx, hostInput, incomingMessages, observedPrompt, tools, candidate.kind === "cut"),
                target => decide(target, target <= room ? band : target, false),
                () => deepestDecision(ctx, !protectedId, Boolean(protectedId)));
        }
        if (decision.kind === "defer") return;
        // An opportunistic cut inside the band that cannot reach it is no fault: the request goes to the guard.
        if (decision.kind === "none") return;
        if (decision.kind === "fault" && decision.capacity) {
            const floor = nativeFloorDecision(ctx, !protectedId, Boolean(protectedId),
                candidate => projectedRequest(candidate.kind === "cut" ? candidate.plan.messages : saved, ctx, hostInput, incomingMessages, observedPrompt, tools, true));
            if (floor) { decision = floor; run!.nativeFloorPending = true; }
        }
        if (decision.kind === "fault") throw new (decision.capacity ? CapacityError : Refusal)(decision.message);
        const compaction = captureDraft(decision.plan.compaction, ctx, decision.plan.reserve, "prompt", before, Boolean(protectedId), false, previousSummary,
            { response, host, mandatory, target: decision.target, margin: room - band });
        run!.cut.plan({ type: "compaction", summary: compaction.summary, firstKeptEntryId: compaction.firstKeptEntryId, tokensBefore: before, details: compaction.details }, ctx);
    };
    pi.on("before_agent_start", async (event, ctx) => {
        if (standDown(ctx)) return;
        // A decided plan is for the prompt `input` saw. A run that a custom message starts is not that run (another extension handled the
        // input, so no run started for it): plan afresh.
        const prompted = run && ["decided", "claimed", "expired"].includes(run.phase) && event.messageType !== "custom";
        if (!prompted && !failure()) beginRun("starting");
        run ??= new Run("starting");
        if (!failure() && run.phase !== "starting") run.transition("starting");
        const prompt = event.messageType === "custom" ? textOf(event.message.content) : event.prompt;
        run.prompt = prompt ? new StartingPrompt(prompt, ctx.sessionManager.getBranch().length, event.messageType) : undefined;
        try {
            syncHistoryTools(ctx);
            if (prompted) access(); // decided on input; a failure latched there still stops the run
            else await preflight(ctx, incomingEventTokens(event), [{ role: "user", timestamp: 0,
                content: event.messageType === "custom" ? event.message.content : [{ type: "text", text: event.prompt }, ...(event.images ?? [])] }], event.systemPrompt,
                historyToolNames(pi, event.systemPromptOptions.selectedTools, historyToolsEnabled(ctx)));
            // Pi declares tool changes before turn_start, then snapshots executable tools in prepareRequest. Introduce our tools in
            // the request projection: recording an activation message here would shift every later session-global recall index.
            if (historyToolsEnabled(ctx)) stageHistoryTools(pi, ctx.sessionManager.buildSessionProjection().messages);
            else applyHistoryTools(pi, false);
            const staged = pi.getActiveTools();
            event.systemPromptOptions.selectedTools = historyToolNames(pi, event.systemPromptOptions.selectedTools, true).filter(name =>
                name !== "tuck_recall" || staged.includes(name));
        } catch (error) { fail(error, ctx); }
    });
    // The incoming user message is about to be appended (including steering inside a run), and later before_agent_start/turn_start
    // handlers have run. Pi's prepareRequest has not yet snapshotted executable tools. A first cut discovered in context_with_system
    // would be too late for that snapshot, even if its declarations were repaired there, so make the late prompt decision here.
    pi.on("message_end", (event, ctx) => {
        if (standDown(ctx)) return;
        if (event.message.role !== "user" || !active() || run?.phase !== "admitted" || view(ctx).pending) return;
        try {
            access();
            if (!ctx.model) throw missingModel();
            const message = event.message;
            const incoming = incomingTokens(typeof message.content === "string" ? message.content : message.content.flatMap(b => b.type === "text" ? [b.text] : []).join("\n"),
                typeof message.content === "string" ? [] : message.content.filter((b): b is ImageContent => b.type === "image"));
            const saved = ctx.sessionManager.buildSessionProjection().messages;
            const hostInput = hostMessages(ctx), host = conversationTokens(hostInput);
            const system = requestSystemPart(ctx.getSystemPrompt(), pi.getActiveTools(), saved, ctx.getSystemPrompt());
            if (fits(conversationTokens(saved) + system + incoming + host, limits(ctx).room, ctx)) return;
            preflight(ctx, incoming, [message], ctx.getSystemPrompt(), pi.getActiveTools(), hostInput, protectedPrompt(ctx));
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
        const hostInput = hostMessages(ctx), host = conversationTokens(hostInput);
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
            !isDiscardedResponse(message) && message.usage && calculateContextTokens(message.usage) > 0)) {
            const forecast = historyToolDeclarations(saved, toolShapes(historyToolNames(pi, pi.getActiveTools(), true)), true);
            if (forecast !== saved) {
                const head = getCurrentSystemMessage(convertToLlm(forecast));
                const native = (head ? estimateTokens(head) : 0) + saved.reduce((sum, message) => sum + (message.role === "system" ? 0 : estimateTokens(message)), 0);
                if (shouldCompact(native, contextWindow(ctx), settingsFor().getCompactionSettings(ctx.model))) densityTokens = native;
            }
        }
        const previousSummary = saved.find(message => message.role === "compactionSummary")?.summary;
        // The cut previews this decision has built, in the order it built them. The clip retry below measures them for what a cut leaves the
        // request besides the fresh results. Reset per decision, so a retry sizes itself against the cut it is retrying, not an earlier attempt's.
        let previews: Messages[] = [];
        let floorKept: number | undefined;
        const protectedId = reason === "tool-loop" ? protectedPrompt(ctx) : undefined;
        const decide = (targetRoom = room, targetBand = band, required = false) => {
            previews = [];
            floorKept = undefined;
            const before = measure(saved);
            const gate = required && fits(mandatory, targetRoom, ctx) ? { kind: "plan" as const, opportunistic: false } :
                gateCut({ total: before + mandatory, mandatory, room: targetRoom, band: targetBand, fits: (tokens, limit) => fits(tokens, limit, ctx) });
            if (gate.kind !== "plan") return gate;
            return chooseCut({
            opportunistic: gate.opportunistic, mandatory, before, room: targetRoom, band: targetBand, fits: (tokens, limit) => fits(tokens, limit, ctx), usefulOnly: options.cutAt === undefined,
            unreduced: "Tool-loop preflight compaction did not reduce context within the estimated request budget",
            plan: (target): Plan<CutPlan> => {
                const reserve = planReserve(target, targetRoom, targetBand, mandatory, ctx);
                const draft = tuckObservedDraft(tuck, { branchEntries: ctx.sessionManager.getBranch(), tokensBefore: densityTokens ?? before, previousSummary, protectedPromptEntryId: protectedId }, ctx, reserve, plannerMeasureFor(ctx), options.recallPolicy, true);
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
                const messages = plannedView(ctx, { type: "compaction", ...draft.compaction, tokensBefore: before }).session.buildSessionProjection().messages;
                assertNativeToolRounds(messages);
                previews.push(messages);
                return { draft: true, after: measure(messages), compaction: draft.compaction, reserve, messages };
            },
            });
        };
        let decision: Decision<CutPlan> = decide();
        // Only a request that would be refused is clipped. A fresh result is kept whole by every cut (it has not reached the model yet), so a round
        // larger than the room refuses the run; in its place the request carries the result's head and tail with a tuck_recall locator to the rest.
        // clipBudgets states the budgets tried and why they are counted in the estimate's units; `kept` is measured from the previews this decision
        // built, so the second budget is the cut's own floor and not a new formula. When nothing is clipped or the decision still faults, the
        // refusal stands.
        const tryClips = (clipRoom: number, targetBand: number, required = false) => {
            if (decision.kind !== "fault" || !event.toolResults) return;
            const branch = ctx.sessionManager.getBranch();
            const entryIdOf = (toolCallId: string) => branch.findLast(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolCallId === toolCallId)?.id;
            const fresh = new Set(event.toolResults.map(result => result.toolCallId));
            const kept = previews.length ? Math.max(...previews.map(preview => measure(preview.filter(message =>
                !(message.role === "toolResult" && fresh.has((message as ToolResultMessage).toolCallId)))))) : floorKept;
            for (const budget of clipBudgets(clipRoom, calibration.factor, mandatory, kept)) {
                const round = clipFor(event.toolResults, entryIdOf, budget);
                if (!round.length) continue;
                for (const clip of round) run!.clips.set(clip.toolCallId, clip);
                const clippedDecision = decide(clipRoom, targetBand, required);
                if (clippedDecision.kind === "fault") for (const clip of round) run!.clips.delete(clip.toolCallId);
                else { decision = clippedDecision; break; }
            }
        };
        tryClips(room, band);
        const before = measure(saved);
        observeBudget(before + mandatory, ctx);
        calibration.estimatedTokens = corrected(before + mandatory, ctx);
        const { hardLine } = limits(ctx);
        if (hardLine > room && (decision.kind === "defer" || decision.kind === "fault")) {
            if (fits(before + mandatory, hardLine, ctx)) decision = { kind: "none" };
            else { decision = decide(hardLine, hardLine); tryClips(hardLine, hardLine); }
            decision = clampAboveRoom(decision, ctx, room, hardLine,
                candidate => (candidate.kind === "cut" ? candidate.plan.after : before) + mandatory,
                candidate => projectedRequest(candidate.kind === "cut" ? candidate.plan.messages : saved, ctx, hostInput, event.context.pendingMessages as Messages, ctx.getSystemPrompt(), pi.getActiveTools(), candidate.kind === "cut"),
                target => {
                    const targetBand = target <= room ? band : target;
                    decision = decide(target, targetBand, target > room);
                    tryClips(target, targetBand, target > room);
                    return decision;
                }, () => deepestDecision(ctx, false, true));
        }
        if (decision.kind === "fault" && reason === "tool-loop") {
            if (decision.capacity) decision = nativeFloorDecision(ctx, false, true,
                candidate => projectedRequest(candidate.kind === "cut" ? candidate.plan.messages : saved, ctx, hostInput,
                    event.context.pendingMessages as Messages, ctx.getSystemPrompt(), pi.getActiveTools(), true)) ?? decision;
        }
        if (decision.kind === "fault" && reason === "tool-loop") {
            if (protectedId && run?.prompt && !fits(incomingTokens(run.prompt.text(ctx.sessionManager.getBranch()), []), room, ctx)) throw promptRefusal();
            if (decision.capacity) throw new CapacityError("The fresh tool round and required context exceed the estimated request budget");
            throw new Refusal(decision.message);
        }
        if (decision.kind !== "cut") return;
        const compaction = captureDraft(decision.plan.compaction, ctx, decision.plan.reserve, reason, before, true, false, previousSummary,
            { response, host, mandatory, target: decision.target, margin: room - band });
        return { entries: [{ type: "compaction" as const, summary: compaction.summary,
            firstKeptEntryId: compaction.firstKeptEntryId, details: compaction.details }] };
    };
    // A boundary's cut. The run's first boundary also saves the prompt's cut, after any entries an earlier handler proposed, and decides on
    // the session as it is with that cut: a fresh result can still need a cut of its own there.
    type Boundary = Parameters<typeof boundaryCut>[0];
    const markBoundary = (entries: readonly SessionBoundaryDraft[]) => {
        if (!run) return;
        run.pendingBoundaryReceipts = entries.flatMap(entry => entry.type === "compaction" ? receiptId(entry) ?? [] : []);
    };
    const boundarySaved = (ctx: ExtensionContext) => {
        const wanted = run?.pendingBoundaryReceipts ?? [];
        const file = ctx.sessionManager.getSessionFile();
        // appendCompaction mutates memory before writing. On an error boundary, only the persisted entries prove a file-backed cut saved.
        const entries: SessionEntry[] = file ? readFileSync(file, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : ctx.sessionManager.getBranch();
        const saved = new Set(entries.flatMap(entry => entry.type === "compaction" ? receiptId(entry) ?? [] : []));
        return wanted.every(id => saved.has(id));
    };
    const atBoundary = (event: Boundary, ctx: ExtensionContext, reason: "tool-loop" | "run-end", decide: boolean) => {
        const current = view(ctx);
        if (!current.pending) return decide ? boundaryCut(event, ctx, reason) : undefined;
        const entry = run!.cut.take(ctx)!;
        const preview = current.session, context: ExtensionContext = Object.create(ctx, { sessionManager: { value: preview } });
        const more = decide && !event.entries.length
            ? boundaryCut({ ...event, context: { ...event.context, contextMessages: preview.buildSessionProjection().messages } }, context, reason) : undefined;
        const { tokensBefore: _, ...cut } = entry;
        const saved = { ...cut, firstKeptEntryId: current.keptFromId! };
        return { entries: [...event.entries as CutEntry[], saved, ...(more?.entries ?? [])] };
    };
    const retryLength = (event: TurnEndEvent, ctx: ExtensionContext) => {
        // Exhausting the full per-request allowance is not evidence that input is too large.
        // Preserve the unfinished response; provider-native continuation owns this case.
        // Native Pi does not compact-and-retry output that reached the catalogue cap.
        if (event.message.role !== "assistant" || !ctx.model) return;
        const stoppedOutput = event.message.usage?.output;
        if (stoppedOutput >= ctx.model.maxTokens) {
            return { entries: event.entries, continue: false };
        }
        // Pi's supported boundary drafts commit before finishTurn honors `continue`. Omitting the selected failed response also prevents
        // Pi's later native length recovery from retrying it independently. The stored message and its output usage stay on the branch.
        const entries: SessionBoundaryDraft[] = [...(atBoundary(event, ctx, "run-end", false)?.entries ?? event.entries),
            { type: "context_edit", targetId: event.messageEntryId, replacement: null }];
        if (!run!.canRetryLength) { markBoundary(entries); return { entries, continue: false }; }
        const preview = liveCut.view(ctx, entries).session;
        const view: ExtensionContext = Object.create(ctx, { sessionManager: { value: preview } });
        const hostInput = hostMessages(ctx), host = conversationTokens(hostInput);
        const asIs = projectedRequest(preview.buildSessionProjection().messages, view, hostInput, event.context.pendingMessages, ctx.getSystemPrompt(), pi.getActiveTools(), false);
        const asIsCheck = requestClamp(asIs, view);
        const previousClips = new Map(clips());
        const decision = deepestDecision(view, false, true);
        const cut = decision.kind === "cut" ? {
            ...decision,
            messages: projectedRequest(decision.plan.messages, view, hostInput, event.context.pendingMessages, ctx.getSystemPrompt(), pi.getActiveTools(), true),
        } : undefined;
        const check = cut && requestClamp(cut.messages, view);
        // An unchanged allowance would repeat the same failed generation. If the
        // planner found no history to cut, there is no capacity diagnosis to make.
        if (!cut || check?.cap === undefined || asIsCheck.cap === undefined || check.cap <= Math.max(asIsCheck.cap, stoppedOutput ?? 0)) {
            restoreClips(previousClips);
            if (!asIsCheck.leavesFloor) {
                if (check && !check.leavesFloor) throw new CapacityError(clampMessage);
                if (decision.kind === "fault" && decision.capacity) throw new CapacityError(decision.message);
            }
            markBoundary(entries);
            return { entries, continue: false };
        }
        const { messages } = cut;
        if (run?.prompt && !carriesPrompt(messages, run.prompt.text(ctx.sessionManager.getBranch()), run.prompt.role)) throw promptRefusal();
        const system = requestSystemPart(ctx.getSystemPrompt(), pi.getActiveTools(), messages, ctx.getSystemPrompt());
        const tokens = system + conversationTokens(messages);
        const { response, room, hardLine } = limits(view);
        if (!fits(tokens, hardLine, view) || !check.leavesFloor) throw new CapacityError(clampMessage);
        const compaction = captureDraft(cut.plan.compaction, view, cut.plan.reserve, "length-retry", tokens, true, false, undefined,
            { response, host, mandatory: system + host + conversationTokens(event.context.pendingMessages), target: cut.target, margin: room - decisionBand(view, room, system) });
        run!.requestLengthRetry();
        const drafts = [...entries, { type: "compaction" as const, summary: compaction.summary, firstKeptEntryId: compaction.firstKeptEntryId || null, details: compaction.details },
            { type: "custom" as const, customType: "pi-tuck-capacity", data: { kind: "retry", stoppedReplyEntryId: event.messageEntryId,
                stoppedOutputTokens: stoppedOutput ?? 0, cut: true,
                estimatedTokens: corrected(tokens, view), piEstimateTokens: check.estimate, piCap: check.cap, room, hardLine, buildId: BUILD_ID } }];
        markBoundary(drafts);
        return { entries: drafts, continue: true };
    };
    pi.on("turn_end", (event, ctx) => {
        try {
            if (standDown(ctx)) return;
            if (!active() || run?.phase !== "admitted") return;
            if (thinkingOnlyLength(event.message) && !ctx.signal?.aborted && settingsFor().getCompactionSettings(ctx.model).enabled)
                return retryLength(event, ctx);
            run.finishLengthRetry();
            const decide = event.outcome === "completed" && !ctx.signal?.aborted && event.context.canContinue && event.toolResults.length > 0 &&
                settingsFor().getCompactionSettings(ctx.model).enabled;
            if (!view(ctx).pending && !decide) return;
            const result = atBoundary(event, ctx, "tool-loop", decide);
            if (result) {
                markBoundary(result.entries);
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
    const projectContext = (messages: Messages, ctx: ExtensionContext, enabled = historyToolsEnabled(ctx)) =>
        applyClips(enabled ? projectedMessages(messages, ctx, options.recallPolicy) : messages, clips());
    // Replace only the saved conversation, preserving other handlers' surrounding messages. At the final guard the saved side is already
    // projected. Replay system state as Pi does after a changed `context` result, so interleaved prompt/tool updates survive the cut too.
    const cutRequest = (messages: Messages, ctx: ExtensionContext, saved = ctx.sessionManager.buildSessionProjection().messages,
        kept = view(ctx).session.buildSessionProjection().messages): Messages => {
        const conversation = (all: Messages) => all.filter(message => message.role !== "system");
        const source = conversation(saved), request = conversation(messages);
        for (let at = 0; at + source.length <= request.length; at++)
            if (source.every((message, i) => isDeepStrictEqual(request[at + i], message))) {
                const reduced = [...request.slice(0, at), ...conversation(kept), ...request.slice(at + source.length)];
                const head = getCurrentSystemMessage(messages.filter(message => message.role === "system"));
                return head ? [head, ...reduced] : reduced;
            }
        throw new Error("The prompt's cut cannot be applied: the request does not carry the saved conversation");
    };
    // A late cut prices everything outside the saved conversation from this request itself. Its pending view is carried now and saved by
    // atBoundary, just like a prompt cut; the existing final checks still decide admission on the rebuilt request.
    const guardCut = (messages: Messages, tokens: number, system: number, ctx: ExtensionContext): { messages: Messages; native?: boolean } => {
        const saved = ctx.sessionManager.buildSessionProjection().messages, source = projectContext(saved, ctx);
        const before = conversationTokens(source), mandatory = tokens - before;
        const { response, room, hardLine } = limits(ctx), band = decisionBand(ctx, room, system);
        const previousSummary = saved.find(message => message.role === "compactionSummary")?.summary;
        const previousClips = new Map(clips());
        const measure = measureFor(ctx);
        const decide = (targetRoom: number, targetBand: number): Decision<CutPlan> => !fits(mandatory, targetRoom, ctx) ? { kind: "defer" } : chooseCut({
            before, mandatory, room: targetRoom, band: targetBand, fits: (tokens, limit) => fits(tokens, limit, ctx), opportunistic: false,
            unreduced: "Tool-loop preflight compaction did not reduce context within the estimated request budget",
            plan: (target): Plan<CutPlan> => {
                const reserve = planReserve(target, targetRoom, targetBand, mandatory, ctx);
                const draft = tuckObservedDraft(tuck, { branchEntries: ctx.sessionManager.getBranch(), tokensBefore: before, previousSummary,
                    protectedPromptEntryId: protectedPrompt(ctx) }, ctx, reserve, plannerMeasureFor(ctx), options.recallPolicy, true);
                if (!draft.compaction) return { draft: false, capacityRejected: Boolean(draft.capacityRejected), reason: draft.unavailable };
                const kept = plannedView(ctx, { type: "compaction", ...draft.compaction, tokensBefore: before }).session.buildSessionProjection().messages;
                assertNativeToolRounds(kept);
                return { draft: true, after: measure(kept), compaction: draft.compaction, reserve, messages: kept };
            },
        });
        const project = (candidate: Decision<CutPlan>) => candidate.kind === "cut"
            ? historyToolDeclarations(cutRequest(messages, ctx, source, projectContext(candidate.plan.messages, ctx, true)),
                toolShapes(historyToolNames(pi, pi.getActiveTools(), true)), true) : messages;
        const total = (candidate: Decision<CutPlan>) => (candidate.kind === "cut" ? candidate.plan.after : before) + mandatory;
        let decision = decide(room, band);
        if (hardLine > room && (decision.kind === "defer" || decision.kind === "fault")) {
            decision = decide(hardLine, hardLine);
            decision = clampAboveRoom(decision, ctx, room, hardLine, total, project,
                target => decide(target, target <= room ? band : target), () => deepestDecision(ctx, false, true));
        }
        const accepts = (candidate: Decision<CutPlan>) => {
            if (candidate.kind !== "cut" || candidate.plan.after >= before) return false;
            const request = project(candidate);
            const reduced = requestSystemPart(ctx.getSystemPrompt(), pi.getActiveTools(), request, ctx.getSystemPrompt()) + conversationTokens(request);
            return fits(reduced, hardLine, ctx) && (Boolean(options.requestReserve) || corrected(reduced, ctx) <= room || requestClamp(request, ctx).leavesFloor);
        };
        if (!accepts(decision)) decision = deepestDecision(ctx, false, true);
        let native = false;
        if (decision.kind !== "cut" || !accepts(decision)) {
            restoreClips(previousClips);
            const floor = nativeFloorDecision(ctx, false, true, project);
            if (!floor) return { messages };
            decision = floor;
            native = true;
        }
        if (decision.kind !== "cut") return { messages };
        const compaction = captureDraft({ ...decision.plan.compaction, tokensBefore: before }, ctx, decision.plan.reserve, "tool-loop", before, true, false, previousSummary,
            { response, host: conversationTokens(hostMessages(ctx)), mandatory, target: decision.target, margin: room - band });
        run!.cut.plan({ type: "compaction", ...compaction, tokensBefore: before }, ctx);
        run!.nativeFloorPending = native;
        syncHistoryTools(ctx);
        return { messages: historyToolDeclarations(cutRequest(messages, ctx, source, projectContext(view(ctx).session.buildSessionProjection().messages, ctx)),
            toolShapes(pi.getActiveTools()), true), native };
    };
    pi.on("context", (event, ctx) => {
        try {
            if (standDown(ctx)) return;
            if (!active()) return;
            run?.prompt?.id(ctx.sessionManager.getBranch());
            // Before a cut, Pi owns the whole request, including its object identities and system-message serialization.
            if (!historyToolsEnabled(ctx)) return clips().size ? { messages: applyClips(event.messages, clips()) } : undefined;
            access();
            return { messages: projectContext(view(ctx).pending ? cutRequest(event.messages, ctx) : event.messages, ctx) };
        } catch (error) { try { fail(error, ctx); } finally { return historyToolsEnabled(ctx) ? { messages: [] } : undefined; } }
    });
	pi.on("session_compact_failed", (event, ctx) => {
        if (standDown(ctx)) return;
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
        if (standDown(ctx)) return;
        if (run?.pendingBoundaryReceipts.length) {
            if (event.outcome === "error") {
                try { if (!boundarySaved(ctx)) throw new Error("Boundary receipt absent from the session file"); }
                catch { return void fail(new CommitFault("Native tool-loop boundary cut was not saved in the session file"), ctx); }
            }
            if (run) { run.pendingBoundaryReceipts = []; }
        }
        // Pi commits these entries before the run settles.
        try {
            if (!active() || run?.phase !== "admitted" || failure() || !settingsFor().getCompactionSettings(ctx.model).enabled) return;
            const decide = event.outcome === "completed" && !ctx.signal?.aborted && lengthStop?.kind !== "thinking";
            if (view(ctx).pending ? event.outcome === "error" : !decide) return;
            return atBoundary(event, ctx, "run-end", decide);
        } catch (error) { fail(error, ctx); }
    });
	pi.on("context_with_system", (event, ctx) => {
        if (standDown(ctx)) return;
        // Reaching the next request boundary proves native commit returned, not durable storage.
        if (run) {
            run.pendingBoundaryReceipts = [];
            run.rejectedBudget = undefined;
        }
        calibration.pending = undefined;
		try {
			if (!active()) return;
			access();
            observe(ctx);
			assertNativeToolRounds(event.messages);
			if (!ctx.model) throw missingModel();
			// The complete request, counted after Pi's conversion (summary/custom/bash envelopes), with the effective system once.
			// Pi applies a forced prompt after this hook; the public prompt already observes it.
            syncHistoryTools(ctx);
            let messages = historyToolsEnabled(ctx) ? historyToolDeclarations(event.messages, toolShapes(pi.getActiveTools()), true) : event.messages;
            let system = requestSystemPart(ctx.getSystemPrompt(), pi.getActiveTools(), messages, ctx.getSystemPrompt());
            let tokens = system + conversationTokens(messages);
            const { room, hardLine } = limits(ctx);
            let native = false;
            const wouldRefuse = !fits(tokens, hardLine, ctx) || !options.requestReserve && corrected(tokens, ctx) > room &&
                piClamp && !requestClamp(messages, ctx).leavesFloor;
            if (wouldRefuse && run?.phase === "admitted" && !view(ctx).pending && settingsFor().getCompactionSettings(ctx.model).enabled) {
                const cut = guardCut(messages, tokens, system, ctx);
                messages = cut.messages;
                native = Boolean(cut.native);
                system = requestSystemPart(ctx.getSystemPrompt(), pi.getActiveTools(), messages, ctx.getSystemPrompt());
                tokens = system + conversationTokens(messages);
                assertNativeToolRounds(messages);
            }
            observeBudget(tokens, ctx);
            calibration.estimatedTokens = corrected(tokens, ctx);
            if (run?.prompt && !carriesPrompt(messages, run.prompt.text(ctx.sessionManager.getBranch()), run.prompt.role))
                throw new Refusal("Prompt check failed: the request is missing the whole text of the prompt that started this run. Shorten the prompt or choose a model with a larger context window, then retry");
            // A floor already planned at input is pending here; recheck the exact complete request with Pi's own math.
            native ||= Boolean(wouldRefuse && view(ctx).pending && run?.nativeFloorPending);
            native &&= requestClamp(messages, ctx).fitsWindow;
            if (!native && !fits(tokens, hardLine, ctx))
				throw new CapacityError("Complete Pi context and response reserve exceed the estimated request budget");
            // Ordinary admission above the room also asks Pi's real clamp to preserve the reply floor;
            // only the refusal-path compiler floor may instead use native window admission.
            if (!native && !options.requestReserve && calibration.estimatedTokens > room && piClamp && !requestClamp(messages, ctx).leavesFloor)
                throw new CapacityError(clampMessage);
            if (native) receipt("native-floor", "Planner floor fits Pi's native request limit after ordinary admission failed", ctx, requestClamp(messages, ctx));
            else if (calibration.estimatedTokens > room) receipt("above-room", "Request exceeds the room and fits the hard line", ctx);
            if (recorder.enabled && !recorder.waitingForCut) recorder.measureInline(() => {
                recorder.request();
                // No system prompt or hidden assistant blocks; no provider payload/headers.
                const permitted = messages.filter(m => m.role !== "system" &&
                    !(m.role === "assistant" && m.content.some(b => b.type === "thinking")) &&
                    !(m.role === "custom" && options.recallPolicy?.privateCustomTypes?.includes(m.customType)));
                recorder.capture("prepared-request", "public-context-with-system-hook-before-later-transforms-not-wire", { messages: permitted, estimatedInputTokens: tokens }, permitted.length !== event.messages.length);
            });
            if (tokens > 0 && Number.isSafeInteger(tokens)) calibration.pending = {
                identity: identityFor(ctx), tokens, messages, snapshot: structuredClone(convertToLlm(messages)),
            };
            if (messages !== event.messages) return { messages };

		} catch (error) { fail(error, ctx); }
	});
    return {close:async()=>{recorder.stop("caller-close");}, state: stateFor, inspectState: (ctx: ExtensionContext) => ({ run: run as Readonly<Run> | undefined, phase: run?.phase, calibrationIdentity: calibration.identity, pendingCut: view(ctx).pending })};
}

function checkedInput(raw: unknown) { if (!Check(RecallInput, raw)) throw new Error("Invalid recall input"); return structuredClone(raw); }
