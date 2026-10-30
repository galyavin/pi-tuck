import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isLookupTool } from "./tuck/core/recall-operation";
import { extractPath } from "./tuck/core/tool-args";
import type { TranscriptRecord } from "./tuck/core/transcript";

/** The initiating prompt is quoted whole up to this many characters; the rest stays readable through tuck_recall. */
export const MAX_TASK_CONTRACT_CHARACTERS = 12000;
/** Owner default; older distinct paths are counted, not listed. */
export const MAX_LEDGER_LINES = 60;
const LEDGER_TITLE = "Files";
export const LEDGER_HEADING = "Files touched by read, write and edit before this summary, newest first, with the last operation:";
const OPERATIONS = new Map<string, LedgerItem["operation"]>([["write", "wrote/edited"], ["edit", "wrote/edited"], ["read", "read"]]);

/** Never ends inside a surrogate pair, so the head is an exact prefix of whole code points. */
export const head = (text: string, max: number): string => {
	if (text.length <= max) return text;
	return text.slice(0, /[\uD800-\uDBFF]/u.test(text[max - 1]!) ? max - 1 : max);
};

/** One distinct path and its last recorded operation. `sourceIndex` is the entry holding that call;
 * `resolvable` says tuck_recall {index} reads it, so only then is the index shown as a locator. */
export interface LedgerItem { path: string; operation: "wrote/edited" | "read"; sourceIndex?: number; resolvable: boolean }

/** Paths exactly as recorded in read/write/edit tool-call arguments before the cut, newest last operation first. Nothing is inferred.
 * A call from a failed or aborted response, a write/edit whose result is an error, and a path with a line break are not listed. */
export function ledgerItems(entries: readonly SessionEntry[], indices: ReadonlyMap<string, number>, resolvable: (entry: SessionEntry) => boolean,
	failedCalls: ReadonlySet<string>): LedgerItem[] {
	const last = new Map<string, { path: string; operation: LedgerItem["operation"]; entry: SessionEntry }>();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		if (entry.message.stopReason === "error" || entry.message.stopReason === "aborted") continue;
		for (const block of entry.message.content) {
			if (block.type !== "toolCall" || !block.arguments || typeof block.arguments !== "object") continue;
			const operation = OPERATIONS.get(block.name);
			const path = operation && extractPath(block.arguments as Record<string, unknown>);
			if (!operation || !path || /[\r\n]/u.test(path) || operation === "wrote/edited" && failedCalls.has(block.id)) continue;
			last.delete(path);
			last.set(path, { path, operation, entry });
		}
	}
	// Only listed lines show a locator, so resolvability (which renders the entry) is checked for those alone.
	return [...last.values()].reverse().map(({ path, operation, entry }, rank) => {
		const sourceIndex = indices.get(entry.id);
		return { path, operation, ...(sourceIndex !== undefined ? { sourceIndex } : {}),
			resolvable: rank < MAX_LEDGER_LINES && sourceIndex !== undefined && resolvable(entry) };
	});
}

/** The ledger: a heading, one record per listed path (at most `keep` and the line cap, newest first), then a count of the older ones.
 * Each line carries its own source index, so a later native omission of that entry removes that line only. */
export function ledgerRecords(items: readonly LedgerItem[], keep = items.length): TranscriptRecord[] {
	const listed = items.slice(0, Math.max(0, Math.min(keep, MAX_LEDGER_LINES)));
	const line = (text: string, sourceIndex?: number): TranscriptRecord => ({ kind: "section", title: LEDGER_TITLE, text, ...(sourceIndex !== undefined ? { sourceIndex } : {}) });
	return [line(LEDGER_HEADING),
		...listed.map(item => line(`- ${item.operation} ${item.path}` + (item.resolvable ? ` (tuck_recall {"index":${item.sourceIndex}})` : ""), item.sourceIndex)),
		...(items.length ? [] : [line("(none)")]),
		...(listed.length < items.length ? [line(`+${items.length - listed.length} older files: use tuck_recall`)] : [])];
}

/** Owner defaults: the newest calls are listed, each on one line of at most this many characters; older ones are counted. */
export const MAX_ACTION_LINES = 30;
export const MAX_ACTION_CHARACTERS = 200;
const ACTIONS_TITLE = "Actions";
export const ACTIONS_HEADING = "Tool calls other than read, write, edit and history lookups before this summary, newest first, without their output:";

/** One tool call other than a read, write, edit or history lookup: the file ledger and the dialogue cover those. `sourceIndex` is
 * the entry holding its result, shown as a locator only where tuck_recall {index} reads it. */
export interface ActionItem { text: string; failed: boolean; sourceIndex?: number; resolvable: boolean }

/** The calls exactly as recorded, newest first, with the command (or else the arguments) flattened to one line. A call from a failed or
 * aborted response is not listed; a call whose result is an error is marked. */
export function actionItems(entries: readonly SessionEntry[], indices: ReadonlyMap<string, number>, resolvable: (entry: SessionEntry) => boolean,
	failedCalls: ReadonlySet<string>): ActionItem[] {
	const results = new Map<string, SessionEntry>();
	for (const entry of entries) if (entry.type === "message" && entry.message.role === "toolResult") results.set(entry.message.toolCallId, entry);
	const calls: { text: string; failed: boolean; result?: SessionEntry }[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		if (entry.message.stopReason === "error" || entry.message.stopReason === "aborted") continue;
		for (const block of entry.message.content) {
			if (block.type !== "toolCall" || OPERATIONS.has(block.name) || isLookupTool(block.name)) continue;
			const args = block.arguments as Record<string, unknown> | undefined;
			const what = typeof args?.command === "string" ? args.command : JSON.stringify(args ?? {});
			const line = `${block.name}: ${what}`.replace(/\s+/gu, " ").trim();
			calls.push({ text: line.length > MAX_ACTION_CHARACTERS ? head(line, MAX_ACTION_CHARACTERS - 1) + "…" : line,
				failed: failedCalls.has(block.id), result: results.get(block.id) });
		}
	}
	return calls.reverse().map(({ text, failed, result }, rank) => {
		const sourceIndex = result && indices.get(result.id);
		return { text, failed, ...(sourceIndex !== undefined ? { sourceIndex } : {}),
			resolvable: rank < MAX_ACTION_LINES && sourceIndex !== undefined && resolvable(result!) };
	});
}

/** The action trail: a heading, one record per listed call (at most `keep` and the line cap), then a count of the older ones; nothing
 * when there were no such calls. Each line carries its own source index, as the file ledger's do. */
export function actionRecords(items: readonly ActionItem[], keep = items.length): TranscriptRecord[] {
	if (!items.length) return [];
	const listed = items.slice(0, Math.max(0, Math.min(keep, MAX_ACTION_LINES)));
	const line = (text: string, sourceIndex?: number): TranscriptRecord => ({ kind: "section", title: ACTIONS_TITLE, text, ...(sourceIndex !== undefined ? { sourceIndex } : {}) });
	return [line(ACTIONS_HEADING),
		...listed.map(item => line(`- ${item.text}` + (item.failed ? " (failed)" : "") +
			(item.resolvable ? ` (output: tuck_recall {"index":${item.sourceIndex}})` : ""), item.sourceIndex)),
		...(listed.length < items.length ? [line(`+${items.length - listed.length} older calls: use tuck_recall`)] : [])];
}
