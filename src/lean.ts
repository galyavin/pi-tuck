import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { cutEpochs, promptTokens } from "./epochs";
import { rereadsAfterCuts } from "./thrash";

/** Holding cost of a context token per request, as a share of its fresh price: a cached re-send costs about a tenth. */
export const LEAN_HOLDING = 0.1;
/** Growth samples (consecutive replies with no cut between) needed before the growth rate counts. */
export const LEAN_MIN_SAMPLES = 4;

export interface LeanInputs { kept: number; growth: number; rereads: number; samples: number; cuts: number }
/** The quantities the lean line is built from, read from the branch's recorded usage only. `kept` (K): the prompt of the first reply after
 * the latest cut, what that cut left (system, summary, kept turns, carried files). `growth` (δ): the mean rise of the prompt between
 * consecutive replies with no cut between. `rereads` (R): the mean tokens per cut of unchanged files re-read soon after it (thrash.ts). */
export function leanInputs(branch: readonly SessionEntry[]): LeanInputs {
	// Epochs place each reply under the cut it was sent with (epochs.ts): growth is measured only inside an epoch, never across a cut.
	const { epoch, opens, compactions } = cutEpochs(branch);
	let kept = 0, previous: number | undefined, previousEpoch = -1, sum = 0, samples = 0;
	branch.forEach((entry, i) => {
		if (entry.type === "compaction" && epoch[i] !== previousEpoch && previousEpoch >= 0) { kept = 0; previous = undefined; }
		const prompt = promptTokens(entry);
		if (prompt === undefined) return;
		if (opens[i]) kept = prompt;
		else if (previous !== undefined && epoch[i] === previousEpoch) { sum += prompt - previous; samples++; }
		previous = prompt; previousEpoch = epoch[i];
	});
	const { cuts, tokens } = rereadsAfterCuts(branch);
	return { kept, growth: samples ? sum / samples : 0, rereads: cuts ? tokens / cuts : 0, samples, cuts: compactions };
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
