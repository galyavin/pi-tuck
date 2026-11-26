import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isDiscardedResponse } from "./protocol";
import { rereadsAfterCuts } from "./thrash";

/** Holding cost of a context token per request, as a share of its fresh price: a cached re-send costs about a tenth. */
export const LEAN_HOLDING = 0.1;
/** Growth samples (consecutive replies with no cut between) needed before the growth rate counts. */
export const LEAN_MIN_SAMPLES = 4;

const promptTokens = (entry: SessionEntry): number | undefined => {
	if (entry.type !== "message" || entry.message.role !== "assistant" || isDiscardedResponse(entry.message)) return undefined;
	const message = entry.message;
	if (message.stopReason === "error" || message.stopReason === "aborted") return undefined;
	const u = message.usage;
	const total = (u?.input ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0);
	return Number.isFinite(total) && total > 0 ? total : undefined;
};

export interface LeanInputs { kept: number; growth: number; rereads: number; samples: number; cuts: number }
/** The quantities the lean line is built from, read from the branch's recorded usage only. `kept` (K): the prompt of the first reply after
 * the latest cut, what that cut left (system, summary, kept turns, carried files). `growth` (δ): the mean rise of the prompt between
 * consecutive replies with no cut between. `rereads` (R): the mean tokens per cut of unchanged files re-read soon after it (thrash.ts). */
export function leanInputs(branch: readonly SessionEntry[]): LeanInputs {
	let kept = 0, previous: number | undefined, afterCut = false, sum = 0, samples = 0;
	for (const entry of branch) {
		if (entry.type === "compaction") { previous = undefined; afterCut = true; continue; }
		const prompt = promptTokens(entry);
		if (prompt === undefined) continue;
		if (afterCut) { kept = prompt; afterCut = false; }
		if (previous !== undefined) { sum += prompt - previous; samples++; }
		previous = prompt;
	}
	const { cuts, tokens } = rereadsAfterCuts(branch);
	return { kept, growth: samples ? sum / samples : 0, rereads: cuts ? tokens / cuts : 0, samples, cuts };
}

/**
 * The lean cut line: the economic order quantity of a context. Each cut costs a fresh re-send of what it keeps (K) and the re-reads it causes
 * (R); each token held costs LEAN_HOLDING per request; the context grows by δ per request. The cheapest cycle cuts every
 * n* = sqrt(2(K + R) / (h·δ)) requests, so the line is K + δ·n* = K + sqrt(2(K + R)·δ / h). Rising re-reads raise R and so the line.
 * Undefined until the branch has a cut with a measured reply after it and LEAN_MIN_SAMPLES growth samples with a positive mean.
 */
export function leanLine(branch: readonly SessionEntry[]): number | undefined {
	const { kept, growth, rereads, samples, cuts } = leanInputs(branch);
	if (!cuts || kept <= 0 || samples < LEAN_MIN_SAMPLES || !(growth > 0)) return undefined;
	return Math.ceil(kept + Math.sqrt(2 * (kept + rereads) * growth / LEAN_HOLDING));
}
