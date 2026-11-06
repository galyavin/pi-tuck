// Ask the LongMemEval question in the state a compactor leaves at the end of the haystack (PREREG-LME.md): one real Pi session per (variant, question) over the
// replayed history, the compaction entries and, for the pi-tuck variants, the real tuck_recall and tuck_search tools; the answer is the last message. The same
// session set-up as recall/answer.ts.
//   jiti benchmark/lme/answer.ts RECORDINGS_DIR QUESTIONS.json CUTS_ROOT OUT.jsonl --variant tuck|tuck-lexical|tuck-norecall|native|full --qids ID,ID
//        [--agent SPEC] [--tuck-dir DIR] [--agent-dir DIR] [--warm 0|1]
//   CUTS_ROOT holds <question_id>/cuts-<tuck|native>.json (ignored for `full`). Questions already in OUT.jsonl are skipped.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createJiti } from "jiti";

const [recDir, questionsPath, cutsRoot, outPath, ...rest] = process.argv.slice(2);
const option = (name: string, fallback: string) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : fallback; };
const agentSpec = option("--agent", "openrouter/deepseek/deepseek-v4.1-flash-1017:high");
if (/openrouter/i.test(agentSpec)) throw new Error("OpenRouter is not used: mac-studio only: pass --agent mac-studio/main:xhigh");
const tuckDir = resolve(option("--tuck-dir", join(import.meta.dirname, "..", "..")));
const agentDir = resolve(option("--agent-dir", join(import.meta.dirname, "..", "runs", "agent", "L")));
process.env.PI_CODING_AGENT_DIR = agentDir; // set before Pi or pi-tuck read it

const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
const { loadRecording, stateEntries, untilNotCapped } = await import("../replay/lib");
const jiti = createJiti(import.meta.url, { moduleCache: false });
const variant = option("--variant", "tuck");
const usesTuck = variant.startsWith("tuck");
const tuckIndex = usesTuck ? await jiti.import(join(tuckDir, "index.ts")) as any : undefined;
const { memoizedEligibleSources } = usesTuck ? await jiti.import(join(tuckDir, "src", "eligibility-cache.ts")) as any : {} as any;

const questions = JSON.parse(readFileSync(questionsPath, "utf8"));
const qids = option("--qids", Object.keys(questions).join(",")).split(",");
const warm = option("--warm", "1") === "1";
const done = new Set<string>(existsSync(outPath) ? readFileSync(outPath, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)).filter((r: any) => !r.error).map((r: any) => r.question_id) : []);

const [spec, thinking] = agentSpec.split(":");
const runtime = await ModelRuntime.create({ authPath: join(process.env.HOME!, ".pi/agent/auth.json"), modelsPath: join(agentDir, "models.json") });
const model = runtime.getModel(spec.slice(0, spec.indexOf("/")), spec.slice(spec.indexOf("/") + 1));
if (!model) throw new Error(`no model ${spec}`);
const WALL_MS = 15 * 60_000, INDEX_WAIT_MS = 10 * 60_000;

const promptFor = (q: any) => [`Current date: ${q.question_date}.`,
	"Answer the question below from what we discussed in our earlier conversations in this session. Use your tools if they help you find it. If the conversations do not contain the information, say that it was not mentioned. Reply with only the answer, in a sentence or two.",
	"", `Question: ${q.question}`].join("\n");

/** Work folders this run made; removed after each question and, for a crash or abort, at exit. */
const workDirs: string[] = [];
process.on("exit", () => { for (const d of workDirs) rmSync(d, { recursive: true, force: true }); });

async function ask(qid: string) {
	const q = questions[qid];
	const rec = loadRecording(join(recDir, `${qid}.jsonl`));
	let entries = stateEntries(rec, [], rec.entries.length);
	if (variant !== "full") {
		const cutsOf = JSON.parse(readFileSync(join(cutsRoot, qid, `cuts-${variant === "native" ? "native" : "tuck"}.json`), "utf8"));
		if (cutsOf.log.some((r: any) => r.refused)) return { skipped: `refused cut: ${cutsOf.log.find((r: any) => r.refused).refused}` };
		entries = stateEntries(rec, cutsOf.cuts, rec.entries.length);
	}
	const work = mkdtempSync(join(tmpdir(), "tuck-lme-"));
	workDirs.push(work);
	const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 40, baseDelayMs: 5000, maxAgentDelayMs: 60000 } } as any);
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
				if (warm) await semanticRecall.search("conversation", () => memoizedEligibleSources(ctx, undefined, () => {}), undefined, [], undefined).catch(() => {});
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
	try { await session.prompt(promptFor(q)); } catch (e) { error = (e as Error).message; }
	clearTimeout(timer);
	const added = session.messages.slice(before);
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };
	const tools: Record<string, number> = {};
	const responseIds: string[] = [];
	let toolResultChars = 0;
	for (const m of added as any[]) {
		if (m.role === "assistant") {
			usage.requests++;
			if (m.responseId) responseIds.push(m.responseId);
			for (const k of ["input", "output", "cacheRead", "cacheWrite"] as const) usage[k] += m.usage?.[k] ?? 0;
			for (const b of m.content) if (b.type === "toolCall") tools[b.name] = (tools[b.name] ?? 0) + 1;
			if (m.stopReason === "error" || m.stopReason === "aborted") error ??= `${m.stopReason}: ${m.errorMessage ?? ""}`;
		} else if (m.role === "toolResult") toolResultChars += JSON.stringify(m.content).length;
	}
	const answer = session.getLastAssistantText() ?? "";
	const semantic = handle?.semanticStatus?.()?.local;
	session.dispose();
	rmSync(work, { recursive: true, force: true });
	await handle?.close?.().catch(() => {});
	return { answer, ms: Date.now() - started, usage, tools, toolResultChars, responseIds, error, activeTools, index, semantic: semantic ? { state: semantic.state, coveredUnits: semantic.coveredUnits, totalUnits: semantic.totalUnits } : undefined };
}

mkdirSync(join(outPath, ".."), { recursive: true });
for (const qid of qids) {
	if (done.has(qid)) continue;
	const capped = await untilNotCapped<any>(`${variant} ${qid}`, async () => {
		const value = await ask(qid).catch(e => ({ error: `crash: ${(e as Error).stack}` }));
		return { error: (value as any).error, value };
	});
	const result = capped.value ?? { error: capped.error };
	appendFileSync(outPath, JSON.stringify({ question_id: qid, variant, agent: agentSpec, waitedMs: capped.waitedMs, ...result }) + "\n");
	console.error(`${variant} ${qid}: ${(result as any).error ?? (result as any).skipped ?? `${Math.round(((result as any).ms ?? 0) / 1000)}s`} ${JSON.stringify((result as any).tools ?? {})}`);
}
process.exit(0);
