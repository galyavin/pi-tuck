// The cut sequence of each compactor on one LongMemEval haystack (PREREG-LME.md), at the same raw positions for every compactor, and what each cut produced.
//   jiti benchmark/lme/cuts.ts RECORDING.jsonl OUT_DIR --window 32768 --reserve 16384 --keep-recent 3333 --variants tuck|native [--tuck-dir DIR]
// Same machinery as replay/cuts.ts (pi-tuck's draft through the cut decision; Pi's prepareCompaction + compact()); the differences are the window, a chat
// boundary (an assistant message followed by a user message) in place of a tool-loop boundary, and DeepSeek (agent dir R) as the native summary writer.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { carried, loadRecording, sessionOf, stateEntries, untilNotCapped, type Compaction, type Recording } from "../replay/lib";

const [recordingPath, outDir, ...rest] = process.argv.slice(2);
const option = (name: string, fallback: string) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : fallback; };
const WINDOW = Number(option("--window", "32768")), RESERVE = Number(option("--reserve", "16384"));
const variants = option("--variants", "tuck").split(",");
const tuckDir = resolve(option("--tuck-dir", join(import.meta.dirname, "..", "..")));
const agentDir = resolve(option("--agent-dir", join(import.meta.dirname, "..", "runs", "agent", "R")));
const nativeSpec = option("--native", "openrouter/deepseek/deepseek-v4.1-flash-1017"), nativeThinking = option("--native-thinking", "high");
if (variants.some(v => v.startsWith("native"))) throw new Error("OpenRouter is not used: mac-studio only: lme/cuts.ts native variants are wired to OpenRouter");

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { tuck, tuckObservedDraft } = await jiti.import(join(tuckDir, "src", "tuck.ts")) as any;
const { chooseCut, planningReserve, bandOf, measurableConversationTokens } = await jiti.import(join(tuckDir, "src", "budget.ts")) as any;
const piRoot = join(import.meta.dirname, "..", "..", "node_modules", "@earendil-works", "pi-coding-agent") + "/";
const { prepareCompaction, compact } = await import(pathToFileURL(join(piRoot, "dist/core/compaction/compaction.js")).href);

const rec: Recording = loadRecording(recordingPath);
const room = WINDOW - RESERVE, band = bandOf(room);
const DELTA = Number(option("--delta", String(Math.floor(room / 2))));

/** A chat boundary: an assistant message ends before it and a user message follows. */
const chatBoundary = (i: number) => {
	const before = rec.entries[i - 1], after = rec.entries[i];
	return Boolean(before && after && before.type === "message" && before.message.role === "assistant" && after.type === "message" && after.message.role === "user");
};
const positions: number[] = [];
for (let i = 1, target = band - rec.systemTokens; i < rec.entries.length; i++) if (rec.cum[i] >= target && chatBoundary(i)) { positions.push(i); target = rec.cum[i] + DELTA; }
mkdirSync(outDir, { recursive: true });

const runtime = variants.some(v => v.startsWith("native")) ? await ModelRuntime.create({ authPath: join(process.env.HOME!, ".pi/agent/auth.json"), modelsPath: join(agentDir, "models.json") }) : undefined;
const retry = SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 40, baseDelayMs: 5000, maxAgentDelayMs: 60000 } } as any).getRetrySettings();
const settings = { enabled: true, reserveTokens: RESERVE, keepRecentTokens: Number(option("--keep-recent", "3333")) };

async function nativeCut(entries: any[]) {
	const model = runtime!.getModel(nativeSpec.slice(0, nativeSpec.indexOf("/")), nativeSpec.slice(nativeSpec.indexOf("/") + 1));
	if (!model) throw new Error(`no model ${nativeSpec}`);
	const auth = await runtime!.getAuth(model, {});
	if (!auth) throw new Error(`no credentials for ${nativeSpec}`);
	const preparation = prepareCompaction(sessionOf(rec, entries).getBranch(), settings);
	if (!preparation) return { refused: "prepareCompaction returned nothing" };
	const started = performance.now();
	const result = await compact(preparation, model, auth.auth.apiKey, auth.auth.headers, undefined, undefined, nativeThinking, undefined, auth.env, retry);
	return { compaction: { summary: result.summary, firstKeptEntryId: result.firstKeptEntryId, tokensBefore: result.tokensBefore, details: result.details } as Omit<Compaction, "position">,
		ms: performance.now() - started, usage: result.usage, split: preparation.isSplitTurn };
}

