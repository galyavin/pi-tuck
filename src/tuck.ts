import { resolveSourceTime, type SourceTime } from "./tuck/core/source-time";
import { orderByOriginalSource } from "./tuck/core/source-order";
import { assertNativeToolRounds, isDiscardedResponse } from "./protocol.js";
import { parseRecords, serializeTranscript, splitSummary, type TranscriptRecord } from "./tuck/core/transcript";
import { DIALOGUE_SUFFIX } from "./tuck/core/format";
import { isTextOnly, textOf } from "./tuck/core/content";
import { MAX_TASK_CONTRACT_CHARACTERS, actionItems, actionRecords, head, ledgerItems, ledgerRecords } from "./ledger.js";
import type { Message } from "@earendil-works/pi-ai";
import { convertToLlm, SessionManager, type ExtensionContext,
	type SessionBeforeCompactEvent, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { ATTEMPT_NOTICE, createRecall, type RecallPolicy,
	type PreparedKeywordQuery, type RecordedAttempt, type RecallOptions } from "./recall.js";

type AgentMessage = Parameters<typeof convertToLlm>[0][number];
type Cut = import("./tuck/cut").OwnCutResult;
/** Counts a projection of the conversation exactly as the triggers, the post-cut checks and the guard do (budget.ts). */
export type Measure = (messages: AgentMessage[]) => number;
/** The summary view that produced a draft: the whole pre-cut dialogue, or the same dialogue shrunk to the allowance. Both carry the file ledger. */
export type DraftMode = "dialogue" | "shrunk";
type Draft = { compaction: Pick<Extract<SessionEntry, { type: "compaction" }>, "summary" | "firstKeptEntryId" | "tokensBefore" | "details">; after: number; mode: DraftMode; unavailable?: never; capacityRejected?: never }
    // The actual floor projection lets the caller measure it without the fresh results it may clip.
    | { compaction?: never; mode?: never; unavailable: string; capacityRejected?: boolean; floorMessages?: AgentMessage[] };
interface SearchHit { index: number; role: string; summary: string }
export interface RecallContinuation { query: string; throughEntryId: string; offset: number }
/** Includes JSON escaping, hit metadata and continuation, not just excerpt text. */
export const MAX_RANKED_RESPONSE_CHARACTERS = 16000;
/** Deliberately narrow contract with the pinned pi-tuck source exports. No standalone hooks are installed. */
export interface Tuck {
	buildOwnCut(entries: SessionEntry[], keep: number): Cut;
	applyTailBudget(entries: SessionEntry[], cut: Extract<Cut, { ok: true }>, options: { charsPerToken: number; maxTokens?: number; oversizedFactor?: number }): Cut;
	calibrateCharsPerToken(chars: number, tokens: number): { charsPerToken: number };
	buildGlobalIndexById(entries: readonly SessionEntry[]): Map<string, number>;
	/** The dialogue shrunk to `ranking.maxBriefChars`, oldest assistant text first; "" when not even the least of it fits. */
	compileShrunkDialogue(input: { messages: AgentMessage[]; sourceIndices: (number | undefined)[]; sourceEntryIds?: readonly string[]; sourceTimes?: readonly SourceTime[];
		receiptContext?: { messages: AgentMessage[]; sourceIndices: (number | undefined)[] };
		ranking: { maxBriefChars: number; mandatorySourceIndices?: ReadonlySet<number> } }): string;
	/** The whole pre-cut dialogue view; "" offers none, and the shrunk view is used. */
	compileDialogue(input: Parameters<Tuck["compileShrunkDialogue"]>[0]): string;
	prepareKeywordQuery(query: string): PreparedKeywordQuery;
	searchEntriesDetailed(entries: SearchHit[], messages: Message[], query: string,
		tuning: { relativeFloor: number; cap: number }): {
		hits: SearchHit[];
	};
}
import { buildOwnCut, applyTailBudget, MAX_TAIL_TOKENS, OVERSIZED_TAIL_FACTOR } from "./tuck/cut";
import { calibrateCharsPerToken, estimateSourceMessageChars } from "./tuck/core/token-estimate";
import { buildGlobalIndexById } from "./tuck/core/global-indices";
import { compileShrunkDialogue, compileDialogue } from "./tuck/core/summarize";
import { prepareKeywordQuery } from "./tuck/core/keyword-query";
import { searchEntriesDetailed } from "./tuck/core/search-entries";
export const tuck: Tuck = { buildOwnCut, applyTailBudget, calibrateCharsPerToken, buildGlobalIndexById, compileShrunkDialogue, compileDialogue, prepareKeywordQuery, searchEntriesDetailed };
/** The one historical allowance: at most 25% of remaining estimated room, for both views.
 * The whole dialogue is offered only within it (plus actual preview/headroom guards);
 * otherwise the same dialogue is shrunk to fit it. The 4-character conversion matches pinned Pi's
 * summary estimator, not a provider-token guarantee. Mandatory sources (current input,
 * initiating prompt, file ledger) are already charged in base. */
export function historicalAllowance(window: number, reserve: number, base: number, before: number): number {
    const free = Math.max(0, window - reserve - base - 1);
    return Math.max(0, Math.min(Math.floor(free / 4), before - base - 1)) * 4;
}
/** Uses pi-tuck's own cut, calibrated maximum tail and dialogue compiler; Pi owns persistence and continuation. */
export function tuckDraft(tuck: Tuck, event: SessionBeforeCompactEvent, ctx: ExtensionContext, reserveTokens: number, measure: Measure, policy: RecallPolicy = {}, retainCurrentInput = true, operatorManual = false, newPrompt = false) {
 return tuckObservedDraft(tuck, { branchEntries: event.branchEntries, tokensBefore: event.preparation.tokensBefore, previousSummary: event.preparation.previousSummary, operatorManual, newPrompt }, ctx, reserveTokens, measure, policy, retainCurrentInput);
}
/** Shared compiler observes canonical branch and current token estimate; no native preparation utility. */
/** `newPrompt`: the cut is planned for a run that has not begun (a prompt Pi has not appended yet, an operator's manual cut, Pi's own cut before
 * a run a custom message starts); the session has moved on from an ended run.
 * `reRenderSummary`: the cut is due, so its summary may be re-rendered smaller (see the `no_live_messages` branch below). */
export function tuckObservedDraft(tuck: Tuck, input: { branchEntries: SessionEntry[]; tokensBefore: number; previousSummary?: string; operatorManual?: boolean; newPrompt?: boolean; reRenderSummary?: boolean }, ctx: ExtensionContext,
 reserveTokens: number, measure: Measure, policy: RecallPolicy = {}, retainCurrentInput = true): Draft {
 const { isHistorySource, readable } = createRecall(policy);
	const projected = ctx.sessionManager.buildSessionProjection();
	if (input.branchEntries.some(entry => entry.type === "context_edit" && entry.replacement !== null))
		return { unavailable: "pi-tuck does not support replacement context edits" };
	const omitted = new Set(projected.entries.filter((e) => e.messages.length === 0 &&
		isHistorySource(e.sourceEntry) && e.sourceEntry.type !== "compaction").map((e) => e.sourceEntry.id));
	const branch = input.branchEntries;
	// Compacted-away entries are absent from the projection, but their native omissions still apply.
	for (const entry of branch) if (entry.type === "context_edit" && entry.replacement === null) omitted.add(entry.targetId);
	// Preserve raw order and anchor IDs. Omission placeholders exist only in pi-tuck's input;
	// Pi previews and persists against the original branch, including its edits.
	const entries: SessionEntry[] = branch.filter(isHistorySource).map((e) => omitted.has(e.id)
		? { type: "label", id: e.id, parentId: e.parentId, timestamp: e.timestamp, targetId: e.id, label: "" } : e);
	const calibration = tuck.buildOwnCut(entries, 0);
	const chars = (calibration.ok ? calibration.messages.reduce((n, m) => n + estimateSourceMessageChars(m), 0) : 0)
		+ (input.previousSummary?.length ?? 0);
	const { charsPerToken } = tuck.calibrateCharsPerToken(chars, input.tokensBefore);
    // The planner's reserve includes mandatory input (system, host and incoming prompt), so this is half of the target room *after* that
    // fixed input, not half of the whole room. Current/fresh-source floors below may still require an explicit rejection.
    const inputRoom = Math.floor(Math.max(0, (ctx.model?.contextWindow ?? 0) - reserveTokens - 1) / 2);
    const maxTokens = Math.min(MAX_TAIL_TOKENS, inputRoom);
    // Keep the current user turn native; older conversation competes in the
    // existing exact historical view instead of boosting a minimum native tail.
	let cut = tuck.buildOwnCut(entries, 1);
	if (cut.ok) cut = tuck.applyTailBudget(entries, cut, { charsPerToken, maxTokens,
        oversizedFactor: Math.min(OVERSIZED_TAIL_FACTOR, inputRoom / Math.max(1, maxTokens)) });
    // Nothing since the last cut: its summary alone is the conversation, and only a cut that is due can re-render it. A summary is compiled from
    // the original sources, so the cut takes the whole history again under this cut's allowance, and a summary that leaves the request no room is
    // made smaller. Inside the band a cut is opportunistic, and re-rendering there shrinks the summary and costs history for nothing (replays
    // s04-B task 13, s08-B task 23: a 13,008-token first request became 3,336), so an opportunistic cut refuses as it did before.
    else if (input.reRenderSummary && cut.reason === "no_live_messages" && entries.some(entry => entry.type === "compaction"))
        cut = { ok: true, messages: [], selectedIds: [], firstKeptEntryId: "", compactAll: true, keptUserTurns: 0, keepFallbackToCompactAll: false };
	if (!cut.ok) return { unavailable: `pi-tuck cannot select a cut: ${cut.reason}` };
    const cutBefore = (cut: Extract<Cut, { ok: true }>, boundary: number, prefix: Extract<Cut, { ok: true }>): Extract<Cut, { ok: true }> => ({
        ...cut, messages: prefix.messages, selectedIds: prefix.selectedIds,
        firstKeptEntryId: entries[boundary]?.id ?? "", compactAll: boundary === entries.length, keepFallbackToCompactAll: false,
        keptUserTurns: entries.slice(boundary).filter(entry => entry.type === "message" && entry.message.role === "user").length,
    });
    // The latest call's trailing receipts have not reached a subsequent response.
    // A preferred tail size must not erase this first exposure when the whole
    // fresh round fits. Existing full-draft admission rejects an impossible round.
    const lastResponse = entries.findLastIndex(entry => entry.type === "message" && entry.message.role === "assistant" &&
        !isDiscardedResponse(entry.message));
    const response = entries[lastResponse];
    let freshRound = false;
    if (response?.type === "message" && response.message.role === "assistant") {
        const calls = new Set(response.message.content.flatMap(block => block.type === "toolCall" ? [block.id] : []));
        const hasFreshReceipt = entries.slice(lastResponse + 1).some(entry => entry.type === "message" &&
            entry.message.role === "toolResult" && calls.has(entry.message.toolCallId));
        // Fresh means the receipts are the answer the next request of this run carries. Once the session has moved on (the cut is planned for a
        // run that has not begun, or a prompt has arrived since them) they are ordinary history, whatever ended their run: a reply discarded
        // or one Pi hid when it recovered. Kept native, a receipt that never fits would refuse every later prompt. A retry is inside its run.
        const superseded = input.newPrompt || entries.slice(lastResponse + 1).some(entry => entry.type === "message" && entry.message.role === "user");
        freshRound = hasFreshReceipt && !superseded;
        const keptId = cut.firstKeptEntryId;
        const chosenBoundary = cut.compactAll ? entries.length : entries.findIndex(entry => entry.id === keptId);
        if (freshRound && lastResponse < chosenBoundary) {
            const prefix = tuck.buildOwnCut(entries.slice(0, lastResponse), 0);
            if (!prefix.ok) return { unavailable: "No reducible history before the fresh tool round" };
            cut = cutBefore(cut, lastResponse, prefix);
        }
    }
    // Direct shell output after the last response has not reached the model.
    // Keep every such ordinary source native; intentionally excluded commands
    // were already removed by shared eligibility. Admission rejects no-fit cases.
    const freshBash = entries.findIndex((entry, i) => i > lastResponse && entry.type === "message" && entry.message.role === "bashExecution");
    const shellKeptId = cut.firstKeptEntryId;
    const shellBoundary = cut.compactAll ? entries.length : entries.findIndex(entry => entry.id === shellKeptId);
    if (freshBash >= 0 && freshBash < shellBoundary) {
        const prefix = tuck.buildOwnCut(entries.slice(0, freshBash), 0);
        if (!prefix.ok) return { unavailable: "No reducible history before the fresh shell output" };
        cut = cutBefore(cut, freshBash, prefix);
    }
    // Preserve the actual latest user source, never an inferred task/decision.
    // Explicit omission of it must not promote an earlier user source instead.
    const latestUser = retainCurrentInput ? branch.findLast(entry => entry.type === "message" && entry.message.role === "user") : undefined;
    const userPosition = entries.findIndex(entry => entry.id === latestUser?.id && entry.type === "message");
    const current = entries[userPosition];
    const userContent = current?.type === "message" && current.message.role === "user" ? current.message.content : undefined;
    const textOnly = isTextOnly(userContent);
    // The initiating prompt is the task contract: quoted in every summary that compacts it away. It is the branch's first user
    // source; when a native edit omitted it, nothing is quoted and no later user source is promoted in its place.
    const firstUser = branch.find(entry => entry.type === "message" && entry.message.role === "user");
    const firstUserPosition = entries.findIndex(entry => entry.id === firstUser?.id && entry.type === "message");
    const selectedKeptId = cut.firstKeptEntryId;
    const selectedBoundary = cut.compactAll ? entries.length : entries.findIndex(entry => entry.id === selectedKeptId);
    // An unobserved input or non-text input stays native. Quoting cannot deliver
    // its pixels/unknown blocks, and must not count as first exposure.
    if (userPosition >= 0 && userPosition < selectedBoundary && (!textOnly || userPosition > lastResponse)) {
        const prefix = tuck.buildOwnCut(entries.slice(0, userPosition), 0);
        if (!prefix.ok) return { unavailable: "No reducible history before the current user input" };
        cut = cutBefore(cut, userPosition, prefix);
    }

	if (cut.messages.length !== cut.selectedIds.length || (!cut.compactAll && !entries.some((e) => e.id === cut.firstKeptEntryId)))
		throw new Error("pi-tuck returned an invalid source boundary");
    // Keep the preferred native tail when a complete historical offer fits.
    // Otherwise try the current/fresh floor: whole dialogue can take priority
    // over already-observed native bulk, under the same final admission guards.
    // Each cut's file ledger skips write/edit calls whose result is an error.
    const failedCalls = new Set(entries.flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.isError ? [entry.message.toolCallId] : []));
    // First occurrence, as entries.find would resolve it.
    const entryById = new Map<string, SessionEntry>();
    for (const entry of entries) if (!entryById.has(entry.id)) entryById.set(entry.id, entry);
    const compileAtCut = (cut: Extract<Cut, { ok: true }>): Draft => {
	const indices = tuck.buildGlobalIndexById(ctx.sessionManager.getEntries());
	// Keep native custom provenance; converting custom notices to user text loses the distinction.
	const boundary = cut.compactAll ? entries.length : entries.findIndex(entry => entry.id === cut.firstKeptEntryId);
    if (boundary < 0) throw new Error("Missing original-source cut boundary");
    const originalCut = tuck.buildOwnCut(entries.slice(0, boundary).filter(entry => entry.type !== "compaction"), 0);
    if (!originalCut.ok) return { unavailable: "No eligible original prefix to compile" };
    const protectedUser = userPosition >= 0 && userPosition < boundary && textOnly ? current : undefined;
    const currentIndex = protectedUser ? indices.get(protectedUser.id) : undefined;
    if (protectedUser && currentIndex === undefined) throw new Error("Missing current user source index");
    const messages = originalCut.messages, sourceIndices = originalCut.selectedIds.map(id => indices.get(id));
	const receiptContext: { messages: AgentMessage[]; sourceIndices: (number | undefined)[] } = { messages: [], sourceIndices: [] };
	for (const entry of entries) if (entry.type === "message") {
		receiptContext.messages.push(entry.message); receiptContext.sourceIndices.push(indices.get(entry.id));
	}
    // The newest user turns, newest first, then the initiating prompt, share one budget: in a session that runs task after task, the current task is
    // an older user turn followed by short steps, and the dialogue clips user turns oldest first down to a few words, so quoting only the first prompt
    // kept a finished task whole and lost the one being worked on. A turn that does not fit keeps its head and a locator; the first prompt gets what
    // the newest turns leave, so a one-task session, whose later turns are short, still quotes it as before.
    const initiating = firstUserPosition >= 0 && firstUserPosition < boundary && entries[firstUserPosition]!.id !== protectedUser?.id ? entries[firstUserPosition] : undefined;
    const quote = (entry: SessionEntry, budget: number, label: string): TranscriptRecord[] => {
        const content = entry.type === "message" && entry.message.role === "user" ? entry.message.content : undefined;
        if (!isTextOnly(content)) return [];
        const text = textOf(content!), index = indices.get(entry.id);
        if (index === undefined) throw new Error("Missing quoted user source index");
        const quoted = head(text, budget), sourceTimes = [{ sourceIndex: index, ...resolveSourceTime(entry) }];
        if (!text.trim() || !quoted.length) return [];
        return [{ kind: "excerpt", role: "user", sourceIndex: index, text: quoted, sourceTimes }, ...(quoted.length < text.length ? [{ kind: "omission" as const, role: "user" as const,
            sourceIndex: index, reason: `${label} continues: characters ${quoted.length}-${text.length} omitted; read them with tuck_recall {"index":${index},"offset":${quoted.length}}`, sourceTimes }] : [])];
    };
    // Both ends are anchored, in this order: the heads of the newest user turns (at most a quarter of the budget), the head of the first prompt (the
    // goal of a long session), then extensions of the newest turns, then the rest of the first prompt. Heads come first so steps after a task can't
    // use up the budget the task turn needs; the first prompt's head comes before any extension so steering turns can't use up the goal's.
    const quotesFor = (budget: number, headSize: number, withFirst: boolean): TranscriptRecord[] => {
        const turns: { entry: SessionEntry; text: string; take: number }[] = [];
        // Only answered turns: a prompt that was refused and never got a reply was never taken up, and quoting it would spend the budget for nothing.
        let answered = false;
        for (let at = entries.length - 1; at >= 0; at--) {
            const entry = entries[at]!;
            if (entry.type === "message" && entry.message.role === "assistant") { answered = true; continue; }
            if (entry.type !== "message" || entry.message.role !== "user") continue;
            const replied = answered;
            answered = false;
            if (at >= boundary || !replied || entry.id === protectedUser?.id || entry.id === firstUser?.id || !isTextOnly(entry.message.content)) continue;
            const text = textOf(entry.message.content);
            if (text.trim()) turns.push({ entry, text, take: 0 });
        }
        // headSize 0 quotes the first prompt alone, as before any user turn was quoted: the last step before no quote at all.
        if (headSize === 0) turns.length = 0;
        let left = budget, heads = Math.floor(budget / 4);
        for (const turn of turns) { if (heads <= 0) break; turn.take = Math.min(turn.text.length, headSize, heads); heads -= turn.take; left -= turn.take; }
        const firstText = withFirst && initiating?.type === "message" && initiating.message.role === "user" && isTextOnly(initiating.message.content) ? textOf(initiating.message.content) : "";
        let firstTake = Math.min(firstText.length, headSize ? Math.round(headSize * 20 / 3) : budget, Math.max(0, left));
        left -= firstTake;
        for (const turn of turns) { if (left <= 0) break; const more = Math.min(turn.text.length - turn.take, left); turn.take += more; left -= more; }
        firstTake += Math.min(firstText.length - firstTake, Math.max(0, left));
        const records = turns.filter(turn => turn.take > 0).reverse().flatMap(turn => quote(turn.entry, turn.take, "User turn"));
        if (firstTake > 0 && initiating) records.unshift(...quote(initiating, firstTake, "Initiating prompt"));
        return records;
    };
    const mandatory: TranscriptRecord[] = [];
    if (protectedUser?.type === "message" && protectedUser.message.role === "user")
        mandatory.push({ kind: "excerpt", role: "user", sourceIndex: currentIndex, text: textOf(protectedUser.message.content), sourceTimes: [{ sourceIndex: currentIndex!, ...resolveSourceTime(protectedUser) }] });
    // The file ledger and the action trail of the compacted history are mandatory, so they are charged in base like the quotes above.
    // A locator is given only where tuck_recall {index} resolves it: a unique global index of a readable entry.
    const compacted = entries.slice(0, boundary), resolves = (entry: SessionEntry) => readable(entry) !== undefined;
    const items = ledgerItems(compacted, indices, resolves, failedCalls), actions = actionItems(compacted, indices, resolves, failedCalls);
	const header = ctx.sessionManager.getHeader();
	if (!header) throw new Error("Missing native session header");
	const details = { compactor: "pi-tuck", version: 2, adapter: "standalone", keptUserTurns: cut.keptUserTurns,
		...(cut.budgetCut ? { budgetCut: cut.budgetCut } : {}) };
    const preview = (summary: string) => {
        const manager = SessionManager.inMemory(ctx.cwd, undefined, [header, ...branch]);
        manager.appendCompaction(summary, cut.firstKeptEntryId, input.tokensBefore, details, true);
        return manager.buildSessionProjection().messages;
    };
    const before = measure(projected.messages);
    const model = ctx.model;
    const floorAt = (keep: number, choice: { budget: number; head: number; first: boolean }) => {
        const ledger = [...actionRecords(actions, keep), ...ledgerRecords(items, keep)];
        const messages = preview(serializeTranscript([...mandatory, ...quotesFor(choice.budget, choice.head, choice.first), ...ledger]) + DIALOGUE_SUFFIX);
        return { ledger, messages, base: measure(messages), choice };
    };
    const fits = (base: number) => Boolean(model) && base + reserveTokens < model!.contextWindow && base < before;
    // When room is tight the newest turns win over the first prompt, which in a long-running session is often a finished task. The floor gives way
    // in this order: the trail and ledger to their headings, the extensions (the budget halved), then the heads, the first prompt's among them
    // (300 characters, 2,000 for the first prompt; then 100 and 667), then everything but the first prompt (as before user turns were quoted),
    // and only then every quote. Only a floor with no quote but the current input can refuse the cut.
    // The budget grows with the room: 15% of it, at least the 12,000 characters a first prompt always had. A long-running session's task can be tens
    // of thousands of characters, and the room is what can afford it.
    const taskBudget = Math.max(MAX_TASK_CONTRACT_CHARACTERS, Math.floor(Math.max(0, (model?.contextWindow ?? 0) - reserveTokens) * charsPerToken * 0.15));
    const budgets = [taskBudget, taskBudget / 2, taskBudget / 4, taskBudget / 8, 1500].map(Math.floor).filter((b, at, all) => b >= 1500 && all.indexOf(b) === at);
    const choices = [{ head: 300, budgets }, { head: 100, budgets: [1500, 600] }]
        .flatMap(({ head, budgets }) => budgets.map(budget => ({ budget, head, first: true }))).concat([{ budget: MAX_TASK_CONTRACT_CHARACTERS, head: 0, first: true }, { budget: 0, head: 0, first: false }]);
    let floor = floorAt(Math.max(items.length, actions.length), choices[0]!);
    for (const choice of choices) {
        floor = floorAt(Math.max(items.length, actions.length), choice);
        if (fits(floor.base)) break;
        if (items.length || actions.length) { floor = floorAt(0, choice); if (fits(floor.base)) break; }
    }
    const { ledger, base } = floor;
    const kept = [...mandatory, ...quotesFor(floor.choice.budget, floor.choice.head, floor.choice.first)];
    if (!model || !fits(base))
        return { unavailable: "pi-tuck's mandatory context cannot fit or reduce the request budget", capacityRejected: Boolean(model && base + reserveTokens >= model.contextWindow), floorMessages: floor.messages };
    const maxBriefChars = historicalAllowance(model.contextWindow, reserveTokens, base, before);
    const compileInput = { messages, sourceIndices, sourceEntryIds: originalCut.selectedIds, sourceTimes: originalCut.selectedIds.map(id => resolveSourceTime(entryById.get(id)!)), receiptContext,
        ranking: { maxBriefChars, mandatorySourceIndices: new Set(kept.flatMap(r => r.sourceIndex === undefined ? [] : [r.sourceIndex])) },
    };
    // Both views use the same parser, mandatory insertion, native preview and guard, and end with the same closing section.
    const assemble = (compiled: string) => {
        if (typeof compiled !== "string") throw new Error("pi-tuck returned an invalid summary");
        const split = compiled ? splitSummary(compiled) : { body: "", version: 2 as const };
        if (!split) throw new Error("pi-tuck returned an invalid summary");
        const records = parseRecords(split.body, split.version);
        for (const record of kept) {
            const insertion = records.findIndex(row => row.sourceIndex !== undefined && row.sourceIndex > record.sourceIndex!);
            records.splice(insertion < 0 ? records.length : insertion, 0, record);
        }
        orderByOriginalSource(records, sourceIndices, originalCut.selectedIds);
        // The ledger always has its heading, so no summary is empty.
        records.push(...ledger);
        const summary = serializeTranscript(records) + DIALOGUE_SUFFIX;
        const projection = preview(summary);
        assertNativeToolRounds(projection);
        return { summary, after: measure(projection) };
    };
    const free = Math.max(0, model.contextWindow - reserveTokens - base - 1);
    const headroom = Math.ceil(free / 4);
    // The whole pre-cut dialogue, when it fits the allowance; otherwise the same dialogue shrunk to the same allowance.
    // With no allowance only an operator's manual cut can use it.
    const dialogue = maxBriefChars > 0 || input.operatorManual ? tuck.compileDialogue(compileInput) : "";
    const dialogueFits = dialogue.length <= maxBriefChars;
    const candidate = dialogue && (dialogueFits || input.operatorManual) ? assemble(dialogue) : undefined;
    const offer = candidate && dialogueFits && candidate.after < before && candidate.after + reserveTokens + headroom < model.contextWindow ? candidate : undefined;
    // Manual no-work preserves native originals; final request admission still owns full overhead.
    if (!offer && input.operatorManual && candidate && candidate.after >= before &&
        before + reserveTokens < model.contextWindow)
        return { unavailable: "Manual compaction preserved original dialogue: the complete-dialogue view does not reduce context" };
    const { summary, after } = offer ?? assemble(tuck.compileShrunkDialogue(compileInput));
    // Draft reduction concerns conversation. Final request admission owns the effective system/tools.
    if (after + reserveTokens >= model.contextWindow || after >= before)
        return { unavailable: "pi-tuck's draft does not reduce context within the request budget", capacityRejected: after + reserveTokens >= model.contextWindow, floorMessages: floor.messages };
    const mode: DraftMode = offer ? "dialogue" : "shrunk";
	return { compaction: { summary, firstKeptEntryId: cut.firstKeptEntryId, tokensBefore: input.tokensBefore, details: { ...details, tokensAfter: after, view: offer ? "complete-dialogue" : "shrunk-dialogue", mode } }, after, mode };
    };
    const preferred = compileAtCut(cut);
    if (preferred.mode === "dialogue") return preferred;
    if (!preferred.compaction && !preferred.capacityRejected) return preferred;
    const preferredBoundary = cut.compactAll ? entries.length : entries.findIndex(entry => entry.id === cut.firstKeptEntryId);
    let floorBoundary = freshRound ? lastResponse : entries.length;
    if (freshBash >= 0) floorBoundary = Math.min(floorBoundary, freshBash);
    if (userPosition >= 0 && (!textOnly || userPosition > lastResponse)) floorBoundary = Math.min(floorBoundary, userPosition);
    if (floorBoundary <= preferredBoundary) return preferred;
    const prefix = tuck.buildOwnCut(entries.slice(0, floorBoundary), 0);
    if (!prefix.ok) return preferred;
    const retried = compileAtCut({ ...cutBefore(cut, floorBoundary, prefix), budgetCut: undefined });
    return preferred.compaction && retried.mode !== "dialogue" ? preferred : retried;

}

