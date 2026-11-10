import { resolveSourceTime, type SourceTime } from "./tuck/core/source-time";
import { orderByOriginalSource } from "./tuck/core/source-order";
import { assertNativeToolRounds, isDiscardedResponse } from "./protocol.js";
import { parseRecords, serializeTranscript, serializeRecord, splitSummary, TRANSCRIPT_HEADER, type TranscriptRecord } from "./tuck/core/transcript";
import { DIALOGUE_SUFFIX } from "./tuck/core/format";
import { carriedTailTokens, carriedTarget, conversationTokens } from "./budget";
import { omissionRecord, userPrefixRecords } from "./tuck/core/brief";
import { isTextOnly, textOf } from "./tuck/core/content";
import { MAX_ACTION_LINES, MAX_LEDGER_LINES, actionItems, actionRecords, ledgerItems, ledgerRecords } from "./ledger.js";
import type { Message } from "@earendil-works/pi-ai";
import { convertToLlm, SessionManager, type ExtensionContext,
	type SessionBeforeCompactEvent, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { ATTEMPT_NOTICE, createRecall, type RecallPolicy,
	type PreparedKeywordQuery, type RecordedAttempt, type RecallOptions } from "./recall.js";

type AgentMessage = Parameters<typeof convertToLlm>[0][number];
type Cut = import("./tuck/cut").OwnCutResult;
/** Counts a projection of the conversation exactly as the triggers, the post-cut checks and the guard do (budget.ts). */
export type Measure = ((messages: AgentMessage[]) => number) & {
    /** The same per-message estimate, including any temporary native result clip. */
    messageTokens?: (message: AgentMessage) => number;
};
/** Diagnostic description of the single ranked compiler result. Never a decision input. */
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
	/** Fill the lower ranks once within the remaining serialized amount. */
	compileDialogue(input: { messages: AgentMessage[]; sourceIndices: (number | undefined)[]; sourceEntryIds?: readonly string[]; sourceTimes?: readonly SourceTime[];
		ranking: { maxBriefChars: number; mandatorySourceIndices?: ReadonlySet<number> } }): ReturnType<typeof compileDialogue>;
	prepareKeywordQuery(query: string): PreparedKeywordQuery;
	searchEntriesDetailed(entries: SearchHit[], messages: Message[], query: string,
		tuning: { relativeFloor: number; cap: number }): {
		hits: SearchHit[];
	};
}
import { buildOwnCut, applyTailBudget, MAX_TAIL_TOKENS, OVERSIZED_TAIL_FACTOR } from "./tuck/cut";
import { calibrateCharsPerToken, estimateSourceMessageChars } from "./tuck/core/token-estimate";
import { buildGlobalIndexById } from "./tuck/core/global-indices";
import { compileDialogue } from "./tuck/core/summarize";
import { prepareKeywordQuery } from "./tuck/core/keyword-query";
import { searchEntriesDetailed } from "./tuck/core/search-entries";
export const tuck: Tuck = { buildOwnCut, applyTailBudget, calibrateCharsPerToken, buildGlobalIndexById, compileDialogue, prepareKeywordQuery, searchEntriesDetailed };
/** Uses pi-tuck's own cut, calibrated maximum tail and dialogue compiler; Pi owns persistence and continuation. */
export function tuckDraft(tuck: Tuck, event: SessionBeforeCompactEvent, ctx: ExtensionContext, reserveTokens: number, measure: Measure, policy: RecallPolicy = {}, retainCurrentInput = true, operatorManual = false, newPrompt = false, protectedPromptEntryId?: string) {
 return tuckObservedDraft(tuck, { branchEntries: event.branchEntries, tokensBefore: event.preparation.tokensBefore, previousSummary: event.preparation.previousSummary, operatorManual, newPrompt, protectedPromptEntryId }, ctx, reserveTokens, measure, policy, retainCurrentInput);
}
/** Shared compiler observes canonical branch and current token estimate; no native preparation utility. */
/** `newPrompt`: the cut is planned for a run that has not begun (a prompt Pi has not appended yet, an operator's manual cut, Pi's own cut before
 * a run a custom message starts); the session has moved on from an ended run.
 * `reRenderSummary`: the cut is due, so its summary may be re-rendered smaller (see the `no_live_messages` branch below). */
