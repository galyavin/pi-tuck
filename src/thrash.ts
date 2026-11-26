import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isDiscardedResponse } from "./protocol";
import { pathKey } from "./path-key";
import { isTextOnly, textOf } from "./tuck/core/content";
import { extractPath } from "./tuck/core/tool-args";

/** A re-read counts when it is issued within this many replies after a cut. */
export const THRASH_WINDOW_REPLIES = 3;
/** Re-reads per cut at which a session is thrashing. */
export const THRASH_BAR = 0.5;

/**
 * Whether the branch is thrashing: its cuts drop files the agent then reads again. A re-read is a read with the same path, offset and
 * limit as an earlier read that came before a cut, whose result text is identical to that earlier read's (the file did not change), issued
 * within THRASH_WINDOW_REPLIES replies after the latest cut. The branch thrashes when re-reads per cut reach THRASH_BAR. With no cut, or no
 * such re-read, it never does. Deterministic: it reads only the recorded branch.
 */
export function thrashing(branch: readonly SessionEntry[]): boolean {
	let cuts = 0, replies = 0, rereads = 0;
	const pending = new Map<string, { key: string; cut: number; soon: boolean }>(), last = new Map<string, { cut: number; text: string }>();
	for (const entry of branch) {
		if (entry.type === "compaction") { cuts++; replies = 0; continue; }
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			if (isDiscardedResponse(message)) continue;
			replies++;
			for (const block of message.content) {
				if (block.type !== "toolCall" || block.name !== "read" || !block.arguments || typeof block.arguments !== "object") continue;
				const args = block.arguments as Record<string, unknown>, path = extractPath(args);
				if (!path) continue;
				pending.set(block.id, { key: JSON.stringify([pathKey(path), args.offset ?? null, args.limit ?? null]), cut: cuts, soon: cuts > 0 && replies <= THRASH_WINDOW_REPLIES });
			}
		} else if (message.role === "toolResult") {
			const read = pending.get(message.toolCallId);
			if (!read || message.isError || !isTextOnly(message.content)) continue;
			pending.delete(message.toolCallId);
			const text = textOf(message.content), earlier = last.get(read.key);
			if (read.soon && earlier && earlier.cut < read.cut && earlier.text === text) rereads++;
			last.set(read.key, { cut: read.cut, text });
		}
	}
	return cuts > 0 && rereads / cuts >= THRASH_BAR;
}
