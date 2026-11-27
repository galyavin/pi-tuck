import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isDiscardedResponse } from "./protocol";

/** A reply whose prompt is at least this share below the previous reply's prompt was sent with a new cut. */
export const EPOCH_DROP = 0.05;

/** The prompt a reply was sent with (input + cache read + cache write), or undefined for replies with no usable usage. */
export const promptTokens = (entry: SessionEntry): number | undefined => {
	if (entry.type !== "message" || entry.message.role !== "assistant" || isDiscardedResponse(entry.message)) return undefined;
	const message = entry.message;
	if (message.stopReason === "error" || message.stopReason === "aborted") return undefined;
	const u = message.usage;
	const total = (u?.input ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0);
	return Number.isFinite(total) && total > 0 ? total : undefined;
};

export interface CutEpochs {
	/** The cut epoch in effect at each branch entry: replies carry the epoch of the context they were sent with. 0 before any cut. */
	epoch: number[];
	/** True at the first reply with usable usage in each epoch after the first: its prompt is what that cut left. */
	opens: boolean[];
	/** Epoch steps, one per cut. */
	cuts: number;
	/** Compaction entries on the branch. */
	compactions: number;
}

/**
 * Places each reply under the cut it was sent with. A cut planned at prompt time or by the request guard is carried by requests at once,
 * but its compaction entry is saved only at the next boundary, after the reply that carried it. So a cut shows in the log either as a
 * compaction entry before the first reply that carries it, or as a prompt drop (EPOCH_DROP) at that reply with the entry after it. A
 * compaction entry steps the epoch only when no drop has stepped it since the previous compaction entry, so one cut is one step.
 */
export function cutEpochs(branch: readonly SessionEntry[]): CutEpochs {
	const epoch: number[] = [], opens: boolean[] = [];
	let current = 0, compactions = 0, previous: number | undefined, dropped = false, open = false;
	for (const entry of branch) {
		if (entry.type === "compaction") {
			compactions++;
			if (dropped) dropped = false;
			else { current++; previous = undefined; open = true; }
			epoch.push(current); opens.push(false);
			continue;
		}
		const prompt = promptTokens(entry);
		if (prompt !== undefined && previous !== undefined && prompt < previous * (1 - EPOCH_DROP)) { current++; dropped = true; open = true; }
		epoch.push(current);
		opens.push(prompt !== undefined && open && current > 0);
		if (prompt !== undefined) { previous = prompt; open = false; }
	}
	return { epoch, opens, cuts: current, compactions };
}