export function tuckObservedDraft(tuck: Tuck, input: { branchEntries: SessionEntry[]; tokensBefore: number; previousSummary?: string; operatorManual?: boolean; newPrompt?: boolean; reRenderSummary?: boolean; protectedPromptEntryId?: string; deepest?: boolean }, ctx: ExtensionContext,
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
    // The existing keep-recent rule offers a native suffix. The budget owner
    // bounds its rank and base price below, in the planner's estimate.
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
    // Steering can become the latest user source while the run still owns its original prompt.
    const startingPosition = entries.findIndex(entry => entry.id === input.protectedPromptEntryId &&
        (entry.type === "custom_message" || entry.type === "message" && entry.message.role === "user"));
    const starting = entries[startingPosition];
    // Anchor the actual first source only; a native omission never promotes a later prompt.
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
    const budgetCut = cut.budgetCut;
    let preferredBoundary = cut.compactAll ? entries.length : entries.findIndex(entry => entry.id === cut.firstKeptEntryId);
    let floorBoundary = freshRound ? lastResponse : entries.length;
    if (freshBash >= 0) floorBoundary = Math.min(floorBoundary, freshBash);
    if (userPosition >= 0 && (!textOnly || userPosition > lastResponse)) floorBoundary = Math.min(floorBoundary, userPosition);
    // One fill owns the summary and the contiguous native suffix. Protocol/current-input
    // floors are representation constraints; every other source competes by rank.
    return rankedFill();

    function rankedFill(): Draft {
        const model = ctx.model;
        if (!model) return { unavailable: "pi-tuck needs a model to measure the cut" };
        const indices = tuck.buildGlobalIndexById(ctx.sessionManager.getEntries());
        const header = ctx.sessionManager.getHeader();
        if (!header) throw new Error("Missing native session header");
        const before = measure(projected.messages), room = Math.max(0, model.contextWindow - reserveTokens - 1);
        const minimumOpeningLength = 80, openingLength = Math.max(80, Math.floor(Math.sqrt(room * 4)));
        const positions = new Map(entries.map((entry, at) => [entry.id, at]));
        const originals = tuck.buildOwnCut(entries.filter(entry => entry.type !== "compaction"), 0);
        if (!originals.ok) return { unavailable: "No eligible original prefix to compile" };
        const byId = new Map(entries.map(entry => [entry.id, entry]));
        const sourceIndices = originals.selectedIds.map(id => indices.get(id));
        const rows = originals.selectedIds.map((id, at) => ({ id, position: positions.get(id)!, index: sourceIndices[at], message: originals.messages[at] as AgentMessage }));
        const users = rows.filter(row => row.message.role === "user");
        const userTexts = new Map(users.map(row => [row.index, textOf((row.message as Extract<AgentMessage, { role: "user" }>).content)]));
        let replied = false;
        const answered: SessionEntry[] = [];
        for (let at = entries.length - 1; at >= 0; at--) {
            const entry = entries[at]!;
            if (entry.type !== "message") continue;
            if (entry.message.role === "assistant" && !isDiscardedResponse(entry.message) && entry.message.content.length) { replied = true; continue; }
            if (entry.message.role !== "user") continue;
            if (replied && textOf(entry.message.content).length) answered.push(entry);
            replied = false;
        }
        const anchors = [...new Map([...answered.slice(0, 8), ...(firstUserPosition >= 0 ? [entries[firstUserPosition]!] : [])].map(entry => [entry.id, entry])).values()];
        const failedCalls = new Set(entries.flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.isError ? [entry.message.toolCallId] : []));
        const detailsAt = (boundary: number) => ({ compactor: "pi-tuck", version: 2, adapter: "standalone",
            keptUserTurns: users.reduce((n, row) => n + Number(row.position >= boundary), 0),
            ...(boundary === preferredBoundary && budgetCut ? { budgetCut } : {}) });
        const preview = (summary: string, boundary: number) => {
            const manager = SessionManager.inMemory(ctx.cwd, undefined, [header, ...branch]);
            manager.appendCompaction(summary, entries[boundary]?.id ?? "", input.tokensBefore, detailsAt(boundary), true);
            return manager.buildSessionProjection().messages;
        };
        // Price the native suffix once. The measure's additive offset and Pi's
        // summary envelope are calibrated once, rather than replaying a session
        // for each opening, ledger line or tail boundary considered by the fill.
        const rawPositions = new Map(branch.map((entry, at) => [entry.id, at]));
        const native = new Float64Array(branch.length + 1);
        for (const entry of projected.entries) {
            if (entry.sourceEntry.type === "compaction") continue;
            const at = rawPositions.get(entry.sourceEntry.id);
            if (at !== undefined) for (const message of entry.messages)
                native[at] += measure.messageTokens ? measure.messageTokens(message) : conversationTokens([message]);
        }
        for (let at = branch.length - 1; at >= 0; at--) native[at] += native[at + 1]!;
        const nativeAt = (boundary: number) => boundary === entries.length ? 0 : native[rawPositions.get(entries[boundary]!.id)!]!;
        const tailTokens = carriedTailTokens(nativeAt(preferredBoundary));
        // Move only the older end, to the newest whole protocol-safe entries
        // within the shared tail size. Required current/fresh native sources
        // stay whole even when their floor exceeds that preferred amount.
        while (preferredBoundary < floorBoundary && nativeAt(preferredBoundary) > tailTokens) {
            preferredBoundary++;
            while (preferredBoundary < floorBoundary) {
                const entry = entries[preferredBoundary]!;
                if ((entry.type === "message" && entry.message.role !== "toolResult") || entry.type === "custom_message" || entry.type === "branch_summary") break;
                preferredBoundary++;
            }
        }
        const envelope = convertToLlm([{ role: "compactionSummary", summary: "", tokensBefore: 0, timestamp: 0 }]);
        const wrapperCharacters = envelope.reduce((n, message) => n + textOf(message.content).length, 0);
        const summaryTokens = (characters: number) => Math.ceil((characters + wrapperCharacters) / 4);
        const lineCost = (records: readonly TranscriptRecord[]) => records.reduce((n, record) => n + serializeRecord(record).length + 1, 0);
        const frameLength = (cost: number, count: number) => TRANSCRIPT_HEADER.length + DIALOGUE_SUFFIX.length + cost + (count ? 0 : 1);
        const render = (records: TranscriptRecord[]) => (serializeTranscript(records) || TRANSCRIPT_HEADER + "\n") + DIALOGUE_SUFFIX;
        type Unit = { position: number; index: number; count: number };
        const units: Record<"user" | "assistant" | "toolResult", Unit[]> = { user: [], assistant: [], toolResult: [] };
        for (const row of rows) {
            if (row.index === undefined) continue;
            const message = row.message;
            if (message.role === "user" && textOf(message.content).length) units.user.push({ position: row.position, index: row.index, count: 1 });
            else if (message.role === "toolResult") units.toolResult.push({ position: row.position, index: row.index, count: 1 });
            else if (message.role === "assistant" && !isDiscardedResponse(message)) {
                const count = message.content.filter(part => part.type === "text" && part.text.trim()).length;
                if (count) units.assistant.push({ position: row.position, index: row.index, count });
            }
        }
        const prefixes = Object.fromEntries(Object.entries(units).map(([role, list]) => {
            const end = new Int32Array(entries.length + 1), count = new Int32Array(list.length + 1);
            let seen = 0;
            for (let at = 0; at <= entries.length; at++) {
                while (seen < list.length && list[seen]!.position < at) seen++;
                end[at] = seen;
            }
            list.forEach((unit, at) => count[at + 1] = count[at]! + unit.count);
            return [role, { end, count }];
        })) as Record<keyof typeof units, { end: Int32Array; count: Int32Array }>;
        const quoteCache = new Map<string, { records: TranscriptRecord[]; cost: number; whole: boolean }>();
        const quote = (entry: SessionEntry, take: number) => {
            const key = `${entry.id}:${take}`;
            let cached = quoteCache.get(key);
            if (cached) return cached;
            const index = indices.get(entry.id);
            const text = entry.type === "custom_message" ? textOf(entry.content) : entry.type === "message" && entry.message.role === "user" ? textOf(entry.message.content) : "";
            const sourceTimes = index === undefined ? undefined : [{ sourceIndex: index, ...resolveSourceTime(entry) }];
            // Custom entries have a native identity but no global message index.
            const records: TranscriptRecord[] = index === undefined && entry.type !== "custom_message" ? [] : take === Infinity
                ? [{ kind: "excerpt", role: entry.type === "custom_message" ? "custom" : "user", ...(index === undefined ? {} : { sourceIndex: index }), text, sourceTimes,
                    ...(entry.type === "custom_message" ? { sourceEntryId: entry.id } : {}) }]
                : userPrefixRecords({ kind: "user", text, originalText: text, startsSource: true, sourceIndex: index }, undefined, take).map(record => ({ ...record, sourceTimes }));
            cached = { records, cost: lineCost(records), whole: take >= text.length };
            quoteCache.set(key, cached);
            return cached;
        };
        const highAt = (boundary: number, length: number) => {
            const kept: TranscriptRecord[] = [], selected = new Set<number>(), whole = new Set<number>();
            let cost = 0;
            const add = (entry: SessionEntry, take: number) => {
                const quoted = quote(entry, take), index = indices.get(entry.id);
                kept.push(...quoted.records); cost += quoted.cost;
                if (index !== undefined && quoted.records.length) { selected.add(index); if (quoted.whole) whole.add(index); }
            };
            if (userPosition >= 0 && userPosition < boundary && textOnly) add(current!, Infinity);
            if (startingPosition >= 0 && startingPosition < boundary && starting?.id !== current?.id) add(starting!, Infinity);
            for (const entry of anchors) if (entry.id !== current?.id && entry.id !== starting?.id && positions.get(entry.id)! < boundary) add(entry, length);
            const omissions: TranscriptRecord[] = [];
            for (const role of ["user", "assistant", "toolResult"] as const) {
                const list = units[role], prefix = prefixes[role];
                let first = 0, last = prefix.end[boundary]! - 1;
                if (role === "user") {
                    while (first <= last && selected.has(list[first]!.index)) first++;
                    while (last >= first && selected.has(list[last]!.index)) last--;
                }
                if (last < first) continue;
                const a = list[first]!, b = list[last]!;
                let count = prefix.count[last + 1]! - prefix.count[first]!;
                if (role === "user") for (const index of whole) if (index >= a.index && index <= b.index) count--;
                if (count) omissions.push(omissionRecord(role, count, [a.index, b.index], false));
            }
            const rows = [...kept, ...omissions], totalCost = cost + lineCost(omissions);
            return { kept, whole, omissions, rows, cost: totalCost, length: frameLength(totalCost, rows.length) };
        };
        const calibrationHigh = highAt(floorBoundary, minimumOpeningLength);
        const floorSummary = render(calibrationHigh.rows), floorProjection = preview(floorSummary, floorBoundary);
        // The last admission attempt and thinking-only retry share this exact floor: whole protected prompts, the smallest
        // existing summary representation, and the required fresh/native suffix. No historical fill or room target spends reply space.
        if (input.deepest) {
            assertNativeToolRounds(floorProjection);
            const after = measure(floorProjection);
            return { compaction: { summary: floorSummary, firstKeptEntryId: entries[floorBoundary]?.id ?? "", tokensBefore: input.tokensBefore,
                details: { ...detailsAt(floorBoundary), tokensAfter: after, carriedTarget: after, view: "shrunk-dialogue", mode: "shrunk", deepest: true } }, after, mode: "shrunk" };
        }
        const offset = measure(floorProjection) - nativeAt(floorBoundary) - summaryTokens(floorSummary.length);
        const price = (characters: number, boundary: number) => offset + nativeAt(boundary) + summaryTokens(characters);
        const listCache = new Map<number, { files: ReturnType<typeof ledgerItems>; actions: ReturnType<typeof actionItems>; records: TranscriptRecord[] }>();
        const listsAt = (boundary: number) => {
            const cached = listCache.get(boundary);
            if (cached) return cached;
            const compacted = entries.slice(0, boundary), resolves = (entry: SessionEntry) => readable(entry) !== undefined;
            const files = ledgerItems(compacted, indices, resolves, failedCalls), actions = actionItems(compacted, indices, resolves, failedCalls);
            const lists = { files, actions, records: [...actionRecords(actions), ...ledgerRecords(files)] };
            listCache.set(boundary, lists);
            return lists;
        };
        const preferredHigh = highAt(preferredBoundary, openingLength), preferredLists = listsAt(preferredBoundary);
        const fixedRowsCost = preferredHigh.cost + lineCost(preferredLists.records);
        const baseCharacters = frameLength(fixedRowsCost, preferredHigh.rows.length + preferredLists.records.length);
        const base = price(baseCharacters, preferredBoundary);
        const target = carriedTarget(model.contextWindow, reserveTokens, base, before);
        // The old tail rule supplies an ordering boundary only. Its recent
        // suffix follows the openings, and is charged to the same total grant.
        const boundaries = [floorBoundary];
        for (let at = floorBoundary - 1; at >= preferredBoundary; at--) {
            const entry = entries[at]!;
            if ((entry.type === "message" && entry.message.role !== "toolResult") || entry.type === "custom_message" || entry.type === "branch_summary") boundaries.push(at);
        }
        boundaries.reverse();
        const tailFor = (length: number) => {
            // Longest suffix first: the first fit is the preferred rank. Most
            // cuts keep that entire suffix, so no other boundaries need pricing.
            for (const boundary of boundaries) {
                const high = highAt(boundary, length);
                if (price(high.length, boundary) <= target) return { boundary, high };
            }
            return undefined;
        };
        let selected = tailFor(minimumOpeningLength);
        if (!selected) return { unavailable: "pi-tuck's mandatory context cannot fit or reduce the request budget",
            capacityRejected: price(calibrationHigh.length, floorBoundary) + reserveTokens >= model.contextWindow,
            floorMessages: floorProjection };
        let low = minimumOpeningLength, high = openingLength;
        while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if (tailFor(middle)) low = middle; else high = middle - 1;
        }
        selected = tailFor(low)!;
        let { boundary, high: protectedView } = selected;
        const sourceRows = rows.filter(row => row.position < boundary);
        const lists = listsAt(boundary);
        let ledger: TranscriptRecord[] = lists.records;
        // List caps are existing ranking policy; only the carried target is a
        // spending limit. Candidate list sizes have fixed, cached line prices.
        if (price(frameLength(protectedView.cost + lineCost(ledger), protectedView.rows.length + ledger.length), boundary) > target) {
          ledger = [];
          for (let keep = 0; keep <= Math.min(Math.max(MAX_LEDGER_LINES, MAX_ACTION_LINES), Math.max(lists.files.length, lists.actions.length)); keep++) {
            const candidate = [...actionRecords(lists.actions, keep), ...ledgerRecords(lists.files, keep)];
            if (price(frameLength(protectedView.cost + lineCost(candidate), protectedView.rows.length + candidate.length), boundary) <= target) ledger = candidate;
        }
        }
        const mandatory = new Set([...protectedView.whole].filter(index => {
            const row = users.find(row => row.index === index);
            return row?.message.role === "user" && isTextOnly(row.message.content);
        }));
        const fixed = [...protectedView.kept, ...ledger], fixedCost = lineCost(fixed);
        const maxSummaryCharacters = Math.floor((target - offset - nativeAt(boundary)) * 4) - wrapperCharacters;
        const maxBriefChars = Math.max(0, maxSummaryCharacters - fixedCost);
        const compileInput = { messages: sourceRows.map(row => row.message), sourceIndices: sourceRows.map(row => row.index),
            sourceEntryIds: sourceRows.map(row => row.id), sourceTimes: sourceRows.map(row => resolveSourceTime(byId.get(row.id)!)),
            ranking: { maxBriefChars, mandatorySourceIndices: mandatory } };
        const imageLabels = new Map<number | undefined, Set<string>>();
        for (const row of sourceRows) if (row.message.role === "user" && Array.isArray(row.message.content))
            imageLabels.set(row.index, new Set(row.message.content.flatMap(part => part.type === "image" ? [`[image: ${part.mimeType}]`] : [])));
        const compiledBoundary = boundary;
        // A protected custom prompt uses its native entry ID in the same anchoring/movement path as indexed user prompts.
        const sourceKey = (record: TranscriptRecord) => starting?.type === "custom_message" && record.sourceEntryId === starting.id ? starting.id : record.sourceIndex;
        const assemble = (compiled: string, at = compiledBoundary) => {
            const split = compiled ? splitSummary(compiled) : undefined;
            if (compiled && !split) throw new Error("pi-tuck returned an invalid summary");
            const inputRecords = split ? parseRecords(split.body, split.version) : protectedView.omissions;
            const expanded = new Set(protectedView.kept.filter(record => record.kind === "excerpt" && inputRecords.some(row =>
                row.kind === "excerpt" && row.role === record.role && sourceKey(row) === sourceKey(record) && row.text.startsWith(record.text!) && row.text.length >= record.text!.length)).map(sourceKey));
            const anchored = new Set(protectedView.kept.map(sourceKey));
            const moved = new Set(rows.filter(row => row.position >= at && row.position < compiledBoundary).map(row =>
                starting?.type === "custom_message" && row.id === starting.id ? row.id : row.index));
            const records = [...inputRecords.filter(record => {
                const key = sourceKey(record);
                if (key !== undefined && moved.has(key)) return false;
                if (record.kind === "excerpt" && record.role === "user" && imageLabels.get(record.sourceIndex)?.has(record.text)) return true;
                return record.role !== "user" && record.role !== "custom" || key === undefined || !anchored.has(key) || expanded.has(key);
            }), ...protectedView.kept.filter(record => !expanded.has(sourceKey(record)) && !moved.has(sourceKey(record)))];
            // Mixed user turns keep their text opening, while their image
            // metadata remains in the ordinary lower-ranked dialogue lane.
            const wholeUser = new Set(records.filter(record => record.kind === "excerpt" && record.role === "user" && record.text === userTexts.get(record.sourceIndex)).map(record => record.sourceIndex));
            const wholeAssistant = new Map<number, number>();
            for (const record of records) if (record.kind === "excerpt" && record.role === "assistant" && !record.span && record.sourceIndex !== undefined)
                wholeAssistant.set(record.sourceIndex, (wholeAssistant.get(record.sourceIndex) ?? 0) + 1);
            for (let pos = records.length - 1; pos >= 0; pos--) {
                const record = records[pos]!;
                if (record.kind !== "omission" || !record.sourceRange) continue;
                if (record.role === "user") {
                    const missing = units.user.filter(unit => unit.position < at && unit.index >= record.sourceRange!.start && unit.index <= record.sourceRange!.end && !wholeUser.has(unit.index));
                    if (!missing.length) records.splice(pos, 1);
                    else records[pos] = omissionRecord("user", missing.length, [missing[0]!.index, missing.at(-1)!.index], false);
                } else if (at !== compiledBoundary) {
                    const role = record.role;
                    if (role === "assistant" || role === "toolResult") {
                        const missing = units[role].filter(unit => unit.position < at && unit.index >= record.sourceRange!.start && unit.index <= record.sourceRange!.end &&
                            (role === "toolResult" || unit.count > (wholeAssistant.get(unit.index) ?? 0)));
                        const count = missing.reduce((n, unit) => n + unit.count - (role === "assistant" ? wholeAssistant.get(unit.index) ?? 0 : 0), 0);
                        if (!count) records.splice(pos, 1);
                        else records[pos] = omissionRecord(role, count, [missing[0]!.index, missing.at(-1)!.index], false);
                    }
                }
            }
            orderByOriginalSource(records, sourceIndices, originals.selectedIds);
            const summary = render([...records, ...ledger]);
            return { summary, after: price(summary.length, at), records };
        };
        const compiled = tuck.compileDialogue(compileInput);
        let offer = assemble(compiled.text);
        // Only capacity left after all higher ranks can extend the native tail
        // beyond its preferred rank boundary. No old allocator is consulted.
        const liveStartId = calibration.ok ? calibration.selectedIds[0] : undefined;
        const liveStart = liveStartId === undefined ? preferredBoundary : positions.get(liveStartId)!;
        if (boundary > liveStart) {
            const recordCosts = new Float64Array(entries.length + 1), recordCounts = new Int32Array(entries.length + 1);
            const sourcePositions = new Map(rows.map(row => [row.index, row.position]));
            const wholeUsers = new Set(offer.records.filter(record => record.kind === "excerpt" && record.role === "user" &&
                record.text === userTexts.get(record.sourceIndex)).map(record => record.sourceIndex));
            const wholeAssistants = new Map<number, number>();
            for (const record of offer.records) {
                const at = record.sourceIndex === undefined ? undefined : sourcePositions.get(record.sourceIndex);
                if (at !== undefined) { recordCosts[at + 1] += lineCost([record]); recordCounts[at + 1]++; }
                if (record.kind === "excerpt" && record.role === "assistant" && !record.span && record.sourceIndex !== undefined)
                    wholeAssistants.set(record.sourceIndex, (wholeAssistants.get(record.sourceIndex) ?? 0) + 1);
            }
            for (let at = 1; at <= entries.length; at++) {
                recordCosts[at] += recordCosts[at - 1]!; recordCounts[at] += recordCounts[at - 1]!;
            }
            // A tail extension removes source records and shortens at most three
            // counted ranges. Price those changes from prefix sums; render only the
            // winning suffix, rather than parsing/serializing the dialogue per step.
            const ranges = offer.records.flatMap(record => {
                if (record.kind !== "omission" || !record.sourceRange || !["user", "assistant", "toolResult"].includes(record.role ?? "")) return [];
                const role = record.role as keyof typeof units;
                const missing = units[role].flatMap(unit => {
                    const count = role === "user" ? Number(!wholeUsers.has(unit.index)) : unit.count - (role === "assistant" ? wholeAssistants.get(unit.index) ?? 0 : 0);
                    return count && unit.position < compiledBoundary && unit.index >= record.sourceRange!.start && unit.index <= record.sourceRange!.end ? [{ ...unit, count }] : [];
                });
                const ends = new Int32Array(entries.length + 1), counts = new Int32Array(missing.length + 1);
                let seen = 0;
                for (let at = 0; at <= entries.length; at++) {
                    while (seen < missing.length && missing[seen]!.position < at) seen++;
                    ends[at] = seen;
                }
                missing.forEach((unit, at) => counts[at + 1] = counts[at]! + unit.count);
                return [{ role, missing, ends, counts, cost: lineCost([record]) }];
            });
            const baseCost = lineCost(offer.records) + lineCost(ledger), baseCount = offer.records.length + ledger.length;
            const extensionPrice = (at: number) => {
                let cost = baseCost - (recordCosts[compiledBoundary]! - recordCosts[at]!);
                let count = baseCount - (recordCounts[compiledBoundary]! - recordCounts[at]!);
                for (const range of ranges) {
                    const end = range.ends[at]!;
                    cost -= range.cost;
                    if (end) cost += lineCost([omissionRecord(range.role, range.counts[end]!, [range.missing[0]!.index, range.missing[end - 1]!.index], false)]);
                    else count--;
                }
                return price(frameLength(cost, count), at);
            };
            for (let at = boundary - 1; at >= liveStart; at--) {
                const entry = entries[at]!;
                if (entry.type !== "message" && entry.type !== "custom_message" && entry.type !== "branch_summary") continue;
                if (entry.type === "message" && entry.message.role === "toolResult") continue;
                if (extensionPrice(at) <= target) boundary = at;
                else break;
            }
            if (boundary !== compiledBoundary) offer = assemble(compiled.text, boundary);
        }
        const projection = preview(offer.summary, boundary);
        assertNativeToolRounds(projection);
        const after = measure(projection);
        if (after + reserveTokens >= model.contextWindow || after >= before)
            return { unavailable: "pi-tuck's draft does not reduce context within the request budget", capacityRejected: after + reserveTokens >= model.contextWindow, floorMessages: floorProjection };
        const mode: DraftMode = compiled.step === "whole" ? "dialogue" : "shrunk";
        return { compaction: { summary: offer.summary, firstKeptEntryId: entries[boundary]?.id ?? "", tokensBefore: input.tokensBefore,
            details: { ...detailsAt(boundary), tokensAfter: after, carriedTarget: target, view: mode === "dialogue" ? "complete-dialogue" : "shrunk-dialogue", mode } }, after, mode };
    }

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
