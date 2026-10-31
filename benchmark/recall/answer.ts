// Ask an agent the independent questions (PREREG-RECALL.md) in the state each compactor leaves after a cut. Same session set-up as replay/answer.ts: one
// real Pi session per (variant, cut, wording) over the replayed history and the compaction entry, with the compactor's real tools; one prompt with all of a
// cut's questions in ONE wording; the last message is a JSON object of answers.
//   jiti benchmark/recall/answer.ts RECORDING CUTS_FILE QUESTIONS.json OUT.jsonl --wording close|paraphrase --variant tuck|tuck-lexical|tuck-norecall|native-local
//        [--agent SPEC] [--tuck-dir DIR] [--agent-dir DIR] [--cuts 1,2] [--warm 0|1]
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createJiti } from "jiti";

const [recordingPath, cutsFile, probesPath, outPath, ...rest] = process.argv.slice(2);
const option = (name: string, fallback: string) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : fallback; };
const agentSpec = option("--agent", "openrouter/deepseek/deepseek-v4.1-flash-1017:high");
const tuckDir = resolve(option("--tuck-dir", join(import.meta.dirname, "..", "..")));
const agentDir = resolve(option("--agent-dir", join(import.meta.dirname, "..", "runs", "agent", "R")));
process.env.PI_CODING_AGENT_DIR = agentDir; // set before Pi or pi-tuck read it

const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
const { loadRecording, stateEntries, untilNotCapped } = await import("../replay/lib");
const jiti = createJiti(import.meta.url, { moduleCache: false });
const tuckIndex = await jiti.import(join(tuckDir, "index.ts")) as any;
const { memoizedEligibleSources } = await jiti.import(join(tuckDir, "src", "eligibility-cache.ts")) as any;

const rec = loadRecording(recordingPath);
const wording = option("--wording", "close");
const probes: any[] = JSON.parse(readFileSync(probesPath, "utf8")).map((q: any) => ({ id: q.id, cut: q.cut, task: q.task, question: q[wording] }));
const variant = option("--variant", "tuck");
const cutsOf = JSON.parse(readFileSync(cutsFile, "utf8"));
const wanted = option("--cuts", "all");
const warm = option("--warm", "1") === "1";
const cutNumbers: number[] = [...new Set<number>(probes.map(p => p.cut))].filter(k => wanted === "all" || wanted.split(",").map(Number).includes(k));

const [spec, thinking] = agentSpec.split(":");
const runtime = await ModelRuntime.create({ authPath: join(process.env.HOME!, ".pi/agent/auth.json"), modelsPath: join(agentDir, "models.json") });
const model = runtime.getModel(spec.slice(0, spec.indexOf("/")), spec.slice(spec.indexOf("/") + 1));
if (!model) throw new Error(`no model ${spec}`);
const WALL_MS = 15 * 60_000, INDEX_WAIT_MS = 10 * 60_000;

const promptFor = (set: any[]) => [
	"Before we continue, I need to check your memory of this session. Answer each question below about earlier work in this session. Use your tools if they help you find an answer. Do not modify any files.",
	"When you are done, reply with only a JSON object that maps each question id to a short answer string. Use \"unknown\" only when you cannot determine an answer.",
	"", ...set.map(p => `${p.id} (task ${p.task}): ${p.question}`),
].join("\n");

