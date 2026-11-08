import { resolveSourceTime, type SourceTime } from "./tuck/core/source-time";
import { orderByOriginalSource } from "./tuck/core/source-order";
import { assertNativeToolRounds, isDiscardedResponse } from "./protocol.js";
import { parseRecords, serializeTranscript, splitSummary, TRANSCRIPT_HEADER, type TranscriptRecord } from "./tuck/core/transcript";
import { DIALOGUE_SUFFIX } from "./tuck/core/format";
import { omissionRecord, userPrefixRecords } from "./tuck/core/brief";
import { isTextOnly, textOf } from "./tuck/core/content";
import { actionItems, actionRecords, ledgerItems, ledgerRecords } from "./ledger.js";
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
	/** The lower ranks within `ranking.maxBriefChars`: recent assistant third, more user text, then remaining dialogue. */
	compileShrunkDialogue(input: { messages: AgentMessage[]; sourceIndices: (number | undefined)[]; sourceEntryIds?: readonly string[]; sourceTimes?: readonly SourceTime[];
		receiptContext?: { messages: AgentMessage[]; sourceIndices: (number | undefined)[] };
		ranking: { maxBriefChars: number; mandatorySourceIndices?: ReadonlySet<number> } }): string;
	compileOmissions(input: Parameters<Tuck["compileShrunkDialogue"]>[0]): string;
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
import { compileShrunkDialogue, compileDialogue, compileOmissions } from "./tuck/core/summarize";
import { prepareKeywordQuery } from "./tuck/core/keyword-query";
import { searchEntriesDetailed } from "./tuck/core/search-entries";
export const tuck: Tuck = { buildOwnCut, applyTailBudget, calibrateCharsPerToken, buildGlobalIndexById, compileShrunkDialogue, compileDialogue, compileOmissions, prepareKeywordQuery, searchEntriesDetailed };
/** The existing quarter-free historical allowance, in Pi's four-character summary
 * estimate. The ranked fill spends it and the preferred tail's amount together. */
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
    const preferredBoundary = cut.compactAll ? entries.length : entries.findIndex(entry => entry.id === cut.firstKeptEntryId);
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
        const failedCalls = new Set(entries.flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.isError ? [entry.message.toolCallId] : []));
        const before = measure(projected.messages);
        const room = Math.max(0, model.contextWindow - reserveTokens - 1);
        // A sublinear opening grows with this cut's room, without a task budget or a
        // privileged first-prompt cap. All nine anchors get the same prefix length.
        // The existing preservation contract watches the first 80 characters.
        // This is a minimum, not a task/head cap: spare room grows each opening.
        const minimumOpeningLength = 80;
        const openingLength = Math.max(minimumOpeningLength, Math.floor(Math.sqrt(room * 4)));
        const answered: SessionEntry[] = [];
        let replied = false;
        for (let at = entries.length - 1; at >= 0; at--) {
            const entry = entries[at]!;
            if (entry.type !== "message") continue;
            if (entry.message.role === "assistant" && !isDiscardedResponse(entry.message) && entry.message.content.length) { replied = true; continue; }
            if (entry.message.role !== "user") continue;
            if (replied && isTextOnly(entry.message.content)) answered.push(entry);
            replied = false;
        }
        const anchors = [...new Map([...answered.slice(0, 8), ...(firstUserPosition >= 0 ? [entries[firstUserPosition]!] : [])].map(entry => [entry.id, entry])).values()];
        const detailsAt = (boundary: number) => ({ compactor: "pi-tuck", version: 2, adapter: "standalone",
            keptUserTurns: entries.slice(boundary).filter(entry => entry.type === "message" && entry.message.role === "user").length,
            ...(boundary === preferredBoundary && budgetCut ? { budgetCut } : {}) });
        const preview = (summary: string, boundary: number) => {
            const manager = SessionManager.inMemory(ctx.cwd, undefined, [header, ...branch]);
            manager.appendCompaction(summary, entries[boundary]?.id ?? "", input.tokensBefore, detailsAt(boundary), true);
            return manager.buildSessionProjection().messages;
        };
        const quoted = (entry: SessionEntry, take: number): TranscriptRecord[] => {
            if (entry.type !== "message" || entry.message.role !== "user" || !isTextOnly(entry.message.content)) return [];
            const text = textOf(entry.message.content), index = indices.get(entry.id);
            if (index === undefined || !text.trim() || take <= 0) return [];
            const sourceTimes = [{ sourceIndex: index, ...resolveSourceTime(entry) }];
            return userPrefixRecords({ kind: "user", text, originalText: text, startsSource: true, sourceIndex: index }, undefined, take)
                .map(record => ({ ...record, sourceTimes }));
        };
        const positions = new Map(entries.map((entry, at) => [entry.id, at]));
        const originals = tuck.buildOwnCut(entries.filter(entry => entry.type !== "compaction"), 0);
        if (!originals.ok) return { unavailable: "No eligible original prefix to compile" };
        const byId = new Map(entries.map(entry => [entry.id, entry]));
        const receiptContext = { messages: originals.messages, sourceIndices: originals.selectedIds.map(id => indices.get(id)) };
        // Count original units independently of serialized omission ranges. This
        // lets the same selected text move into the tail without guessing how
        // many units a broad range assigned to one particular message.
        type RankedUnit = { index: number; position: number; role: "user" | "assistant" | "toolResult"; count: number; text?: string };
        const units = originals.messages.flatMap((message: AgentMessage, at): RankedUnit[] => {
            const index = indices.get(originals.selectedIds[at]!);
            if (index === undefined) return [];
            const position = positions.get(originals.selectedIds[at]!)!;
            if (message.role === "user") return textOf(message.content).trim() ? [{ index, position, role: "user" as const, count: 1, text: textOf(message.content) }] : [];
            if (message.role === "toolResult") return [{ index, position, role: "toolResult" as const, count: 1 }];
            if (message.role !== "assistant" || isDiscardedResponse(message)) return [];
            const count = message.content.filter(part => part.type === "text" && part.text.trim()).length;
            return count ? [{ index, position, role: "assistant" as const, count }] : [];
        });
        const userTexts = new Map(units.flatMap(unit => unit.text === undefined ? [] : [[unit.index, unit.text] as const]));
        const prepare = (boundary: number) => {
            const selected = originals.selectedIds.flatMap((id, i) => positions.get(id)! < boundary ? [{ id, message: originals.messages[i]! }] : []);
            const ids = selected.map(row => row.id), messages = selected.map(row => row.message);
            const sourceIndices = ids.map(id => indices.get(id));
            const compacted = entries.slice(0, boundary), resolves = (entry: SessionEntry) => readable(entry) !== undefined;
            const files = ledgerItems(compacted, indices, resolves, failedCalls), actions = actionItems(compacted, indices, resolves, failedCalls);
            return { ids, messages, sourceIndices, files, actions };
        };
        const assemble = (compiled: string, kept: TranscriptRecord[], ledger: TranscriptRecord[], boundary: number) => {
            const split = compiled ? splitSummary(compiled) : undefined;
            if (compiled && !split) throw new Error("pi-tuck returned an invalid summary");
            const compiledRecords = split ? parseRecords(split.body, split.version) : [];
            // A complete lower-ranked user source replaces its opening. Partial
            // passage clips leave the exact opening and its recall offset intact.
            const expanded = new Set(kept.filter(record => record.kind === "excerpt" && compiledRecords.some(row =>
                row.kind === "excerpt" && row.role === "user" && row.sourceIndex === record.sourceIndex && row.text.startsWith(record.text!) && row.text.length > record.text!.length)).map(record => record.sourceIndex));
            const anchored = new Set(kept.flatMap(record => record.sourceIndex === undefined ? [] : [record.sourceIndex]));
            const records = [...compiledRecords.flatMap(record => {
                if (record.kind === "omission" && record.count !== undefined) return [];
                if (record.role !== "user") return [record];
                if (record.sourceIndex !== undefined && anchored.has(record.sourceIndex) && !expanded.has(record.sourceIndex)) return [];
                return [record];
            }), ...kept.filter(record => !expanded.has(record.sourceIndex))];
            const shown = new Map<string, number>(), whole = new Map<string, number>();
            for (const record of records) {
                if (record.sourceIndex === undefined) continue;
                const key = `${record.role}:${record.sourceIndex}`;
                if (record.role === "user" && record.kind === "excerpt") {
                    shown.set(key, 1);
                    if (record.text === userTexts.get(record.sourceIndex)) whole.set(key, 1);
                } else if (record.role === "assistant") {
                    if (record.kind === "excerpt" && !record.span) {
                        shown.set(key, (shown.get(key) ?? 0) + 1);
                        whole.set(key, (whole.get(key) ?? 0) + 1);
                    } else if (record.kind === "omission" && record.span) shown.set(key, (shown.get(key) ?? 0) + 1);
                }
            }
            for (const role of ["user", "assistant", "toolResult"] as const) {
                const omitted = units.filter(unit => unit.position < boundary && unit.role === role &&
                    unit.count > (shown.get(`${role}:${unit.index}`) ?? 0));
                if (!omitted.length) continue;
                const start = Math.min(...omitted.map(unit => unit.index)), end = Math.max(...omitted.map(unit => unit.index));
                // A range can cross a partially retained unit. Count that unit
                // too: its own continuation note does not lower the range's count.
                const count = units.reduce((total, unit) => total + (unit.position < boundary && unit.role === role && unit.index >= start && unit.index <= end
                    ? Math.max(0, unit.count - (whole.get(`${role}:${unit.index}`) ?? 0)) : 0), 0);
                records.push(omissionRecord(role, count, [start, end], false));
            }

            orderByOriginalSource(records, receiptContext.sourceIndices, originals.selectedIds);
            records.push(...ledger);
            const summary = (serializeTranscript(records) || TRANSCRIPT_HEADER + "\n") + DIALOGUE_SUFFIX;
            const projection = preview(summary, boundary);
            assertNativeToolRounds(projection);
            return { summary, after: measure(projection) };
        };
        const currentRecords = (boundary: number) => userPosition >= 0 && userPosition < boundary && textOnly ? quoted(current!, Infinity) : [];
        const openings = (boundary: number, length: number) => anchors.filter(entry => entry.id !== current?.id && entries.indexOf(entry) < boundary).flatMap(entry => quoted(entry, length));
        // Keep the existing half-room native allowance and quarter-free historical
        // allowance as the amount. The ranked fill may spend that amount on either
        // representation; the tail gets only what the higher ranks leave.
        const preferred = prepare(preferredBoundary);
        const preferredKept = [...currentRecords(preferredBoundary), ...openings(preferredBoundary, openingLength)];
        const preferredLedger = [...actionRecords(preferred.actions), ...ledgerRecords(preferred.files)];
        const preferredBase = assemble("", preferredKept, preferredLedger, preferredBoundary).after;
        const allowance = historicalAllowance(model.contextWindow, reserveTokens, preferredBase, before);
        const target = Math.min(room, before - 1, preferredBase + allowance / 4);
        const source = prepare(floorBoundary);
        const sourceTimes = source.ids.map(id => resolveSourceTime(byId.get(id)!));
        let kept = [...currentRecords(floorBoundary), ...openings(floorBoundary, minimumOpeningLength)];
        let ledger: TranscriptRecord[] = [];
        const compileInput = (limit: number) => ({ messages: source.messages, sourceIndices: source.sourceIndices, sourceEntryIds: source.ids,
            sourceTimes, receiptContext,
            ranking: { maxBriefChars: limit, mandatorySourceIndices: new Set(kept.flatMap(record => record.sourceIndex === undefined ? [] : [record.sourceIndex])) } });
        // Charge the omission-only view before filling: dropped units never vanish
        // because a richer view did not fit. It has every original source pointer.
        const floorText = () => tuck.compileOmissions(compileInput(0));
        let floor = assemble(floorText(), kept, ledger, floorBoundary);
        const capacity = (after: number) => after + reserveTokens >= model.contextWindow;
        if (capacity(floor.after) || floor.after >= before) return { unavailable: "pi-tuck's mandatory context cannot fit or reduce the request budget",
            capacityRejected: capacity(floor.after), floorMessages: preview(floor.summary, floorBoundary) };
        // Openings outrank the ledger and every part of the old native tail. A
        // common length is reduced only if the room cannot hold all anchors.
        let low = minimumOpeningLength, high = openingLength;
        while (low < high) {
            const mid = Math.ceil((low + high) / 2), base = currentRecords(floorBoundary);
            kept = [...base, ...openings(floorBoundary, mid)];
            const candidate = assemble(floorText(), kept, [], floorBoundary);
            if (candidate.after <= Math.max(target, floor.after)) low = mid; else high = mid - 1;
        }
        kept = [...currentRecords(floorBoundary), ...openings(floorBoundary, low)];
        // Grow both lists newest first; line caps and their relative rank remain
        // the ledger's existing policy, but no heading is mandatory on no-room cuts.
        const maxLines = Math.max(source.files.length, source.actions.length);
        low = 0; high = maxLines;
        while (low < high) {
            const mid = Math.ceil((low + high) / 2);
            const candidateLedger = [...actionRecords(source.actions, mid), ...ledgerRecords(source.files, mid)];
            if (assemble(floorText(), kept, candidateLedger, floorBoundary).after <= target) low = mid; else high = mid - 1;
        }
        const listed = [...actionRecords(source.actions, low), ...ledgerRecords(source.files, low)];
        if (assemble(floorText(), kept, listed, floorBoundary).after <= target) ledger = listed;
        floor = assemble(floorText(), kept, ledger, floorBoundary);
        const briefLimit = Math.max(0, Math.floor((target - floor.after) * 4) + floorText().length);
        const baseInput = compileInput(briefLimit);
        const prepared = { ...baseInput, ranking: { ...baseInput.ranking, mandatorySourceIndices: new Set(currentRecords(floorBoundary).flatMap(record => record.sourceIndex === undefined ? [] : [record.sourceIndex])) } };
        const whole = tuck.compileDialogue(prepared);
        const full = whole && whole.length <= briefLimit ? assemble(whole, kept, ledger, floorBoundary) : undefined;
        if (input.operatorManual && full && full.after >= before && before + reserveTokens < model.contextWindow)
            return { unavailable: "Manual compaction preserved original dialogue: the complete-dialogue view does not reduce context" };
        let compiled = full && full.after <= target ? whole : tuck.compileShrunkDialogue(prepared) || floorText();
        let offer = assemble(compiled, kept, ledger, floorBoundary);
        const mode: DraftMode = compiled === whole && Boolean(whole) ? "dialogue" : "shrunk";
        // Extend exactly one suffix backwards, only at native protocol boundaries.
        // Higher-ranked text already chosen above remains exact when it moves into
        // the native tail. A boundary never skips a receipt or an older middle unit.
        let boundary = floorBoundary;
        for (let at = floorBoundary - 1; at >= preferredBoundary; at--) {
            const entry = entries[at]!;
            if (entry.type !== "message" && entry.type !== "custom_message" && entry.type !== "branch_summary") continue;
            if (entry.type === "message" && entry.message.role === "toolResult") continue;
            const moved = new Set(entries.slice(at, floorBoundary).flatMap(entry => indices.get(entry.id) === undefined ? [] : [indices.get(entry.id)!]));
            const split = splitSummary(compiled);
            const records = split ? parseRecords(split.body, split.version).flatMap(record => {
                if (record.sourceIndex !== undefined && moved.has(record.sourceIndex)) return [];
                return record.kind === "omission" && record.count !== undefined ? [] : [record];
            }) : [];
            const candidateCompiled = records.length ? serializeTranscript(records) + DIALOGUE_SUFFIX : "";
            const candidateKept = kept.filter(record => record.sourceIndex === undefined || !moved.has(record.sourceIndex));
            const candidate = assemble(candidateCompiled, candidateKept, ledger, at);
            if (candidate.after > target) break;
            boundary = at; compiled = candidateCompiled; offer = candidate;
        }
        if (capacity(offer.after) || offer.after >= before) return { unavailable: "pi-tuck's draft does not reduce context within the request budget",
            capacityRejected: capacity(offer.after), floorMessages: preview(floor.summary, floorBoundary) };
        return { compaction: { summary: offer.summary, firstKeptEntryId: entries[boundary]?.id ?? "", tokensBefore: input.tokensBefore,
            details: { ...detailsAt(boundary), tokensAfter: offer.after, view: mode === "dialogue" ? "complete-dialogue" : "shrunk-dialogue", mode } }, after: offer.after, mode };
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
