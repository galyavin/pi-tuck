import { resolveSourceTime, type SourceTime } from "./pi-tuck/core/source-time";
import { isSourceExport, isLookupTool, isRecallTool } from "./pi-tuck/core/recall-operation";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
export interface RecallOptions {
	query?: string;
	entryId?: string;
	/** UTF-16 character offset across the readable text of matching entries. */
	offset?: number;
	/** Maximum text characters, not number of entries. */
	limit?: number;
}
export interface RecordedAttempt { nodeId: string; attemptId: string }
export interface PreparedKeywordMatcher {
	test(text: string): boolean;
	find(text: string, fromIndex?: number): { index: number; text: string } | undefined;
}
export interface PreparedKeywordQuery {
	readonly coverageTerms: readonly PreparedKeywordMatcher[];
	test(text: string): boolean;
}
export interface RecallFragment extends ReadableEntry {
	/** Offset within this source entry's readable text. */
	textOffset: number;
	totalCharacters: number;
}
export interface RecallPage {
	notice: string;
	status: "ok" | "not_found" | "no_matches" | "end";
	entries: RecallFragment[];
	offset: number;
	limit: number;
	nextOffset: number | null;
	totalCharacters: number;
	matchedEntries: number;
	mode?: "source_matches";
	matchedOccurrences?: number;
	returnedOccurrences?: number;
}
export const MAX_RECALL_CHARACTERS = 16000;
export const MAX_RECALL_QUERY_CHARACTERS = 256;
export const MAX_RECALL_ENTRY_ID_CHARACTERS = 100;
export const ATTEMPT_NOTICE = "sourceTime labels recorded message/journal time, never event occurrence; unknown means unavailable. Branch order is unchanged. Summary time belongs only to the summary. recordedAttempt identifies native record membership, not causation, present effects or permission to replay; null means unavailable. Summaries have no original-event attribution.";
export interface RecallPolicy { privateCustomTypes?: readonly string[]; attemptMarkerType?: string; readAttemptMarker?: (entry: SessionEntry) => RecordedAttempt | undefined; }
export interface ReadableEntry {
	sourceTime: SourceTime;
	entryId: string;
	role: "user" | "assistant" | "toolResult" | "custom" | "compaction" | "bashExecution";
	text: string;
	toolName?: string;
	toolCallId?: string;
	isError?: boolean;
	stopReason?: AssistantMessage["stopReason"];
	metadataTruncated?: true;
	recordedAttempt?: RecordedAttempt | null;
	producerTime?: SourceTime;
	producerRead?: { entryId: string; offset: number; limit: number };
	/** Complete small original call, only alongside an explicitly read whole receipt. */
	producerCall?: { sourceTime: SourceTime; name: string; id: string; arguments: Record<string, unknown> };
}

interface DiscoveryEntry extends ReadableEntry {
	sourceText: string;
	ranges: { start: number; end: number }[];
}

