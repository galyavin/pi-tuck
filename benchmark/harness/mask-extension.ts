// Observation masking, the strategy compared in "The Complexity Trap" (Lindenbauer et al., 2025): on each request, tool outputs older than the last
// M turns are replaced by a placeholder; the agent's reasoning and its tool calls stay. A turn is one assistant message. Pi's own compaction stays on
// as the fallback when the masked history still outgrows the window (user prompts and reasoning accumulate over a 30-task chain).
// M comes from TUCK_EVAL_MASK_TURNS (default 10, the paper's main setting). If TUCK_EVAL_MASK_LOG names a file, each request appends
// {turns, masked}: how many assistant turns the history had and how many tool outputs were replaced.
import { appendFileSync } from "node:fs";
export default function (pi: any) {
	const M = Number(process.env.TUCK_EVAL_MASK_TURNS ?? 10);
	pi.on("context", async (event: any) => {
		const messages = event.messages as any[];
		const assistants: number[] = [];
		messages.forEach((m, i) => { if (m.role === "assistant") assistants.push(i); });
		if (assistants.length <= M) return;
		const cutoff = assistants[assistants.length - M];
		let masked = 0;
		const out = messages.map((m, i) => { if (i < cutoff && m.role === "toolResult") { masked++; return { ...m, content: [{ type: "text", text: `[Output omitted: older than the last ${M} turns]` }] }; } return m; });
		if (process.env.TUCK_EVAL_MASK_LOG) appendFileSync(process.env.TUCK_EVAL_MASK_LOG, JSON.stringify({ turns: assistants.length, masked }) + "\n");
		return { messages: out };
	});
}
