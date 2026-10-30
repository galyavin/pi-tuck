import { resolveSourceTime, type SourceTime } from "./tuck/core/source-time";
import { orderByOriginalSource } from "./tuck/core/source-order";
import { assertNativeToolRounds, isDiscardedResponse } from "./protocol.js";
import { parseRecords, serializeTranscript, splitSummary, type TranscriptRecord } from "./tuck/core/transcript";
import { DIALOGUE_SUFFIX, RANKED_SUFFIX } from "./tuck/core/format";
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
/** The summary view that produced a draft: the whole pre-cut dialogue, or the ranked fallback. Both carry the file ledger. */
export type DraftMode = "dialogue" | "ranked";
type Draft = { compaction: Pick<Extract<SessionEntry, { type: "compaction" }>, "summary" | "firstKeptEntryId" | "tokensBefore" | "details">; after: number; mode: DraftMode; unavailable?: never; capacityRejected?: never }
    | { compaction?: never; mode?: never; unavailable: string; capacityRejected?: boolean };
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
	compileRanked(input: { messages: AgentMessage[]; sourceIndices: (number | undefined)[]; sourceEntryIds?: readonly string[]; sourceTimes?: readonly SourceTime[];
		receiptContext?: { messages: AgentMessage[]; sourceIndices: (number | undefined)[] };
		ranking: { maxBriefChars: number; maxBriefCharsCeiling?: number; briefCharsPerBlock?: number; maxBriefUnits?: number;
            mandatorySourceIndices?: ReadonlySet<number> } }): string;
	/** The whole pre-cut dialogue view; "" offers none, and the ranked view is used. */
	compileDialogue(input: Parameters<Tuck["compileRanked"]>[0]): string;
	prepareKeywordQuery(query: string): PreparedKeywordQuery;
	searchEntriesDetailed(entries: SearchHit[], messages: Message[], query: string,
		tuning: { relativeFloor: number; cap: number }): {
		hits: SearchHit[];
	};
}
import { buildOwnCut, applyTailBudget, MAX_TAIL_TOKENS, OVERSIZED_TAIL_FACTOR } from "./tuck/cut";
import { calibrateCharsPerToken, estimateSourceMessageChars } from "./tuck/core/token-estimate";
import { buildGlobalIndexById } from "./tuck/core/global-indices";
import { compileRanked, compileDialogue } from "./tuck/core/summarize";
import { prepareKeywordQuery } from "./tuck/core/keyword-query";
import { searchEntriesDetailed } from "./tuck/core/search-entries";
export const tuck: Tuck = { buildOwnCut, applyTailBudget, calibrateCharsPerToken, buildGlobalIndexById, compileRanked, compileDialogue, prepareKeywordQuery, searchEntriesDetailed };
/** The one historical allowance: at most 25% of remaining estimated room, for both views.
 * The whole dialogue is offered only within it (plus actual preview/headroom guards);
 * otherwise the ranked view fills it. The 4-character conversion matches pinned Pi's
 * summary estimator, not a provider-token guarantee. Mandatory sources (current input,
 * initiating prompt, file ledger) are already charged in base. */