export function createRecall(policy: RecallPolicy = {}) {

const MAX_RESULTS = 20;
const MAX_TOOL_METADATA = 200;
const PRIVATE_CUSTOM_TYPES = new Set(policy.privateCustomTypes ?? []);

/** Eligible conversation sources; text recall additionally strips non-readable blocks. */
function isHistorySource(entry: SessionEntry): boolean {
	if (entry.type === "compaction") return true;
	if (entry.type === "custom_message") return !PRIVATE_CUSTOM_TYPES.has(entry.customType);
	if (entry.type !== "message") return false;
	const message = entry.message;
	return message.role === "user" || message.role === "assistant" || message.role === "toolResult" ||
        (message.role === "bashExecution" && !message.excludeFromContext) ||
		(message.role === "custom" && !PRIVATE_CUSTOM_TYPES.has(message.customType));
}

/** Derive membership from the supplied branch; no session reads or persisted index. */
function recallAttempts(branch: readonly SessionEntry[]): ReadonlyMap<string, RecordedAttempt | null> {
	const counts = new Map<string, number>();
	for (const entry of branch) counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
	const attempts = new Map<string, RecordedAttempt | null>();
	const identities = new Set<string>();
	let current: RecordedAttempt | null = null;
	for (const entry of branch) {
		if (entry.type === "custom" && policy.readAttemptMarker && entry.customType === policy.attemptMarkerType) {
			current = null;
			try {
				const marker = policy.readAttemptMarker!(entry);
                if (!marker) continue;
				identities.add(marker.nodeId);
				if (marker.attemptId && counts.get(entry.id) === 1)
					current = { nodeId: marker.nodeId, attemptId: marker.attemptId };
			} catch { /* Malformed markers cannot supply attribution; history stays readable. */ }
		} else if (isToolSource(entry)) attempts.set(entry.id, counts.get(entry.id) === 1 ? current : null);
	}
	if (identities.size > 1) for (const id of attempts.keys()) attempts.set(id, null);
	return attempts;
}
function isToolSource(entry: SessionEntry): boolean {
	return entry.type === "message" && (entry.message.role === "toolResult" ||
		(entry.message.role === "assistant" && entry.message.content.some((b) => b.type === "toolCall")) ||
        entry.message.role === "bashExecution");
}



function textContent(content: unknown, includeToolCalls = false): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const blocks: unknown[] = content;
	return blocks.flatMap((block) => {
		if (block === null || typeof block !== "object" || !("type" in block)) return [];
		if (block.type === "text" && "text" in block && typeof block.text === "string") return [block.text];
		if (includeToolCalls && block.type === "toolCall" && "name" in block && typeof block.name === "string"
			&& "id" in block && typeof block.id === "string" && "arguments" in block)
			return [JSON.stringify({ toolCall: { name: block.name, id: block.id, arguments: block.arguments } })];
		return [];
	}).join("\n");
}

function readable(entry: SessionEntry, attempts?: ReadonlyMap<string, RecordedAttempt | null>, links?: ReadonlyMap<string, NonNullable<ReadableEntry["producerRead"]> & { sourceTime: SourceTime } >): ReadableEntry | undefined {
	if (!isHistorySource(entry)) return;
	let value: Omit<ReadableEntry, "entryId" | "sourceTime"> | undefined;
	if (entry.type === "compaction") value = { role: "compaction", text: entry.summary };
	else if (entry.type === "custom_message")
		value = { role: "custom", text: textContent(entry.content) };
	else if (entry.type === "message") {
		const message = entry.message;
		if (message.role === "user" || message.role === "assistant" || message.role === "custom")
			value = { role: message.role, text: textContent(message.content, message.role === "assistant"),
				...(message.role === "assistant" && message.stopReason !== undefined ? { stopReason: message.stopReason } : {}) };
		else if (message.role === "bashExecution")
            value = { role: "bashExecution", text: JSON.stringify(message) };
        else if (message.role === "toolResult") value = {
			role: "toolResult", text: textContent(message.content),
			toolName: message.toolName.slice(0, MAX_TOOL_METADATA),
			toolCallId: message.toolCallId.slice(0, MAX_TOOL_METADATA),
			isError: message.isError,
			...(links?.has(entry.id) ? { producerRead: { entryId: links.get(entry.id)!.entryId, offset: links.get(entry.id)!.offset, limit: links.get(entry.id)!.limit }, producerTime: links.get(entry.id)!.sourceTime } : {}),
			...(message.toolName.length > MAX_TOOL_METADATA || message.toolCallId.length > MAX_TOOL_METADATA
				? { metadataTruncated: true as const } : {}),
		};
	}
	if (!value?.text) return;
	// Native IDs are short. Never shorten an ID into a different source locator.
	if (!entry.id || entry.id.length > MAX_RECALL_ENTRY_ID_CHARACTERS)
		throw new Error("Recall source entry has an invalid or oversized ID");
	return { entryId: entry.id, ...value, sourceTime: resolveSourceTime(entry),
		...(isToolSource(entry) ? { recordedAttempt: attempts?.get(entry.id) ?? null } : {}) };
}