function tuckCut(entries: any[]) {
	const manager = sessionOf(rec, entries);
	const ctx = { sessionManager: manager, cwd: rec.cwd, model: { provider: "openrouter", id: "deepseek/deepseek-v4.1-flash-1017", api: "openai-completions", contextWindow: WINDOW, maxTokens: RESERVE } };
	const measure = (messages: any[]) => measurableConversationTokens(messages, ctx, undefined);
	const saved = manager.buildSessionProjection().messages;
	const before = measure(saved), mandatory = rec.systemTokens;
	const previousSummary = (saved.find((m: any) => m.role === "compactionSummary") as any)?.summary;
	const started = performance.now();
	const decision = chooseCut({
		before, mandatory, room, band, fits: (tokens: number, limit: number) => tokens < limit, opportunistic: false, unreduced: "draft did not reduce the request",
		plan: (target: string) => {
			const reserve = planningReserve(WINDOW, target === "band" ? band : room, 1, mandatory);
			const draft = tuckObservedDraft(tuck, { branchEntries: manager.getBranch(), tokensBefore: before, previousSummary }, ctx, reserve, measure, undefined, true);
			return draft.compaction ? { draft: true, after: draft.after, mode: draft.mode, compaction: draft.compaction, reserve }
				: { draft: false, capacityRejected: Boolean(draft.capacityRejected), reason: draft.unavailable };
		},
	});
	const ms = performance.now() - started;
	if (decision.kind !== "cut") return { refused: decision.kind === "fault" ? decision.message : decision.kind };
	const c = decision.plan.compaction;
	return { compaction: { summary: c.summary, firstKeptEntryId: c.firstKeptEntryId, tokensBefore: c.tokensBefore, details: c.details } as Omit<Compaction, "position">,
		ms, mode: decision.plan.mode, target: decision.target };
}

for (const variant of variants) {
	const file = join(outDir, `cuts-${variant}.json`);
	if (existsSync(file)) continue; // a finished variant is kept; delete its file to redo it
	const cuts: Compaction[] = [], log: any[] = [];
	for (const [k, position] of positions.entries()) {
		const entries = stateEntries(rec, cuts, position);
		const preCut = carried(sessionOf(rec, entries));
		let result: any;
		try {
			if (variant.startsWith("tuck")) result = tuckCut(entries);
			else {
				const attempt = await untilNotCapped<any>(`${variant} cut ${k + 1}`, async () => ({ value: await nativeCut(entries) }));
				result = attempt.value ?? { refused: `error: ${attempt.error}` };
			}
		} catch (error) { result = { refused: `error: ${(error as Error).message}` }; }
		const row: any = { cut: k + 1, position, preCutTokens: preCut, ...("compaction" in result ? {} : { refused: result.refused }) };
		if (result.compaction) {
			const compaction: Compaction = { position, ...result.compaction };
			cuts.push(compaction);
			const after = sessionOf(rec, stateEntries(rec, cuts, position));
			const keptFrom = rec.entries.findIndex(e => e.id === compaction.firstKeptEntryId);
			Object.assign(row, { ms: result.ms, carriedTokens: carried(after), summaryChars: compaction.summary.length, firstKeptIndex: keptFrom, keptEntries: position - keptFrom, mode: result.mode, usage: result.usage, split: result.split });
		} else { console.error(`${variant} cut ${k + 1} refused: ${row.refused}`); log.push(row); break; } // later states would depend on it
		log.push(row);
	}
	writeFileSync(file, JSON.stringify({ recording: recordingPath, variant, tuckDir: variant.startsWith("tuck") ? tuckDir : undefined, window: WINDOW, reserve: RESERVE, room, band, delta: DELTA, systemTokens: rec.systemTokens,
		entries: rec.entries.length, rawTokens: rec.cum[rec.cum.length - 1], positions, cuts, log }, null, 1));
	console.error(`${variant}: ${cuts.length} of ${positions.length} cuts${log.some(r => r.refused) ? ", REFUSED" : ""}`);
}
process.exit(0);