/** Numeric references use the original session index, then intersect with readable current-branch entries. */
export function tuckRecall(tuck: Tuck, entries: readonly SessionEntry[], branch: readonly SessionEntry[],
	input: RecallOptions & { index?: number; continuation?: RecallContinuation }, policy: RecallPolicy = {}) {
 const { readable, discoveryEntry, discoveryExcerpt, discoveryWholeRange, recallAttempts, producerReads, recallHistory } = createRecall(policy);
	const { continuation } = input;
	if (continuation && [input.query, input.entryId, input.index, input.offset, input.limit].some((v) => v !== undefined))
		throw new Error("Use continuation alone to continue the same ranked search");
	const indices = tuck.buildGlobalIndexById(entries);
	if (input.index !== undefined) {
		if (input.entryId !== undefined)
			throw new Error("Use index or entryId to select one source, not both");
		const entry = branch.find((e) => indices.get(e.id) === input.index && readable(e));
		if (!entry) return { status: "not_found", entries: [] };
		return recallHistory(branch, { ...input, entryId: entry.id });
	}
	if (!continuation && (!input.query || input.entryId)) return recallHistory(branch, input);
	if (input.offset !== undefined || input.limit !== undefined) throw new Error("Search returns a continuation; read a hit's entryId with offset/limit");
	const links = producerReads(branch);
	if (continuation) {
		const anchors = branch.flatMap((e, i) => e.id === continuation.throughEntryId ? [i] : []);
		if (anchors.length !== 1 || !discoveryEntry(branch[anchors[0]!]!, undefined, links))
			throw new Error("Missing or ambiguous search anchor in the current readable branch");
		branch = branch.slice(0, anchors[0]! + 1);
	}
	// Upstream's regex mode cannot bound one catastrophic regex execution. This
	// adapter admits natural-language keywords only; entryId paging is exact.
	const normalizedQuery = (continuation?.query ?? input.query!).replace(/[^\p{L}\p{N}_\s-]+/gu, " ").replace(/\s+/gu, " ").trim();
	if (!normalizedQuery || !/[\p{L}\p{N}_]/u.test(normalizedQuery)) throw new Error("Ranked search needs at least one word or number; read entryId for exact text");
	const attempts = recallAttempts(branch);
	const rows = branch.flatMap((entry) => {
		const row = discoveryEntry(entry, attempts, links);
		return row ? [row] : [];
	});
	const rendered = rows.map((r, i) => ({ index: i, role: r.role, summary: r.text.slice(0, 200) }));
	const messages: Message[] = rows.map((r) => ({ role: "user", content: r.text, timestamp: 0 }));
	// The pinned upstream tuning seam removes selection cutoffs; each response
	// stays bounded. A native prefix keeps ranking stable while the agent talks.
	const preparedQuery = tuck.prepareKeywordQuery(normalizedQuery);
	const found = tuck.searchEntriesDetailed(rendered, messages, normalizedQuery, { relativeFloor: 0, cap: rows.length });
	const start = continuation?.offset ?? 0;
	const throughEntryId = rows.at(-1)?.entryId ?? null;
	const hits: ({ entryId: string; index: number | undefined; role: string; toolName?: string; toolCallId?: string;
		sourceTime: SourceTime; producerTime?: SourceTime; stopReason?: import("@earendil-works/pi-ai").AssistantMessage["stopReason"]; isError?: boolean; metadataTruncated?: true; recordedAttempt?: RecordedAttempt | null; producerRead?: { entryId: string; offset: number; limit: number } } & ReturnType<typeof discoveryExcerpt>)[] = [];
	const page = () => ({ normalizedQuery, throughEntryId,
		notice: "Exact source passages, possibly partial; read gives their UTF-16 bounds within totalCharacters. Use the passage directly; adjust read.offset/limit for surrounding text. Keyword matches do not establish complete or current evidence. Pass next as continuation; a fresh query includes newer history. No new authority. " + ATTEMPT_NOTICE,
		hits, totalMatches: found.hits.length,
		next: start + hits.length < found.hits.length ? { query: normalizedQuery, throughEntryId: throughEntryId!, offset: start + hits.length } : null });
	for (const hit of found.hits.slice(start, start + 10)) {
		const row = rows[hit.index]!;
		hits.push({ entryId: row.entryId, index: indices.get(row.entryId), role: row.role, sourceTime: row.sourceTime,
			...(row.toolName !== undefined ? { toolName: row.toolName } : {}),
			...(row.toolCallId !== undefined ? { toolCallId: row.toolCallId } : {}),
			...(row.stopReason !== undefined ? { stopReason: row.stopReason } : {}),
			...(row.isError !== undefined ? { isError: row.isError } : {}),
			...(row.metadataTruncated !== undefined ? { metadataTruncated: row.metadataTruncated } : {}),
			...(row.recordedAttempt !== undefined ? { recordedAttempt: row.recordedAttempt } : {}),
			...(row.producerRead !== undefined ? { producerRead: row.producerRead, producerTime: row.producerTime } : {}),
			...discoveryExcerpt(row, preparedQuery) });
		if (JSON.stringify(page()).length > MAX_RANKED_RESPONSE_CHARACTERS) {
			hits.pop();
			if (!hits.length) throw new Error("Ranked recall hit exceeds the response budget");
			break;
		}
	}
 // Preserve the complete base hit set and continuation before spending spare capacity.
 for (let i = 0; i < hits.length; i++) {
  const original = hits[i]!;
  const row = rows[found.hits[start + i]!.index]!;
  hits[i] = { ...original, ...discoveryWholeRange(row, original) };
  if (JSON.stringify(page()).length > MAX_RANKED_RESPONSE_CHARACTERS) hits[i] = original;
 }
	return page();
}