/** Exact native relation only; ephemeral and restricted to this supplied branch. */
function producerReads(branch: readonly SessionEntry[]) {
	const identities = new Map<string, number>();
	for (const entry of branch) identities.set(entry.id, (identities.get(entry.id) ?? 0) + 1);
	const usable = (entry: SessionEntry) => typeof entry.id === "string" && entry.id.length > 0 &&
		entry.id.length <= MAX_RECALL_ENTRY_ID_CHARACTERS && identities.get(entry.id) === 1 && isHistorySource(entry);
	type Call = { order: number; name: string; export?: boolean; read?: NonNullable<ReadableEntry["producerRead"]> & { sourceTime: SourceTime } };
	const calls = new Map<string, Call[]>(), receipts = new Map<string, { entry: SessionEntry; order: number; name: string }[]>();
	for (const [order, entry] of branch.entries()) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "toolResult" && typeof message.toolCallId === "string" && message.toolCallId) {
			const group = receipts.get(message.toolCallId) ?? []; group.push({ entry, order, name: message.toolName }); receipts.set(message.toolCallId, group);
		}
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		let offset = 0, parts = 0, valid = true; const local: Call[] = [];
		for (const block of message.content) {
			if (!block || typeof block !== "object") { valid = false; continue; }
			const call = block.type === "toolCall" && typeof block.id === "string" && block.id ?
				{ order, name: block.name } as Call : undefined;
			if (call && block.type === "toolCall") { call.export = isSourceExport(block.arguments); const group = calls.get(block.id) ?? []; group.push(call); calls.set(block.id, group); local.push(call); }
			// Exactly the parts admitted by textContent, including empty text/newlines.
			if (!(block.type === "text" && typeof block.text === "string" || block.type === "toolCall" &&
				typeof block.name === "string" && typeof block.id === "string" && "arguments" in block)) continue;
			try {
				const text = textContent([block], true); if (parts++) offset++;
				if (call && block.type === "toolCall" && block.arguments && typeof block.arguments === "object" && !Array.isArray(block.arguments))
					call.read = { entryId: entry.id, sourceTime: resolveSourceTime(entry), offset, limit: snippetEnd(text, text.length, 0, MAX_RECALL_CHARACTERS) };
				offset += text.length;
			} catch { valid = false; }
		}
		if (!valid || !usable(entry)) for (const call of local) delete call.read;
	}
	const links = new Map<string, NonNullable<ReadableEntry["producerRead"]> & { sourceTime: SourceTime }>();
	for (const [id, producers] of calls) {
		const results = receipts.get(id), call = producers[0], result = results?.[0];
		if (producers.length === 1 && results?.length === 1 && call?.read && result && usable(result.entry) &&
			typeof call.name === "string" && call.name.length > 0 && (!isLookupTool(call.name) || isRecallTool(call.name) && call.export) &&
			call.name === result.name && call.order < result.order) links.set(result.entry.id, call.read);
	}
	return links;
}

/** Match ranges address the unmodified readable source, including mixed messages. */
function discoveryRanges(entry: SessionEntry, text: string, links?: ReadonlyMap<string, NonNullable<ReadableEntry["producerRead"]> & { sourceTime: SourceTime } >): { start: number; end: number }[] {
	// Saved views repeat selected originals; discovery must not rank that repetition.
	// Explicit ID reads still expose the saved view through readable().
	if (entry.type === "compaction") return [];
	if (entry.type !== "message") return [{ start: 0, end: text.length }];
	const message = entry.message;
	if (message.role === "toolResult" && isLookupTool(message.toolName) && !links?.has(entry.id)) return [];
	if (message.role !== "assistant") return [{ start: 0, end: text.length }];
	const ranges: { start: number; end: number }[] = [];
	let position = 0;
	for (const block of message.content) {
		if (block.type !== "text" && block.type !== "toolCall") continue;
		const part = textContent([block], true);
		const end = position + part.length;
		if (block.type !== "toolCall" || !isLookupTool(block.name) || isRecallTool(block.name) && isSourceExport(block.arguments)) {
			const previous = ranges.at(-1);
			if (previous && previous.end + 1 === position) previous.end = end;
			else ranges.push({ start: position, end });
		}
		position = end + 1;
	}
	return ranges.filter(({ start, end }) => end > start);
}

