// Simulate the cut sequence of each compactor on one recording, at the same raw positions, and write what each cut produced.
//   jiti benchmark/replay/cuts.ts RECORDING.jsonl OUT_DIR [--variants tuck,native-terra,native-local] [--tuck-dir DIR]
// Variants:
//   tuck, tuck-<label>  pi-tuck's draft (a labelled variant is another pi-tuck source folder, set with --tuck-dir for that run): tuckObservedDraft through the cut decision of the tool-loop path (budget.ts chooseCut)
//   native-terra     Pi's prepareCompaction + compact() (the summarize and update-the-previous-summary prompts), run on openai/gpt-6.1-terra xhigh (ChatGPT plan)
//   native-local     the same, on mac-studio/main: what the live arm A does
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { KEEP_RECENT, RESERVE, WINDOW, carried, loadRecording, scheduleFor, sessionOf, stateEntries, untilNotCapped, type Compaction } from "./lib";

const [recordingPath, outDir, ...rest] = process.argv.slice(2);
const option = (name: string, fallback: string) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : fallback; };
const variants = option("--variants", "tuck,native-terra,native-local").split(",");
if (variants.includes("native-frontier")) throw new Error("native-frontier (gpt-6-astra) was withdrawn by the project owner; use native-terra");
const tuckDir = resolve(option("--tuck-dir", join(import.meta.dirname, "..", "..")));
// The astra model was withdrawn by the project owner on 2026-10-31 (PREREG-TERRA.md): native-frontier is refused. native-terra is Pi's compaction prompts on GPT-6.1 Terra.
const terra = option("--terra", "openai/gpt-6.1-terra"), terraThinking = option("--terra-thinking", "xhigh");
const localModel = option("--local", "mac-studio/main"), localThinking = option("--local-thinking", "xhigh");
for (const spec of [terra, localModel]) if (/openrouter/i.test(spec)) throw new Error("OpenRouter is not used: mac-studio only: " + spec);

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { tuck, tuckObservedDraft } = await jiti.import(join(tuckDir, "src", "tuck.ts")) as any;
const { chooseCut, planningReserve, bandOf, measurableConversationTokens } = await jiti.import(join(tuckDir, "src", "budget.ts")) as any;
const piRoot = join(import.meta.dirname, "..", "..", "node_modules", "@earendil-works", "pi-coding-agent") + "/";
const { prepareCompaction, compact } = await import(pathToFileURL(join(piRoot, "dist/core/compaction/compaction.js")).href);

const rec = loadRecording(recordingPath);
const room = WINDOW - RESERVE, band = bandOf(room);
const positions = scheduleFor(rec, option);
mkdirSync(outDir, { recursive: true });

const runtime = variants.some(v => v.startsWith("native")) ? await ModelRuntime.create({ authPath: join(process.env.HOME!, ".pi/agent/auth.json"), modelsPath: join(process.env.HOME!, ".pi/agent/models.json") }) : undefined;
const retry = SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 40, baseDelayMs: 5000, maxAgentDelayMs: 60000 } } as any).getRetrySettings();
const settings = { enabled: true, reserveTokens: RESERVE, keepRecentTokens: Number(option("--keep-recent", String(KEEP_RECENT))) };

async function nativeCut(entries: any[], spec: string, thinking: string, previous: Compaction[]) {
	const [provider, id] = [spec.slice(0, spec.indexOf("/")), spec.slice(spec.indexOf("/") + 1)];
	const model = runtime!.getModel(provider, id);
	if (!model) throw new Error(`no model ${spec}`);
	const auth = await runtime!.getAuth(model, {});
	if (!auth) throw new Error(`no credentials for ${spec}`);
	const manager = sessionOf(rec, entries);
	const preparation = prepareCompaction(manager.getBranch(), settings);
	if (!preparation) return { refused: "prepareCompaction returned nothing" };
	const started = performance.now();
	const result = await compact(preparation, model, auth.auth.apiKey, auth.auth.headers, undefined, undefined, thinking, undefined, auth.env, retry);
	return { compaction: { summary: result.summary, firstKeptEntryId: result.firstKeptEntryId, tokensBefore: result.tokensBefore, details: result.details } as Omit<Compaction, "position">,
		ms: performance.now() - started, usage: result.usage, split: preparation.isSplitTurn };
}

function tuckCut(entries: any[]) {
	const manager = sessionOf(rec, entries);
	const ctx = { sessionManager: manager, cwd: rec.cwd, model: { provider: "mac-studio", id: "main", api: "openai-completions", contextWindow: WINDOW, maxTokens: RESERVE } };
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
				const attempt = await untilNotCapped<any>(`${variant} cut ${k + 1}`, async () => ({
					value: variant === "native-terra" ? await nativeCut(entries, terra, terraThinking, cuts) : await nativeCut(entries, localModel, localThinking, cuts) }));
				result = attempt.value ?? { refused: `error: ${attempt.error}` };
			}
		} catch (error) { result = { refused: `error: ${(error as Error).message}` }; }
		const row: any = { cut: k + 1, position, preCutTokens: preCut, ...("compaction" in result ? {} : { refused: result.refused }) };
		if (result.compaction) {
			const compaction: Compaction = { position, ...result.compaction };
			cuts.push(compaction);
			const after = sessionOf(rec, stateEntries(rec, cuts, position));
			const projection = after.buildSessionProjection().messages;
			const keptFrom = rec.entries.findIndex(e => e.id === compaction.firstKeptEntryId);
			Object.assign(row, { ms: result.ms, carriedTokens: carried(after), summaryChars: compaction.summary.length, firstKeptIndex: keptFrom,
				keptEntries: position - keptFrom, mode: result.mode, usage: result.usage, split: result.split, projectedMessages: projection.length });
			writeFileSync(join(outDir, `${variant}-cut${k + 1}.md`), compaction.summary);
		} else { console.error(`${variant} cut ${k + 1} refused: ${row.refused}`); log.push(row); break; } // later states would depend on it
		log.push(row);
		console.error(`${variant} cut ${k + 1} @${position}: ${row.refused ?? `${Math.round(row.ms)} ms, carried ${row.carriedTokens}, summary ${row.summaryChars} chars`}`);
	}
	writeFileSync(file, JSON.stringify({ recording: recordingPath, variant, tuckDir: variant.startsWith("tuck") ? tuckDir : undefined, window: WINDOW, reserve: RESERVE, systemTokens: rec.systemTokens,
		entries: rec.entries.length, rawTokens: rec.cum[rec.cum.length - 1], positions, cuts, log }, null, 1));
}
