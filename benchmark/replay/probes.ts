// Probes with answers computed mechanically from the recording, plus the "next step" probe. A fact is probed at a cut only when its evidence
// lies at least PROBE_CUTOFF_TOKENS of raw history before the cut, so a kept tail should not hold it; analysis drops any probe whose evidence
// a compactor kept anyway (replay_stats.py).
//   jiti benchmark/replay/probes.ts RECORDING.jsonl OUT.json [--first-cut N --delta N]
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { PROBE_CUTOFF_TOKENS, loadRecording, scheduleFor, type Recording, type Segment } from "./lib";

export interface Probe {
	id: string; cut: number; type: "files_changed" | "test_result" | "tag" | "result_prefix" | "error_hit" | "next_step";
	task?: number; instance?: string; question: string; truth: any; evidenceIndex: number; age: number;
}

const ANSI = /\x1b\[[0-9;]*m/g;
const textOf = (content: any): string => typeof content === "string" ? content : Array.isArray(content) ? content.map((b: any) => b.type === "text" ? b.text : "").join("") : "";
const TAG = /`([a-z]+-[a-z]+-\d{2})`/;

/** Everything mechanical about one task's segment: its tool calls with their results, in order. */
function toolRounds(rec: Recording, seg: Segment) {
	const calls = new Map<string, { name: string; args: any; index: number }>();
	const rounds: { name: string; args: any; callIndex: number; resultIndex: number; text: string; isError: boolean }[] = [];
	for (let i = seg.start; i < seg.end; i++) {
		const e: any = rec.entries[i];
		const m = e.message;
		if (m.role === "assistant") for (const b of m.content) if (b.type === "toolCall") calls.set(b.id, { name: b.name, args: b.arguments, index: i });
		if (m.role === "toolResult") {
			const call = calls.get(m.toolCallId);
			if (call) rounds.push({ name: call.name, args: call.args, callIndex: call.index, resultIndex: i, text: textOf(m.content).replace(ANSI, ""), isError: Boolean(m.isError) });
		}
	}
	return rounds;
}

const relative = (path: string, cwd: string) => path.replace(cwd + "/", "").replace(/^\/testbed\//, "").replace(/^\.\//, "");

function filesChanged(rec: Recording, seg: Segment) {
	const files = new Set<string>();
	let evidence = -1;
	for (const r of toolRounds(rec, seg)) {
		if ((r.name === "edit" || r.name === "write") && !r.isError && typeof (r.args?.path ?? r.args?.file_path) === "string") {
			files.add(relative(r.args.path ?? r.args.file_path, rec.cwd));
			evidence = Math.max(evidence, r.resultIndex);
		}
	}
	return files.size ? { truth: [...files].sort(), evidence } : undefined;
}

/** The last test-runner summary in the task's tool output: unittest/Django "Ran N tests ... OK|FAILED" or pytest "N passed, M failed in Ts". */
function lastTestSummary(rec: Recording, seg: Segment) {
	let found: { status: "pass" | "fail"; count: number; evidence: number } | undefined;
	for (const r of toolRounds(rec, seg)) {
		if (r.name !== "bash") continue;
		let status: "pass" | "fail" | undefined, count = 0;
		const unittest = [...r.text.matchAll(/Ran (\d+) tests? in [\d.]+s\s*\n+\s*(OK|FAILED)/g)].pop();
		if (unittest) { status = unittest[2] === "OK" ? "pass" : "fail"; count = Number(unittest[1]); }
		const pytest = [...r.text.matchAll(/^[= ]*((?:\d+ (?:passed|failed|error|errors|skipped|warnings?|xfailed|xpassed|deselected)(?:, )?)+).* in [\d.]+s/gm)].filter(m => /\d+ (?:passed|failed|error)/.test(m[1])).pop();
		if (pytest && (!unittest || (pytest.index ?? 0) > (unittest.index ?? 0))) {
			const passed = /(\d+) passed/.exec(pytest[1]), failed = /(\d+) (?:failed|error)/.exec(pytest[1]);
			if (passed || failed) { status = failed ? "fail" : "pass"; count = Number((passed ?? failed)![1]); }
		}
		if (status) found = { status, count, evidence: r.resultIndex };
	}
	return found;
}

function lastException(rec: Recording, seg: Segment) {
	let found: { name: string; evidence: number } | undefined;
	for (const r of toolRounds(rec, seg)) {
		if (r.name !== "bash") continue;
		const hit = [...r.text.matchAll(/^(?:[\w.]+\.)?([A-Z]\w*(?:Error|Exception))(?::|\s*$)/gm)].pop();
		if (hit) found = { name: hit[1], evidence: r.resultIndex };
	}
	return found;
}

function rng(seed: string) {
	let s = createHash("sha256").update(seed).digest().readUInt32LE(0);
	return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function sample<T>(items: T[], n: number, random: () => number): T[] {
	const pool = [...items], out: T[] = [];
	while (out.length < n && pool.length) out.push(pool.splice(Math.floor(random() * pool.length), 1)[0]);
	return out;
}

export const COUNTS = { files_changed: 5, test_result: 5, tag: 5, error_hit: 5 };

export function buildProbes(rec: Recording, cutNo: number, positions: number[]): Probe[] {
	const random = rng(`${rec.path}/${cutNo}`);
	const position = positions[cutNo - 1];
	const ageOf = (evidence: number) => positions.slice(0, cutNo).filter(p => p > evidence).length;
	let cutoff = position;
	while (cutoff > 0 && rec.cum[position] - rec.cum[cutoff] < PROBE_CUTOFF_TOKENS) cutoff--; // evidence must lie before this entry
	const segments = rec.segments.filter(s => s.start < cutoff);
	const task = (s: Segment) => `task ${s.index} (${s.instance})`;
	const pools: Record<string, Probe[]> = { files_changed: [], test_result: [], tag: [], error_hit: [] };
	for (const s of segments) {
		const files = filesChanged(rec, s);
		if (files && files.evidence < cutoff) pools.files_changed.push({ id: "", cut: cutNo, type: "files_changed", task: s.index, instance: s.instance, evidenceIndex: files.evidence, age: ageOf(files.evidence), truth: files.truth,
			question: `Which files did you modify (edit or write) while working on ${task(s)}? Reply with a JSON array of repository-relative paths.` });
		const test = lastTestSummary(rec, s);
		if (test && test.evidence < cutoff) pools.test_result.push({ id: "", cut: cutNo, type: "test_result", task: s.index, instance: s.instance, evidenceIndex: test.evidence, age: ageOf(test.evidence), truth: { status: test.status, count: test.count },
			question: `In ${task(s)}, what did the last test-runner summary you saw report? Reply "pass" or "fail" followed by the number the summary printed next to "Ran" (unittest/Django) or next to "passed" (pytest; "failed" if nothing passed), for example "pass 541".` });
		const prompt: any = rec.entries[s.start];
		const tag = TAG.exec(textOf(prompt.message.content))?.[1];
		if (tag) pools.tag.push({ id: "", cut: cutNo, type: "tag", task: s.index, instance: s.instance, evidenceIndex: s.start, age: ageOf(s.start), truth: tag,
			question: `The user's prompt for ${task(s)} required a tag in your final message for that task. What was the tag?` });
		const error = lastException(rec, s);
		if (error && error.evidence < cutoff) pools.error_hit.push({ id: "", cut: cutNo, type: "error_hit", task: s.index, instance: s.instance, evidenceIndex: error.evidence, age: ageOf(error.evidence), truth: error.name,
			question: `In ${task(s)}, what was the last Python exception class (such as ValueError) that appeared in your command output? Reply with the class name only.` });
	}
	const probes: Probe[] = [];
	for (const [type, n] of Object.entries(COUNTS)) probes.push(...sample(pools[type], n, random));
	if (segments.length) probes.push({ id: "", cut: cutNo, type: "result_prefix", evidenceIndex: rec.segments[0].start, age: ageOf(rec.segments[0].start), truth: "RESULT:",
		question: "In the rules the user gave at the start of the session, what must the final message of each task end with? Quote the required prefix of that last line." });
	const next: any = rec.entries[position];
	const summarize = (m: any) => [textOf(m.content).trim(), ...m.content.filter((b: any) => b.type === "toolCall").map((b: any) => `[${b.name} ${JSON.stringify(b.arguments).slice(0, 600)}]`)].filter(Boolean).join("\n");
	probes.push({ id: "", cut: cutNo, type: "next_step", evidenceIndex: position, age: 0, truth: summarize(next.message),
		question: "You are in the middle of a task. Without calling any tool now, state the single next action you were about to take: which tool, and on what (command, file or edit), and why." });
	probes.forEach((p, i) => { p.id = `c${cutNo}q${i + 1}`; });
	return probes;
}

if (process.argv[1]?.endsWith("probes.ts")) {
	const [recordingPath, outPath, ...rest] = process.argv.slice(2);
	const option = (name: string, fallback: string) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : fallback; };
	const rec = loadRecording(recordingPath);
	const positions = scheduleFor(rec, option);
	const all: Probe[] = [];
	for (let k = 1; k <= positions.length; k++) all.push(...buildProbes(rec, k, positions));
	writeFileSync(outPath, JSON.stringify(all, null, 1));
	const byType: Record<string, number> = {};
	for (const p of all) byType[p.type] = (byType[p.type] ?? 0) + 1;
	console.error(`${all.length} probes over ${positions.length} cuts`, byType);
}