/** Ranking uses filtered text; excerpts retain the original readable coordinates. */
function discoveryEntry(entry: SessionEntry, attempts?: ReadonlyMap<string, RecordedAttempt | null>, links?: ReadonlyMap<string, NonNullable<ReadableEntry["producerRead"]> & { sourceTime: SourceTime } >): DiscoveryEntry | undefined {
	const row = readable(entry, attempts, links);
	if (!row) return;
	const ranges = discoveryRanges(entry, row.text, links);
	const text = ranges.map(({ start, end }) => row.text.slice(start, end)).join("\n");
	return text ? { ...row, text, sourceText: row.text, ranges } : undefined;
}

function snippetEnd(source: string, rangeEnd: number, start: number, limit: number): number {
	let end = Math.min(rangeEnd, start + limit);
	if (end < rangeEnd && /[\uD800-\uDBFF]/u.test(source[end - 1]!) && /[\uDC00-\uDFFF]/u.test(source[end]!)) end--;
	return end;
}

/** Localize an already-ranked hit; never splice discovery ranges or rewrite text. */
function discoveryExcerpt(row: DiscoveryEntry, query: PreparedKeywordQuery) {
	const limit = 600, source = row.sourceText;
	let best: { snippet: string; offset: number; score: number } | undefined;
	ranges: for (const range of row.ranges) {
		const boundedSource = source.slice(0, range.end);
		const starts = new Set<number>();
		for (const term of query.coverageTerms) {
			let cursor = range.start;
			while (cursor < range.end) {
				const found = term.find(boundedSource, cursor);
				if (!found || found.index >= range.end) break;
				const matchEnd = found.index + found.text.length;
				const lookBehind = Math.max(range.start, matchEnd - limit);
				const newline = source.slice(lookBehind, found.index).lastIndexOf("\n");
				const start = newline >= 0 ? lookBehind + newline + 1
					: lookBehind === range.start ? range.start : Math.max(range.start, found.index - 120);
				const addStart = (candidate: number) => {
					if (candidate > range.start && /[\uDC00-\uDFFF]/u.test(source[candidate]!) && /[\uD800-\uDBFF]/u.test(source[candidate - 1]!)) candidate--;
					starts.add(candidate);
				};
				addStart(start);
				// Coverage optima can occur with either edge tight to a match.
				addStart(Math.max(range.start, matchEnd - limit));
				addStart(found.index);
				if (query.coverageTerms.length === 1) break;
				cursor = found.index + Math.max(found.text.length, 1);
			}
		}
		for (const start of [...starts].sort((a, b) => a - b)) {
			const end = snippetEnd(source, range.end, start, limit);
			const snippet = source.slice(start, end);
			const score = query.coverageTerms.reduce((n, term) => n + Number(term.test(snippet)), 0);
			if (!best || score > best.score || (score === best.score && start < best.offset))
				best = { snippet, offset: start, score };
			if (score === query.coverageTerms.length) break ranges;
		}
	}
	// Ranking includes the actual source role. Only that genuine match may open
	// the beginning of a range when no query term occurs in source text.
	if (!best && query.test(row.role)) {
		const range = row.ranges[0]!;
		const end = snippetEnd(source, range.end, range.start, limit);
		best = { snippet: source.slice(range.start, end), offset: range.start, score: 0 };
	}
	if (!best) throw new Error("Ranked recall hit has no eligible keyword or role match");
	return { snippet: best.snippet, totalCharacters: source.length,
		read: { entryId: row.entryId, offset: best.offset, limit: best.snippet.length } };
}

/** Expand only the eligible contiguous range containing the admitted exact passage. */
function discoveryWholeRange(row: DiscoveryEntry, passage: ReturnType<typeof discoveryExcerpt>) {
 const start = passage.read.offset, end = start + passage.read.limit;
 const range = row.ranges.find(range => range.start <= start && range.end >= end);
 if (!range) throw new Error("Recall passage lacks its original eligible range");
 return { snippet: row.sourceText.slice(range.start, range.end), totalCharacters: row.sourceText.length,
  read: { entryId: row.entryId, offset: range.start, limit: range.end - range.start } };
}

/**
 * The host supplies this role's current branch; this function never opens a path.
 * Query is a case-insensitive literal over eligible source ranges. Offset/limit
 * page the concatenation of matching texts, with no added separators. Without an
 * explicit offset, a source-scoped query returns the whole matching readable
 * source when it fits, otherwise disjoint exact match windows;
 * unscoped browsing starts up to 120 characters before its first match.
 * Returned nextOffset uses the same filter and can page through any long entry.
 * At most 20 fragments and 16,000 text characters are returned; metadata is bounded.
 */
