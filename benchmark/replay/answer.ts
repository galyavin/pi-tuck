// Ask an agent the probes in the state each compactor leaves after a cut. One agent session per (variant, cut): a real Pi session over the
// replayed history, the compaction entry, and for the pi-tuck variants the real tuck_recall and tuck_search tools. The probes go in one
// prompt; the agent may use its tools; its last message is a JSON object of answers.
//   jiti benchmark/replay/answer.ts RECORDING CUTS_DIR PROBES.json OUT.jsonl --agent mac-studio/main:xhigh --variant tuck|tuck-lexical|tuck-norecall|native-frontier|native-local
//        [--cuts 1,2] [--tuck-dir DIR] [--warm 0|1]
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createJiti } from "jiti";

const [recordingPath, cutsDir, probesPath, outPath, ...rest] = process.argv.slice(2);
const option = (name: string, fallback: string) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : fallback; };
const agentSpec = option("--agent", "mac-studio/main:xhigh");
if (/openrouter/i.test(agentSpec)) throw new Error("OpenRouter is not used: mac-studio only: " + agentSpec);
const tuckDir = resolve(option("--tuck-dir", join(import.meta.dirname, "..", "..")));
const agentDir = resolve(option("--agent-dir", join(import.meta.dirname, "..", "runs", "agent", "B")));
process.env.PI_CODING_AGENT_DIR = agentDir; // set before Pi or pi-tuck read it

const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
const { loadRecording, stateEntries, untilNotCapped, messageStats } = await import("./lib");
const jiti = createJiti(import.meta.url, { moduleCache: false });
const tuckIndex = await jiti.import(join(tuckDir, "index.ts")) as any;
const { memoizedEligibleSources } = await jiti.import(join(tuckDir, "src", "eligibility-cache.ts")) as any;

const rec = loadRecording(recordingPath);
const probes: any[] = JSON.parse(readFileSync(probesPath, "utf8"));
const variant = option("--variant", "tuck");
const cutsOf = JSON.parse(readFileSync(join(cutsDir, `cuts-${variant === "tuck-lexical" || variant === "tuck-norecall" ? "tuck" : variant}.json`), "utf8"));
const wanted = option("--cuts", "all");
const warm = option("--warm", "1") === "1";
const cutNumbers: number[] = [...new Set<number>(probes.map(p => p.cut))].filter(k => wanted === "all" || wanted.split(",").map(Number).includes(k));

const [spec, thinking] = agentSpec.split(":");
const runtime = await ModelRuntime.create({ authPath: join(process.env.HOME!, ".pi/agent/auth.json"), modelsPath: join(agentDir, "models.json") });
const model = runtime.getModel(spec.slice(0, spec.indexOf("/")), spec.slice(spec.indexOf("/") + 1));
if (!model) throw new Error(`no model ${spec}`);
const WALL_MS = 15 * 60_000;

const promptFor = (set: any[]) => [
	"Before we continue, I need to check your memory of this session. Answer each question below about earlier work in this session. Use your tools if they help you find an answer. Do not modify any files.",
	"When you are done, reply with only a JSON object that maps each question id to a short answer string. Use \"unknown\" only when you cannot determine an answer.",
	"", ...set.map(p => `${p.id}: ${p.question}`),
].join("\n");

/** Work folders this run made; removed after each question and, for a crash or abort, at exit. */
const workDirs: string[] = [];
process.on("exit", () => { for (const d of workDirs) rmSync(d, { recursive: true, force: true }); });

async function ask(cut: number, set: any[]) {
	const compactions = cutsOf.cuts.slice(0, cut);
	if (compactions.length < cut) return { skipped: `${variant} has no cut ${cut}` };
	const entries = stateEntries(rec, compactions, compactions[cut - 1].position);
	const work = mkdtempSync(join(tmpdir(), "tuck-replay-"));
	workDirs.push(work);
	const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 40, baseDelayMs: 5000, maxAgentDelayMs: 60000 } } as any);
	const usesTuck = variant.startsWith("tuck");
	let handle: any;
	let activeTools: string[] | undefined;
	const extensionFactories = usesTuck ? [(pi: any) => {
		const semanticRecall = tuckIndex.createSemanticRecall();
		return tuckIndex.installCompaction(pi, { semanticRecall }).then((h: any) => {
			handle = h;
			// tuck-norecall (PREREG-SUMMARYONLY.md): the same summary, with tuck_recall and tuck_search not offered at all
			if (variant === "tuck-norecall") pi.on("session_start", async () => { pi.setActiveTools(pi.getActiveTools().filter((n: string) => n !== "tuck_recall" && n !== "tuck_search")); activeTools = pi.getActiveTools(); });
			if (variant === "tuck") pi.on("session_start", async (_e: any, ctx: any) => {
				await h.setSemanticEnabled(true, ctx);
				if (warm) await semanticRecall.search("tasks files tests errors", () => memoizedEligibleSources(ctx, undefined, () => {}), undefined, [], undefined).catch(() => {});
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
	let promptError: string | undefined;
	try { await session.prompt(promptFor(set)); } catch (e) { promptError = (e as Error).message; }
	clearTimeout(timer);
	const added = session.messages.slice(before);
	const { usage, tools, toolResultChars, error } = messageStats(added, promptError);
	const answer = session.getLastAssistantText() ?? "";
	const semantic = handle?.semanticStatus?.()?.local;
	session.dispose();
	rmSync(work, { recursive: true, force: true });
	await handle?.close?.().catch(() => {});
	return { answer, ms: Date.now() - started, usage, tools, toolResultChars, error, activeTools, semantic: semantic ? { state: semantic.state, coveredUnits: semantic.coveredUnits, totalUnits: semantic.totalUnits } : undefined, messages: added.length };
}

mkdirSync(join(outPath, ".."), { recursive: true });
for (const cut of cutNumbers) {
	const set = probes.filter(p => p.cut === cut);
	const capped = await untilNotCapped<any>(`${variant} cut ${cut} ${agentSpec}`, async () => {
		const value = await ask(cut, set).catch(e => ({ error: `crash: ${(e as Error).stack}` }));
		return { error: (value as any).error, value };
	});
	const result = capped.value ?? { error: capped.error };
	appendFileSync(outPath, JSON.stringify({ recording: recordingPath, variant, cut, agent: agentSpec, probes: set.map(p => p.id), waitedMs: capped.waitedMs, ...result }) + "\n");
	console.error(`${variant} cut ${cut} ${agentSpec}: ${(result as any).error ?? `${Math.round(((result as any).ms ?? 0) / 1000)}s`} ${JSON.stringify((result as any).tools ?? {})}`);
}
process.exit(0);