async function ask(cut: number, set: any[]) {
	const compactions = cutsOf.cuts.slice(0, cut);
	if (compactions.length < cut) return { skipped: `${variant} has no cut ${cut}` };
	const entries = stateEntries(rec, compactions, compactions[cut - 1].position);
	const work = mkdtempSync(join(tmpdir(), "tuck-replay-"));
	const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 40, baseDelayMs: 5000, maxAgentDelayMs: 60000 } } as any);
	const usesTuck = variant.startsWith("tuck");
	let handle: any;
	let activeTools: string[] | undefined;
	let index: Record<string, unknown> | undefined;
	const extensionFactories = usesTuck ? [(pi: any) => {
		const semanticRecall = tuckIndex.createSemanticRecall();
		return tuckIndex.installCompaction(pi, { semanticRecall }).then((h: any) => {
			handle = h;
			if (variant === "tuck-norecall") pi.on("session_start", async () => { pi.setActiveTools(pi.getActiveTools().filter((n: string) => n !== "tuck_recall" && n !== "tuck_search")); activeTools = pi.getActiveTools(); });
			if (variant === "tuck") pi.on("session_start", async (_e: any, ctx: any) => {
				await h.setSemanticEnabled(true, ctx);
				if (warm) await semanticRecall.search("tasks files tests errors", () => memoizedEligibleSources(ctx, undefined, () => {}), undefined, [], undefined).catch(() => {});
				if (warm) {
					// Wait for the index to be complete (PREREG-RECALL.md amendment): in a long session pi-tuck indexes in the background as history grows, so a
					// question is asked against a finished index; a cold start measures the indexer's speed on a shared machine instead.
					const t0 = Date.now();
					for (;;) {
						const s = h.semanticStatus?.()?.local;
						if (!s || s.indexingComplete || s.state === "unavailable" || Date.now() - t0 > INDEX_WAIT_MS) break;
						await new Promise(r => setTimeout(r, 1000));
					}
					index = { waitedMs: Date.now() - t0, ...(h.semanticStatus?.()?.local ? { state: h.semanticStatus().local.state, coveredUnits: h.semanticStatus().local.coveredUnits, totalUnits: h.semanticStatus().local.totalUnits } : {}) };
				}
			});
		});
	}] : [];
	const loader = new DefaultResourceLoader({ cwd: work, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: extensionFactories as any });
	await loader.reload();
	const { session } = await createAgentSession({ cwd: work, agentDir, modelRuntime: runtime, model, thinkingLevel: (thinking ?? "medium") as any, resourceLoader: loader, settingsManager: settings,
		sessionManager: SessionManager.inMemory(rec.cwd, undefined, [rec.header, ...entries] as any) });
	await session.bindExtensions?.({});
	const before = session.messages.length;
	const started = Date.now();
	const timer = setTimeout(() => session.abort(), WALL_MS);
	let error: string | undefined;
	try { await session.prompt(promptFor(set)); } catch (e) { error = (e as Error).message; }
	clearTimeout(timer);
	const added = session.messages.slice(before);
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };
	const tools: Record<string, number> = {};
	let toolResultChars = 0;
	for (const m of added as any[]) {
		if (m.role === "assistant") {
			usage.requests++;
			for (const k of ["input", "output", "cacheRead", "cacheWrite"] as const) usage[k] += m.usage?.[k] ?? 0;
			for (const b of m.content) if (b.type === "toolCall") tools[b.name] = (tools[b.name] ?? 0) + 1;
			if (m.stopReason === "error" || m.stopReason === "aborted") error ??= `${m.stopReason}: ${m.errorMessage ?? ""}`;
		} else if (m.role === "toolResult") toolResultChars += JSON.stringify(m.content).length;
	}
	const answer = session.getLastAssistantText() ?? "";
	const semantic = handle?.semanticStatus?.()?.local;
	session.dispose();
	await handle?.close?.().catch(() => {});
	return { answer, ms: Date.now() - started, usage, tools, toolResultChars, error, activeTools, index, semantic: semantic ? { state: semantic.state, coveredUnits: semantic.coveredUnits, totalUnits: semantic.totalUnits } : undefined, messages: added.length };
}

mkdirSync(join(outPath, ".."), { recursive: true });
for (const cut of cutNumbers) {
	const set = probes.filter(p => p.cut === cut);
	const capped = await untilNotCapped<any>(`${variant} cut ${cut} ${agentSpec}`, async () => {
		const value = await ask(cut, set).catch(e => ({ error: `crash: ${(e as Error).stack}` }));
		return { error: (value as any).error, value };
	});
	const result = capped.value ?? { error: capped.error };
	appendFileSync(outPath, JSON.stringify({ recording: recordingPath, variant, wording, cut, agent: agentSpec, probes: set.map(p => p.id), waitedMs: capped.waitedMs, ...result }) + "\n");
	console.error(`${variant} cut ${cut} ${agentSpec}: ${(result as any).error ?? `${Math.round(((result as any).ms ?? 0) / 1000)}s`} ${JSON.stringify((result as any).tools ?? {})}`);
}
process.exit(0);
