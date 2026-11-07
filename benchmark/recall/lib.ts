// Shared by the recall benchmark (PREREG-RECALL.md): one place that calls the models, keeps the spend, and judges an answer against a reference.
import { join } from "node:path";
import { recordedCompletion } from "../replay/lib";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const DEEPSEEK = "openrouter/deepseek/deepseek-v4.1-flash-1017"; // the dated snapshot, on the one upstream set in agent dir R (harness/common.py)
const runtime = await ModelRuntime.create({ authPath: join(process.env.HOME!, ".pi/agent/auth.json"), modelsPath: join(import.meta.dirname, "..", "runs", "agent", "R", "models.json") });
const SPEND = join(import.meta.dirname, "..", "runs", "recall", "spend.jsonl");

/** One completion; `spec` is provider/model:thinking. Every call's cost is appended to runs/recall/spend.jsonl. */
export async function complete(spec: string, text: string, label: string): Promise<string> {
	return recordedCompletion(runtime, SPEND, spec, text, label);
}

export const parseJson = (out: string): any => { const m = /[\[{][\s\S]*[\]}]/.exec(out.replace(/```(?:json)?/g, "")); if (!m) return undefined; try { return JSON.parse(m[0]); } catch { return undefined; } };

/** The judge sees the question, the reference and the answer, nothing about the compactor. */
export async function judge(spec: string, question: string, reference: string, answer: string, label: string): Promise<{ correct: number; reason: string }> {
	const out = await complete(spec, `A person asked a coding agent a question about its earlier work. Decide whether the agent's answer is correct by comparing it with the reference answer.

<question>
${question}
</question>

<reference_answer>
${reference}
</reference_answer>

<agent_answer>
${answer || "(no answer)"}
</agent_answer>

Score 1 if the agent's answer states the key facts of the reference answer (wording and extra detail may differ, as long as nothing contradicts the reference). Score 0 if it is wrong, contradicts the reference, misses the key fact, or says it does not know. Reply with only a JSON object: {"score": 0 or 1, "reason": "<one sentence>"}.`, label);
	const parsed = parseJson(out);
	return { correct: parsed?.score === 1 ? 1 : 0, reason: parsed?.reason ?? `unparseable judge output: ${out.slice(0, 200)}` };
}
