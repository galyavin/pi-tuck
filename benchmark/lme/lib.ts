// Shared by the LongMemEval runs (PREREG-LME.md): one place that calls the judge model, keeps the spend, and holds the official judge prompts.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const DEEPSEEK = "openrouter/deepseek/deepseek-v4.1-flash-1017"; // the dated snapshot, on the one upstream set in agent dir R (harness/common.py)
const runtime = await ModelRuntime.create({ authPath: join(process.env.HOME!, ".pi/agent/auth.json"), modelsPath: join(import.meta.dirname, "..", "runs", "agent", "R", "models.json") });
const SPEND = join(import.meta.dirname, "..", "runs", "lme", "spend.jsonl");

/** One completion; `spec` is provider/model:thinking. Every call's cost is appended to runs/lme/spend.jsonl. */
export async function complete(spec: string, text: string, label: string): Promise<string> {
	const [id, thinking] = spec.split(":");
	const model = runtime.getModel(id.slice(0, id.indexOf("/")), id.slice(id.indexOf("/") + 1));
	if (!model) throw new Error(`no model ${spec}`);
	for (let attempt = 0; ; attempt++) {
		const response: any = await runtime.completeSimple(model, { messages: [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }] }, { reasoning: thinking as any } as any);
		if (response.stopReason === "error" && attempt < 5) { await new Promise(r => setTimeout(r, 5000 * (attempt + 1))); continue; }
		mkdirSync(dirname(SPEND), { recursive: true });
		appendFileSync(SPEND, JSON.stringify({ label, spec, responseId: response.responseId, cost: response.usage?.cost?.total ?? 0, input: response.usage?.input, output: response.usage?.output, at: new Date().toISOString() }) + "\n");
		return response.content.map((b: any) => b.type === "text" ? b.text : "").join("");
	}
}

/** The official LongMemEval answer-check prompts (src/evaluation/evaluate_qa.py, get_anscheck_prompt), unchanged. */
export function judgePrompt(type: string, question: string, answer: string, response: string, abstention: boolean): string {
	const fill = (template: string) => template.replace("{}", () => question).replace("{}", () => answer).replace("{}", () => response);
	if (abstention) return fill("I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: {}\n\nExplanation: {}\n\nModel Response: {}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.");
	if (["single-session-user", "single-session-assistant", "multi-session"].includes(type))
		return fill("I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.");
	if (type === "temporal-reasoning")
		return fill("I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. \n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.");
	if (type === "knowledge-update")
		return fill("I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.");
	if (type === "single-session-preference")
		return fill("I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: {}\n\nRubric: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only.");
	throw new Error(`unknown question type ${type}`);
}

/** The benchmark's verdict rule: "yes" anywhere in the lower-cased reply. */
export async function judge(spec: string, q: { question_id: string; question_type: string; question: string; answer: string }, response: string, label: string): Promise<{ correct: number; raw: string }> {
	const raw = await complete(spec, judgePrompt(q.question_type, q.question, q.answer, response || "(no answer)", q.question_id.endsWith("_abs")), label);
	return { correct: raw.toLowerCase().includes("yes") ? 1 : 0, raw: raw.slice(0, 300) };
}
