import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isDiscardedResponse } from "./protocol";
import { extractPath } from "./tuck/core/tool-args";
import type { TranscriptRecord } from "./tuck/core/transcript";
import { pathKey } from "./path-key";
import type { FileObservation } from "./content-observations";

/** Owner default; older distinct paths are counted, not listed. */
export const MAX_LEDGER_LINES = 60;
const LEDGER_TITLE = "Files";
export const LEDGER_HEADING = "Files touched by read, write and edit before this summary, newest first, with the last operation:";
const OPERATIONS = new Map<string, LedgerItem["operation"]>([["write", "wrote/edited"], ["edit", "wrote/edited"], ["read", "read"]]);

/** One distinct path and its last recorded operation. `sourceIndex` is the entry holding that call (the line's own index, so a native
 * omission of the call removes the line). `locatorIndex` is the entry an agent wants back: for a read, the one holding its result (what
 * the file showed; a live check, 2026-11-12: an agent asked for "#13" and got the call); for a write or edit, the call (what was written).
 * `resolvable` says tuck_recall {index} reads the locator, so only then is it shown. A read whose result is missing points at its call. */
export interface LedgerItem { path: string; operation: "wrote/edited" | "read"; sourceIndex?: number; locatorIndex?: number; resolvable: boolean; definitions?: FileObservation }

/** Paths exactly as recorded in read/write/edit tool-call arguments before the cut, newest last operation first. Nothing is inferred.
 * A call from a failed or aborted response, a write/edit whose result is an error, and a path with a line break are not listed. */
export function ledgerItems(entries: readonly SessionEntry[], indices: ReadonlyMap<string, number>, resolvable: (entry: SessionEntry) => boolean,
	failedCalls: ReadonlySet<string>, cwd?: string): LedgerItem[] {
	const results = new Map<string, SessionEntry>();
	for (const entry of entries) if (entry.type === "message" && entry.message.role === "toolResult") results.set(entry.message.toolCallId, entry);
	const last = new Map<string, { path: string; operation: LedgerItem["operation"]; entry: SessionEntry; target: SessionEntry }>();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		if (isDiscardedResponse(entry.message)) continue;
		for (const block of entry.message.content) {
			if (block.type !== "toolCall" || !block.arguments || typeof block.arguments !== "object") continue;
			const operation = OPERATIONS.get(block.name);
			const path = operation && extractPath(block.arguments as Record<string, unknown>);
			if (!operation || !path || /[\r\n]/u.test(path) || operation === "wrote/edited" && failedCalls.has(block.id)) continue;
			const key = pathKey(path, cwd);
			last.delete(key);
			last.set(key, { path, operation, entry, target: operation === "read" ? results.get(block.id) ?? entry : entry });
		}
	}
	// Only listed lines show a locator, so resolvability (which renders the entry) is checked for those alone.
	return [...last.values()].reverse().map(({ path, operation, entry, target }, rank) => {
		const sourceIndex = indices.get(entry.id), locatorIndex = indices.get(target.id);
		return { path, operation, ...(sourceIndex !== undefined ? { sourceIndex } : {}), ...(locatorIndex !== undefined ? { locatorIndex } : {}),
			resolvable: rank < MAX_LEDGER_LINES && sourceIndex !== undefined && locatorIndex !== undefined && resolvable(target) };
	});
}

/** The ledger: a heading, one record per listed path (at most `keep` and the line cap, newest first), then a count of the older ones.
 * Each line carries its own source index, so a later native omission of that entry removes that line only. */
export function ledgerRecords(items: readonly LedgerItem[], keep = items.length, observations: ReadonlySet<LedgerItem> = new Set()): TranscriptRecord[] {
	const listed = items.slice(0, Math.max(0, Math.min(keep, MAX_LEDGER_LINES)));
	const line = (text: string, sourceIndex?: number): TranscriptRecord => ({ kind: "section", title: LEDGER_TITLE, text, ...(sourceIndex !== undefined ? { sourceIndex } : {}) });
	return [line(LEDGER_HEADING),
		...listed.map(item => line(`- ${item.operation} ${item.path}` + (item.resolvable ? ` (tuck_recall {"index":${item.locatorIndex}})` : "") +
			(observations.has(item) && item.definitions ? ` (definitions as of #${item.definitions.sourceIndex}):\n${item.definitions.text}` : ""), item.sourceIndex)),
		...(items.length ? [] : [line("(none)")]),
		...(listed.length < items.length ? [line(`+${items.length - listed.length} older files: use tuck_recall`)] : [])];
}