/** Add factual call context to a demanded complete receipt, never to discovery or partial pages. */
function contextualReceipt(branch: readonly SessionEntry[], entryId: string | undefined, fragment: RecallFragment): RecallFragment {
	const read = fragment.producerRead;
	if (entryId === undefined || fragment.entryId !== entryId || fragment.role !== "toolResult" ||
		fragment.metadataTruncated || !read || read.limit > 512 || fragment.textOffset !== 0 ||
		fragment.text.length !== fragment.totalCharacters) return fragment;
	const sources = branch.filter(entry => entry.id === read.entryId);
	const source = sources.length === 1 ? readable(sources[0]!) : undefined;
	if (!source) return fragment;
	try {
		const frame = JSON.parse(source.text.slice(read.offset, read.offset + read.limit)) as unknown;
		if (!frame || typeof frame !== "object" || !("toolCall" in frame)) return fragment;
		const call = frame.toolCall;
		if (!call || typeof call !== "object" || !("name" in call) || !("id" in call) || !("arguments" in call) ||
			call.name !== fragment.toolName || call.id !== fragment.toolCallId ||
			!call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments)) return fragment;
		return { ...fragment, producerCall: { sourceTime: source.sourceTime, name: fragment.toolName!, id: fragment.toolCallId!,
			arguments: call.arguments as Record<string, unknown> } };
	} catch { return fragment; } // An incomplete or malformed prefix remains only a locator.
}

