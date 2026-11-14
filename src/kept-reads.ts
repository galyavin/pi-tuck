import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isTextOnly, textOf } from "./tuck/core/content";
import { extractPath } from "./tuck/core/tool-args";
import type { TranscriptRecord } from "./tuck/core/transcript";

/** Whole successful text reads, newest result first. Mutations invalidate earlier calls even when they fail or have no result. */
export function keptReadCandidates(entries: readonly SessionEntry[], indices: ReadonlyMap<string, number>,
	resolvable: (entry: SessionEntry) => boolean): TranscriptRecord[] {
	const reads = new Map<string, { path: string; order: number }>(), mutations = new Map<string, number>();
	let order = 0;
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		for (const block of entry.message.content) {
			if (block.type !== "toolCall" || !["read", "write", "edit"].includes(block.name) ||
				!block.arguments || typeof block.arguments !== "object") continue;
			const path = extractPath(block.arguments as Record<string, unknown>);
			if (!path || /[\r\n]/u.test(path)) continue;
			order++;
			if (block.name === "read") reads.set(block.id, { path, order });
			else mutations.set(path, order);
		}
	}
	const seen = new Set<string>(), records: TranscriptRecord[] = [];
	for (let at = entries.length - 1; at >= 0; at--) {
		const entry = entries[at]!;
		if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.isError || !isTextOnly(entry.message.content)) continue;
		const read = reads.get(entry.message.toolCallId), sourceIndex = indices.get(entry.id);
		if (!read || seen.has(read.path) || (mutations.get(read.path) ?? -1) > read.order) continue;
		const text = textOf(entry.message.content);
		if (!text.length || sourceIndex === undefined || !resolvable(entry)) continue;
		seen.add(read.path);
		records.push({ kind: "section", title: "Kept-read", sourceIndex,
			text: `read ${read.path} (as recorded at #${sourceIndex}; no write or edit recorded since):\n${text}` });
	}
	return records;
}
