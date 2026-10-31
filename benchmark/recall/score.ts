// Score the answers to the independent questions with an LLM judge that sees the question, the reference and the answer, not the compactor.
//   jiti benchmark/recall/score.ts QUESTIONS.json ANSWERS.jsonl OUT.jsonl [--judge SPEC]
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { DEEPSEEK, judge } from "./lib";

const [questionsPath, answersPath, outPath, ...rest] = process.argv.slice(2);
const option = (name: string, fallback: string) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : fallback; };
const judgeSpec = option("--judge", `${DEEPSEEK}:medium`);
const questions = new Map<string, any>(JSON.parse(readFileSync(questionsPath, "utf8")).map((q: any) => [q.id, q]));

function parseAnswers(text: string, ids: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	const body = text.replace(/```(?:json)?/g, "");
	const start = body.indexOf("{"), end = body.lastIndexOf("}");
	if (start >= 0 && end > start) {
		try { const value = JSON.parse(body.slice(start, end + 1)); for (const id of ids) if (id in value) out[id] = typeof value[id] === "string" ? value[id] : JSON.stringify(value[id]); return out; } catch { /* line parsing below */ }
	}
	for (const id of ids) { const m = new RegExp(`${id}\\W+([^\\n]+)`).exec(body); if (m) out[id] = m[1]; }
	return out;
}

writeFileSync(outPath, "");
for (const line of readFileSync(answersPath, "utf8").split("\n").filter(Boolean)) {
	const run = JSON.parse(line);
	if (run.skipped) continue;
	const answers = parseAnswers(run.answer ?? "", run.probes);
	for (const id of run.probes) {
		const q = questions.get(id);
		const answer = answers[id] ?? "";
		const verdict = await judge(judgeSpec, q[run.wording], q.answer, answer, `score ${run.variant} ${run.wording} cut ${run.cut}`);
		appendFileSync(outPath, JSON.stringify({ recording: run.recording, variant: run.variant, wording: run.wording, cut: run.cut, agent: run.agent, question: id, task: q.task, kind: q.kind,
			evidenceIndex: q.evidenceIndex, answered: Boolean(answers[id]), failed: Boolean(run.error), tools: run.tools, answer: answer.slice(0, 400), correct: verdict.correct, reason: verdict.reason }) + "\n");
	}
}
process.exit(0);
