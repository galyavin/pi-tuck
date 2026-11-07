// Score probe answers. Mechanical probes are scored by comparison with the truth computed from the recording; "next_step" is scored by an
// LLM judge that sees the agent's actual next action and the candidate answer, not which compactor produced it.
//   jiti benchmark/replay/score.ts PROBES.json ANSWERS.jsonl OUT.jsonl [--judge mac-studio/main:xhigh]
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseAnswers } from "./lib";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const [probesPath, answersPath, outPath, ...rest] = process.argv.slice(2);
const option = (name: string, fallback: string) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : fallback; };
const judgeSpec = option("--judge", "mac-studio/main:xhigh");
if (/openrouter/i.test(judgeSpec)) throw new Error("OpenRouter is not used: mac-studio only: " + judgeSpec);
const probes = new Map<string, any>();
for (const p of JSON.parse(readFileSync(probesPath, "utf8"))) probes.set(String(p.id), p);


const norm = (path: string) => path.trim().replace(/^[`'"]+|[`'"]+$/g, "").replace(/^\.\//, "").replace(/^.*\/testbed\//, "").replace(/\/+$/, "");
function parseList(answer: string): string[] {
	try { const v = JSON.parse(answer); if (Array.isArray(v)) return v.map(x => norm(String(x))); } catch { /* not JSON */ }
	return answer.split(/[\n,]+/).map(norm).filter(Boolean);
}

function mechanical(p: any, answer: string): { correct: number; detail?: any } {
	const a = answer.trim();
	switch (p.type) {
		case "files_changed": {
			const got = new Set(parseList(a)), truth = new Set<string>(p.truth);
			const hit = [...got].filter(x => truth.has(x)).length;
			const precision = got.size ? hit / got.size : 0, recall = truth.size ? hit / truth.size : 0;
			return { correct: got.size === truth.size && hit === truth.size ? 1 : 0, detail: { f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0 } };
		}
		case "test_result": {
			const lower = a.toLowerCase();
			const status = /\b(fail|failed|failure|failures)\b/.test(lower) ? "fail" : /\b(pass|passed|ok)\b/.test(lower) ? "pass" : undefined;
			const numbers = [...lower.matchAll(/\d+/g)].map(m => Number(m[0]));
			return { correct: status === p.truth.status && numbers.includes(p.truth.count) ? 1 : 0 };
		}
		case "tag": return { correct: a.toLowerCase().includes(p.truth) ? 1 : 0 };
		case "result_prefix": return { correct: a.includes("RESULT:") ? 1 : 0 };
		case "error_hit": return { correct: new RegExp(`\\b${p.truth}\\b`).test(a) ? 1 : 0 };
		default: return { correct: 0 };
	}
}

const [judgeProvider, judgeRest] = [judgeSpec.slice(0, judgeSpec.indexOf("/")), judgeSpec.slice(judgeSpec.indexOf("/") + 1)];
const [judgeId, judgeThinking] = judgeRest.split(":");
const runtime = await ModelRuntime.create({ authPath: join(process.env.HOME!, ".pi/agent/auth.json"), modelsPath: join(process.env.HOME!, ".pi/agent/models.json") });
const judgeModel = runtime.getModel(judgeProvider, judgeId);
async function judge(p: any, answer: string) {
	if (!judgeModel) throw new Error(`no judge model ${judgeSpec}`);
	const text = `An AI coding agent was in the middle of a task when its context was compacted. Afterwards it was asked what it was about to do next. Decide whether its answer matches what it actually did next.

<actual_next_action>
${p.truth}
</actual_next_action>

<agent_answer>
${answer || "(no answer)"}
</agent_answer>

Score 1 if the answer names the same kind of action on the same target with the same purpose (wording and detail may differ; a command that differs only in incidental flags counts). Score 0 if it names a different action or target, is vague, or says it does not know. Reply with only JSON: {"score": 0 or 1, "reason": "<one sentence>"}`;
	const response = await runtime.completeSimple(judgeModel, { messages: [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }] },
		{ reasoning: judgeThinking as any } as any);
	const out = response.content.map((b: any) => b.type === "text" ? b.text : "").join("");
	const m = /\{[\s\S]*\}/.exec(out);
	const parsed = m ? JSON.parse(m[0]) : { score: 0, reason: `unparseable judge output: ${out.slice(0, 200)}` };
	return { correct: parsed.score === 1 ? 1 : 0, detail: { judge: judgeSpec, reason: parsed.reason } };
}

writeFileSync(outPath, "");
for (const line of readFileSync(answersPath, "utf8").split("\n").filter(Boolean)) {
	const run = JSON.parse(line);
	if (run.skipped) continue;
	const answers = parseAnswers(run.answer ?? "", run.probes);
	for (const id of run.probes) {
		const p = probes.get(String(id));
		const answer = answers[id] ?? "";
		const scored = p.type === "next_step" ? await judge(p, answer) : mechanical(p, answer);
		appendFileSync(outPath, JSON.stringify({ recording: run.recording, variant: run.variant, cut: run.cut, agent: run.agent, probe: id, type: p.type, age: p.age, task: p.task,
			answered: Boolean(answers[id]), failed: Boolean(run.error), answer: answer.slice(0, 400), ...scored }) + "\n");
	}
}
process.exit(0);