export function historicalAllowance(window: number, reserve: number, base: number, before: number): number {
    const free = Math.max(0, window - reserve - base - 1);
    return Math.max(0, Math.min(Math.floor(free / 4), before - base - 1)) * 4;
}
/** Uses pi-tuck's own cut, calibrated maximum tail and ranked compiler; Pi owns persistence and continuation. */
export function tuckDraft(tuck: Tuck, event: SessionBeforeCompactEvent, ctx: ExtensionContext, reserveTokens: number, measure: Measure, policy: RecallPolicy = {}, retainCurrentInput = true, operatorManual = false) {
 return tuckObservedDraft(tuck, { branchEntries: event.branchEntries, tokensBefore: event.preparation.tokensBefore, previousSummary: event.preparation.previousSummary, operatorManual }, ctx, reserveTokens, measure, policy, retainCurrentInput);
}
/** Shared compiler observes canonical branch and current token estimate; no native preparation utility. */
export function tuckObservedDraft(tuck: Tuck, input: { branchEntries: SessionEntry[]; tokensBefore: number; previousSummary?: string; operatorManual?: boolean }, ctx: ExtensionContext,
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
    // A preferred tail cannot consume more than the current input allowance.
    // Current/fresh-source floors below may still require an explicit rejection.
    const inputRoom = Math.max(0, (ctx.model?.contextWindow ?? 0) - reserveTokens - 1);
    const maxTokens = Math.min(MAX_TAIL_TOKENS, inputRoom);
    // Keep the current user turn native; older conversation competes in the
    // existing exact historical view instead of boosting a minimum native tail.
	let cut = tuck.buildOwnCut(entries, 1);
	if (cut.ok) cut = tuck.applyTailBudget(entries, cut, { charsPerToken, maxTokens,
        oversizedFactor: Math.min(OVERSIZED_TAIL_FACTOR, inputRoom / Math.max(1, maxTokens)) });
	if (!cut.ok) return { unavailable: `pi-tuck cannot select a cut: ${cut.reason}` };
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
        freshRound = hasFreshReceipt;
        const keptId = cut.firstKeptEntryId;
        const chosenBoundary = cut.compactAll ? entries.length : entries.findIndex(entry => entry.id === keptId);
        if (hasFreshReceipt && lastResponse < chosenBoundary) {
            const prefix = tuck.buildOwnCut(entries.slice(0, lastResponse), 0);
            if (!prefix.ok) return { unavailable: "No reducible history before the fresh tool round" };
            cut = { ...cut, messages: prefix.messages, selectedIds: prefix.selectedIds,
                firstKeptEntryId: response.id, compactAll: false, keepFallbackToCompactAll: false,
                keptUserTurns: entries.slice(lastResponse).filter(entry => entry.type === "message" && entry.message.role === "user").length };
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
        cut = { ...cut, messages: prefix.messages, selectedIds: prefix.selectedIds,
            firstKeptEntryId: entries[freshBash]!.id, compactAll: false, keepFallbackToCompactAll: false,
            keptUserTurns: entries.slice(freshBash).filter(entry => entry.type === "message" && entry.message.role === "user").length };
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
        cut = { ...cut, messages: prefix.messages, selectedIds: prefix.selectedIds,
            firstKeptEntryId: current!.id, compactAll: false, keepFallbackToCompactAll: false,
            keptUserTurns: entries.slice(userPosition).filter(entry => entry.type === "message" && entry.message.role === "user").length };
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
    const mandatory: TranscriptRecord[] = [];
    // The initiating prompt is quoted first, like the current input below: text only, since quoting cannot deliver other blocks.
    const initiating = firstUserPosition >= 0 && firstUserPosition < boundary && entries[firstUserPosition]!.id !== protectedUser?.id ? entries[firstUserPosition] : undefined;
    const initiatingContent = initiating?.type === "message" && initiating.message.role === "user" ? initiating.message.content : undefined;
    if (initiating && isTextOnly(initiatingContent)) {
        const text = textOf(initiatingContent!), index = indices.get(initiating.id);
        if (index === undefined) throw new Error("Missing initiating user source index");
        const quoted = head(text, MAX_TASK_CONTRACT_CHARACTERS), sourceTimes = [{ sourceIndex: index, ...resolveSourceTime(initiating) }];
        if (text.trim()) {
            mandatory.push({ kind: "excerpt", role: "user", sourceIndex: index, sourceTimes, text: quoted });
            if (quoted.length < text.length) mandatory.push({ kind: "omission", role: "user", sourceIndex: index, sourceTimes,
                reason: `Initiating prompt continues: characters ${quoted.length}-${text.length} omitted; read them with tuck_recall {"index":${index},"offset":${quoted.length}}` });
        }
    }
    if (protectedUser?.type === "message" && protectedUser.message.role === "user")
        mandatory.push({ kind: "excerpt", role: "user", sourceIndex: currentIndex, sourceTimes: [{ sourceIndex: currentIndex!, ...resolveSourceTime(protectedUser) }], text: textOf(protectedUser.message.content) });
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
    const floorAt = (keep: number) => {
        const ledger = [...actionRecords(actions, keep), ...ledgerRecords(items, keep)];
        // Charged with the longer (ranked) closing, since the view is chosen later against this base.
        return { ledger, base: measure(preview(serializeTranscript([...mandatory, ...ledger]) + RANKED_SUFFIX)) };
    };
    const fits = (base: number) => Boolean(model) && base + reserveTokens < model!.contextWindow && base < before;
    // When the whole floor cannot fit, the trail and the ledger keep only their headings and counts; only that can refuse the cut.
    let floor = floorAt(Math.max(items.length, actions.length));
    if (!fits(floor.base) && (items.length || actions.length)) floor = floorAt(0);
    const { ledger, base } = floor;
    if (!model || !fits(base))
        return { unavailable: "pi-tuck's mandatory context cannot fit or reduce the request budget", capacityRejected: Boolean(model && base + reserveTokens >= model.contextWindow) };
    const maxBriefChars = historicalAllowance(model.contextWindow, reserveTokens, base, before);
    const compileInput = { messages, sourceIndices, sourceEntryIds: originalCut.selectedIds, sourceTimes: originalCut.selectedIds.map(id => resolveSourceTime(entryById.get(id)!)), receiptContext,
        ranking: { maxBriefChars, mandatorySourceIndices: new Set(mandatory.flatMap(r => r.sourceIndex === undefined ? [] : [r.sourceIndex])) },
    };
    // All offers use the same parser, mandatory insertion, native preview and guard.
    // Each view ends with its own closing section, true for what that view holds.
    const assemble = (compiled: string, closing: string) => {
        if (typeof compiled !== "string") throw new Error("pi-tuck returned an invalid summary");
        const split = compiled ? splitSummary(compiled) : { body: "" };
        if (!split) throw new Error("pi-tuck returned an invalid summary");
        const records = parseRecords(split.body);
        for (const record of mandatory) {
            const insertion = records.findIndex(row => row.sourceIndex !== undefined && row.sourceIndex > record.sourceIndex!);
            records.splice(insertion < 0 ? records.length : insertion, 0, record);
        }
        orderByOriginalSource(records, sourceIndices, originalCut.selectedIds);
        // The ledger always has its heading, so no summary is empty.
        records.push(...ledger);
        const summary = serializeTranscript(records) + closing;
        const projection = preview(summary);
        assertNativeToolRounds(projection);
        return { summary, after: measure(projection) };
    };
    const free = Math.max(0, model.contextWindow - reserveTokens - base - 1);
    const headroom = Math.ceil(free / 4);
    // The whole pre-cut dialogue, when it fits the allowance; otherwise the ranked view fills the same allowance.
    // With no allowance only an operator's manual cut can use it.
    const dialogue = maxBriefChars > 0 || input.operatorManual ? tuck.compileDialogue(compileInput) : "";
    const dialogueFits = dialogue.length <= maxBriefChars;
    const candidate = dialogue && (dialogueFits || input.operatorManual) ? assemble(dialogue, DIALOGUE_SUFFIX) : undefined;
    const offer = candidate && dialogueFits && candidate.after < before && candidate.after + reserveTokens + headroom < model.contextWindow ? candidate : undefined;
    // Manual no-work preserves native originals; final request admission still owns full overhead.
    if (!offer && input.operatorManual && candidate && candidate.after >= before &&
        before + reserveTokens < model.contextWindow)
        return { unavailable: "Manual compaction preserved original dialogue: the complete-dialogue view does not reduce context" };
    const { summary, after } = offer ?? assemble(tuck.compileRanked(compileInput), RANKED_SUFFIX);
    // Draft reduction concerns conversation. Final request admission owns the effective system/tools.
    if (after + reserveTokens >= model.contextWindow || after >= before)
        return { unavailable: "pi-tuck's draft does not reduce context within the request budget", capacityRejected: after + reserveTokens >= model.contextWindow };
    const mode: DraftMode = offer ? "dialogue" : "ranked";
	return { compaction: { summary, firstKeptEntryId: cut.firstKeptEntryId, tokensBefore: input.tokensBefore, details: { ...details, tokensAfter: after, view: offer ? "complete-dialogue" : "ranked", mode } }, after, mode };
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
    const retried = compileAtCut({ ...cut, budgetCut: undefined, messages: prefix.messages, selectedIds: prefix.selectedIds,
        firstKeptEntryId: entries[floorBoundary]?.id ?? "", compactAll: floorBoundary === entries.length,
        keepFallbackToCompactAll: false,
        keptUserTurns: entries.slice(floorBoundary).filter(entry => entry.type === "message" && entry.message.role === "user").length });
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
