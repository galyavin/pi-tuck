// Judge LongMemEval answers with the official per-type prompts (PREREG-LME.md; DeepSeek as the judge, a documented deviation).
//   jiti benchmark/lme/score.ts QUESTIONS.json ANSWERS.jsonl OUT.jsonl [--judge SPEC]
// One row per question (the last answer row per question counts); questions already in OUT.jsonl are skipped.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEEPSEEK, judge } from "./lib";

const [questionsPath, answersPath, outPath, ...rest] = process.argv.slice(2);
const spec = rest[rest.indexOf("--judge") + 1] ?? `${DEEPSEEK}:medium`;
const questions = JSON.parse(readFileSync(questionsPath, "utf8"));
const last = new Map<string, any>();
for (const line of readFileSync(answersPath, "utf8").split("\n").filter(Boolean)) { const r = JSON.parse(line); last.set(r.question_id, r); }
const done = new Set<string>(existsSync(outPath) ? readFileSync(outPath, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l).question_id) : []);
mkdirSync(join(outPath, ".."), { recursive: true });
for (const [qid, r] of last) {
	if (done.has(qid)) continue;
	const q = questions[qid];
	const verdict = r.skipped || r.error || r.answer === undefined ? { correct: 0, raw: "no answer" } : await judge(spec, q, r.answer, `lme-judge ${qid}`);
	appendFileSync(outPath, JSON.stringify({ question_id: qid, question_type: q.question_type, abstention: qid.endsWith("_abs"), variant: r.variant, correct: verdict.correct, judge: spec, raw: verdict.raw, noAnswer: Boolean(r.skipped || r.error), requests: r.usage?.requests, tools: r.tools, input: r.usage?.input, cacheRead: r.usage?.cacheRead, output: r.usage?.output, ms: r.ms, index: r.index }) + "\n");
}
console.error(`${answersPath}: ${last.size} questions judged`);
process.exit(0);
