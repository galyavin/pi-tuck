import type { SessionEntry, SessionHeader } from "@earendil-works/pi-coding-agent";
import { classifyBash } from "./bash-command";
import { pathKey } from "./path-key";
import { isTextOnly, textOf } from "./tuck/core/content";
import { extractPath } from "./tuck/core/tool-args";
import type { TranscriptRecord } from "./tuck/core/transcript";

/** Whole successful text reads, newest result first. Mutations invalidate earlier calls even when they fail or have no result. */
export function keptReadCandidates(entries: readonly (SessionEntry | SessionHeader)[], indices: ReadonlyMap<string, number>,
	resolvable: (entry: SessionEntry) => boolean): TranscriptRecord[] {
	const cwd = entries.find((entry): entry is SessionHeader => entry.type === "session")?.cwd;
	const reads = new Map<string, { path: string; key: string; order: number }>(), mutations = new Map<string, number>();
	let allMutated = -1;
	let order = 0;
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		for (const block of entry.message.content) {
			if (block.type !== "toolCall" || !["read", "write", "edit", "bash"].includes(block.name) ||
				!block.arguments || typeof block.arguments !== "object") continue;
			const args = block.arguments as Record<string, unknown>;
			order++;
			if (block.name === "bash") {
				if (!reads.size || typeof args.command !== "string") continue;
				const command = classifyBash(args.command, cwd), { words } = command;
				if (command.readOnly) continue;
				if (command.mutatesAll) { allMutated = order; continue; }
				const base = command.directory === undefined ? cwd : pathKey(command.directory, cwd);
				const names = [...words, ...args.command.split(/[\s'"`=;|&()<>{},]+/u)];
				for (const name of names) if (name) { mutations.set(pathKey(name), order); mutations.set(pathKey(name, base), order); }
				continue;
			}
			const path = extractPath(args);
			if (!path || /[\r\n]/u.test(path)) continue;
			const key = pathKey(path, cwd);
			if (block.name === "read") {
				if (!("offset" in args) && !("limit" in args)) reads.set(block.id, { path, key, order });
			} else mutations.set(key, order);
		}
	}
	const seen = new Set<string>(), records: TranscriptRecord[] = [];
	for (let at = entries.length - 1; at >= 0; at--) {
		const entry = entries[at]!;
		if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.isError || !isTextOnly(entry.message.content)) continue;
		const read = reads.get(entry.message.toolCallId), sourceIndex = indices.get(entry.id);
		if (!read || seen.has(read.key) || Math.max(allMutated, mutations.get(read.key) ?? -1, mutations.get(pathKey(read.path)) ?? -1) > read.order) continue;
		const text = textOf(entry.message.content);
		if (!text.length || sourceIndex === undefined || !resolvable(entry)) continue;
		seen.add(read.key);
		records.push({ kind: "section", title: "Kept-read", sourceIndex,
			text: `read ${read.path} (as recorded at #${sourceIndex}; no write or edit recorded since):\n${text}` });
	}
	return records;
}
