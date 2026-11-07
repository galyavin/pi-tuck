// Write the independent question set for one recording (PREREG-RECALL.md): a model that has seen no compactor's output reads a task's transcript and
// writes questions in two wordings with a reference answer; mechanical checks keep the wordings apart; a validator must answer the close wording
// from the cited entries alone.
//   jiti benchmark/recall/questions.ts RECORDING CUTS_FILE OUT.json [--writer SPEC] [--validator SPEC] [--judge SPEC]
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { PROBE_CUTOFF_TOKENS, loadRecording } from "../replay/lib";
import { DEEPSEEK, complete, judge, parseJson } from "./lib";

const [recordingPath, cutsFile, outPath, ...rest] = process.argv.slice(2);
const option = (name: string, fallback: string) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : fallback; };
const writerSpec = option("--writer", `${DEEPSEEK}:high`), validatorSpec = option("--validator", `${DEEPSEEK}:medium`), judgeSpec = option("--judge", `${DEEPSEEK}:medium`);
const TASKS_PER_CUT = 2, CANDIDATES = 5, KEEP = 3;

const rec = loadRecording(recordingPath);
const cuts: { position: number }[] = JSON.parse(readFileSync(cutsFile, "utf8")).cuts;
const textOf = (c: any): string => typeof c === "string" ? c : Array.isArray(c) ? c.map((b: any) => b.type === "text" ? b.text : b.type === "toolCall" ? `[call ${b.name} ${JSON.stringify(b.arguments).slice(0, 400)}]` : "").join("\n") : "";
const clip = (s: string, n: number) => s.length <= n ? s : `${s.slice(0, Math.floor(n * 0.7))} …[clipped]… ${s.slice(-Math.floor(n * 0.3))}`;
const render = (i: number, cap: number) => { const m: any = rec.entries[i].type === "message" ? (rec.entries[i] as any).message : undefined; return m ? `[#${i} ${m.role}] ${clip(textOf(m.content).replace(/\x1b\[[0-9;]*m/g, ""), m.role === "toolResult" ? cap : m.role === "user" ? 4000 : 1500)}` : ""; };

/** Terms a keyword search could match on: long tokens with a symbol, a digit or an interior capital. */
export const distinctive = (text: string): Set<string> => new Set((text.match(/[A-Za-z0-9_./-]{6,}/g) ?? []).map(t => t.replace(/[.\-/]+$/, "")).filter(t => t.length >= 6 && (/[_./\d]/.test(t) || /[a-z][A-Z]/.test(t))).map(t => t.toLowerCase()));

function rng(seed: string) { let a = parseInt(createHash("sha1").update(seed).digest("hex").slice(0, 8), 16); return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const writerPrompt = (transcript: string) => `Below is the transcript of one software task a coding agent worked on. Entry numbers are in [#n]. Write ${CANDIDATES} questions that someone could ask the agent LATER, after its memory of this task has been compressed, that can be answered only from this transcript. Each question needs a short, specific answer (at most 25 words): a decision and the reason for it, a value or result that was observed, a cause that was found, an approach that was tried and dropped, or where something is. Do not ask about the final tag, the task id, or how the task ended.

For every question give two wordings of the SAME question:
- "close": ask it using the transcript's own terms: name the specific file, function, error or value involved.
- "paraphrase": ask it as someone would who does not remember the exact names: describe the thing by what it does or why, and use NO file names, function names, class names, error text, identifiers or numbers that appear in the transcript.

Also give "answer" (the reference answer) and "evidence" (the entry numbers the answer rests on). Reply with only a JSON array of objects {"kind","close","paraphrase","answer","evidence"}.

<transcript>
${transcript}
</transcript>`;

const questions: any[] = [];
const used = new Set<number>();
for (let k = 0; k < cuts.length; k++) {
	const cut = k + 1, position = cuts[k].position;
	const limit = rec.cum[position] - PROBE_CUTOFF_TOKENS;
	const eligible = rec.segments.filter(s => rec.cum[s.end] <= limit);
	const unused = eligible.filter(s => !used.has(s.index));
	const pool = unused.length >= TASKS_PER_CUT ? unused : eligible;
	const random = rng(`${recordingPath}#${cut}`);
	const chosen: typeof pool = [];
	while (chosen.length < Math.min(TASKS_PER_CUT, pool.length)) { const s = pool[Math.floor(random() * pool.length)]; if (!chosen.includes(s)) chosen.push(s); }
	for (const seg of chosen) {
		used.add(seg.index);
		let cap = 1200, transcript = "";
		for (; cap >= 250; cap = Math.floor(cap / 2.4)) { transcript = Array.from({ length: seg.end - seg.start }, (_, j) => render(seg.start + j, cap)).filter(Boolean).join("\n"); if (transcript.length <= 36000) break; }
		const candidates = parseJson(await complete(writerSpec, writerPrompt(transcript), `write ${recordingPath} cut ${cut} task ${seg.index}`)) ?? [];
		let kept = 0;
		for (const c of Array.isArray(candidates) ? candidates : []) {
			if (kept >= KEEP) break;
			const evidence: number[] = (Array.isArray(c.evidence) ? c.evidence : []).map(Number).filter((n: number) => Number.isInteger(n) && n >= seg.start && n < seg.end);
			if (!c.close || !c.paraphrase || !c.answer || !evidence.length) continue;
			const terms = distinctive(evidence.map(i => textOf((rec.entries[i] as any).message?.content)).join("\n"));
			const lowerClose = String(c.close).toLowerCase(), lowerPara = String(c.paraphrase).toLowerCase();
			if ([...terms].filter(t => lowerClose.includes(t)).length < 2) continue;
			if ([...terms].some(t => lowerPara.includes(t))) continue;
			const cited = evidence.map(i => `[#${i}] ${clip(textOf((rec.entries[i] as any).message?.content), 8000)}`).join("\n\n");
			const attempt = await complete(validatorSpec, `Answer the question using only the transcript entries below. Reply with a short answer (at most 25 words), nothing else.\n\n<entries>\n${cited}\n</entries>\n\nQuestion: ${c.close}`, `validate ${recordingPath} cut ${cut}`);
			if (!(await judge(judgeSpec, c.close, String(c.answer), attempt, `validate-judge ${recordingPath} cut ${cut}`)).correct) continue;
			questions.push({ id: `q${cut}_${++kept}_${seg.index}`, cut, task: seg.index, instance: seg.instance, kind: String(c.kind ?? ""), close: String(c.close), paraphrase: String(c.paraphrase), answer: String(c.answer), evidence, evidenceIndex: Math.max(...evidence) });
		}
		console.error(`cut ${cut} task ${seg.index}: kept ${kept} of ${Array.isArray(candidates) ? candidates.length : 0}`);
	}
}
writeFileSync(outPath, JSON.stringify(questions, null, 1));
console.error(`${questions.length} questions`);
process.exit(0);