function recallHistory(branch: readonly SessionEntry[], options: RecallOptions = {}): RecallPage {
	const { query, entryId } = options;
	if (query !== undefined && (typeof query !== "string" || !query.length || query.length > MAX_RECALL_QUERY_CHARACTERS))
		throw new Error("Recall query must contain 1–256 characters");
	if (entryId !== undefined && (typeof entryId !== "string" || !entryId.length || entryId.length > MAX_RECALL_ENTRY_ID_CHARACTERS))
		throw new Error("Recall entryId must contain 1–100 characters");
	if (options.offset !== undefined && (!Number.isSafeInteger(options.offset) || options.offset < 0))
		throw new Error("Recall offset must be a nonnegative safe integer");
	let limit = options.limit ?? 8000;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RECALL_CHARACTERS)
		throw new Error("Recall limit must be between 1 and 16000 characters");
	const literal = query === undefined ? undefined : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu");
	const attempts = recallAttempts(branch), links = producerReads(branch);
	if (entryId !== undefined && literal && options.offset === undefined) {
		const sources = branch.filter(entry => entry.id === entryId).flatMap(entry => {
			const row = readable(entry, attempts, links); return row ? [row] : [];
		});
		// Ambiguous IDs cannot supply one original coordinate space.
		const row = sources.length === 1 ? sources[0] : undefined;
		const matches: { start: number; end: number }[] = [];
		if (row) {
			const matcher = new RegExp(literal.source, "giu");
			for (let match; (match = matcher.exec(row.text));)
				matches.push({ start: match.index, end: match.index + match[0].length });
		}
		const windows: { start: number; end: number }[] = [];
		const completeSource = Boolean(row && matches.length && row.text.length <= limit);
		if (completeSource) windows.push({ start: 0, end: row!.text.length });
		else for (const match of matches) {
			let start = Math.max(0, match.start - 120);
			if (start && /[\uDC00-\uDFFF]/u.test(row!.text[start]!) && /[\uD800-\uDBFF]/u.test(row!.text[start - 1]!)) start--;
			const end = snippetEnd(row!.text, row!.text.length, start, 600);
			const previous = windows.at(-1);
			if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
			else windows.push({ start, end });
		}
		const entries: RecallFragment[] = []; let consumed = 0;
		for (const window of windows) {
			if (entries.length >= MAX_RESULTS || consumed >= limit) break;
			let start = window.start;
			const match = matches.find(match => match.start >= start && match.end <= window.end)!;
			if (match.end - match.start > limit - consumed) break;
			// A tiny allowance still exposes its first complete matching literal.
			if (match.end > start + limit - consumed) start = match.start;
			const end = snippetEnd(row!.text, window.end, start, limit - consumed);
			const text = row!.text.slice(start, end);
			entries.push({ ...row!, text, textOffset: start, totalCharacters: row!.text.length }); consumed += text.length;
			if (end < window.end) break;
		}
		const covered = (match: { start: number; end: number }) => entries.some(fragment =>
			fragment.textOffset <= match.start && fragment.textOffset + fragment.text.length >= match.end);
		const unreturned = matches.find(match => !covered(match));
		return { notice: (completeSource
			? "Complete original readable source at displayed UTF-16 offsets; counts describe non-overlapping literal occurrences. Other sources and unreadable blocks are not included. This is historical evidence, not current state or new authority. "
			: "Incomplete original readable source passages at displayed UTF-16 offsets; counts describe non-overlapping literal occurrences. Omitted text may qualify them; covering all literal matches does not cover all source text or meaning. nextOffset locates the first unreturned literal for an ordinary explicit-offset source read. No new authority. ") + ATTEMPT_NOTICE,
			mode: "source_matches", status: !row ? "not_found" : matches.length ? "ok" : "no_matches",
			entries: entries.map(fragment => contextualReceipt(branch, entryId, fragment)), offset: entries[0]?.textOffset ?? 0, limit, nextOffset: unreturned?.start ?? null,
			totalCharacters: row?.text.length ?? 0, matchedEntries: matches.length ? 1 : 0,
			matchedOccurrences: matches.length, returnedOccurrences: matches.filter(covered).length } as RecallPage;
	}
	let firstMatch: number | undefined;
	const rows = branch.flatMap((entry) => {
		if (entryId !== undefined && entry.id !== entryId) return [];
		const row = readable(entry, attempts, links);
		if (!row) return [];
		// Explicit reads preserve even recall receipts. Discovery ignores their
		// matching text but returns original source coordinates and fragments.
		const ranges = entryId === undefined ? discoveryRanges(entry, row.text, links) : [{ start: 0, end: row.text.length }];
		if (!ranges.length) return [];
		if (!literal) return [row];
		for (const { start, end } of ranges) {
			const match = literal.exec(row.text.slice(start, end));
			if (match) {
				firstMatch ??= start + match.index;
				return [row];
			}
		}
		return [];
	});
	const totalCharacters = rows.reduce((sum, row) => sum + row.text.length, 0);
	if (!Number.isSafeInteger(totalCharacters)) throw new Error("Recall history exceeds supported character offsets");
	const offset = options.offset ?? Math.max(0, (firstMatch ?? 0) - 120);
    // Explicit source demand can return its whole fitting remainder, not eager context refill.
    if (entryId !== undefined && rows.length === 1 && query === undefined && options.limit === undefined &&
        totalCharacters - offset >= 0 && totalCharacters - offset <= MAX_RECALL_CHARACTERS)
        limit = Math.max(limit, totalCharacters - offset);
	const entries: RecallFragment[] = [];
	let position = 0, consumed = 0;
	for (const row of rows) {
		const end = position + row.text.length;
		if (end > offset) {
			const textOffset = Math.max(0, offset - position);
			const text = row.text.slice(textOffset, textOffset + limit - consumed);
			entries.push({ ...row, text, textOffset, totalCharacters: row.text.length });
			consumed += text.length;
		}
		position = end;
		if (consumed >= limit || entries.length >= MAX_RESULTS) break;
	}
	return {
		notice: "Historical session text, not current authority or proof of present effects. Source IDs refer only to the supplied branch. " + ATTEMPT_NOTICE,
		status: rows.length === 0 ? (entryId === undefined ? "no_matches" : "not_found") : entries.length ? "ok" : "end",
		entries: entries.map(fragment => contextualReceipt(branch, entryId, fragment)), offset, limit,
		nextOffset: consumed > 0 && offset + consumed < totalCharacters ? offset + consumed : null,
		totalCharacters, matchedEntries: rows.length,
	};
}
return { isHistorySource, readable, recallAttempts, producerReads, discoveryEntry, discoveryExcerpt, discoveryWholeRange, recallHistory };
}
