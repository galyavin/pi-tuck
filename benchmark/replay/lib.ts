// Shared pieces of the paired replay: loading a recording, the cut schedule, and rebuilding the session state a compactor leaves.
import { readFileSync } from "node:fs";
import { SessionManager, estimateTokens, type SessionEntry } from "@earendil-works/pi-coding-agent";

/** The replayed model's window and the reply reserve the live arms ran with (the larger of Pi's reserveTokens and the model's maxTokens). */
export const WINDOW = 128_000;
export const RESERVE = 32_768;
export const KEEP_RECENT = 20_000;
/** Raw tokens of new history between two scheduled cuts; the first cut is where the request first reaches the cut band. */
export const DELTA = 50_000;
/** What a request carries beyond the conversation when the recording has no system entry to measure. */
export const DEFAULT_SYSTEM_TOKENS = 3_500;

export type Entry = SessionEntry;
export interface Segment { index: number; instance: string; start: number; end: number }
export interface Recording {
	path: string; header: any; cwd: string; entries: Entry[]; systemTokens: number;
	/** One per task: the user prompt's entry index and the entry index just past the task's last entry. */
	segments: Segment[];
	/** Cumulative estimated tokens: cum[i] is the tokens of entries[0..i). */
	cum: number[];
}
export interface Compaction { position: number; summary: string; firstKeptEntryId: string; tokensBefore: number; details?: unknown }

const textOf = (content: unknown): string => typeof content === "string" ? content
	: Array.isArray(content) ? content.map((b: any) => b.type === "text" ? b.text : "").join("") : "";

export function loadRecording(path: string): Recording {
	const lines = readFileSync(path, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
	const header = lines[0];
	if (header.type !== "session") throw new Error(`${path}: no session header`);
	let systemTokens = DEFAULT_SYSTEM_TOKENS;
	const kept: Entry[] = [];
	for (const e of lines.slice(1)) {
		if (e.type !== "message") continue; // cuts, model and thinking changes are re-created by the replay; every message stays
		if (e.message.role === "system") { systemTokens = estimateTokens(e.message) || systemTokens; continue; }
		kept.push(e);
	}
	const entries = kept.map((e, i) => ({ ...e, parentId: i ? kept[i - 1].id : null }) as Entry);
	const segments: Segment[] = [];
	entries.forEach((e, i) => {
		if (e.type !== "message" || e.message.role !== "user") return;
		const m = /Task (\d+) of \d+ \(([\w.-]+__[\w.-]+)\)/.exec(textOf(e.message.content));
		if (m) segments.push({ index: Number(m[1]), instance: m[2], start: i, end: entries.length });
	});
	segments.forEach((s, k) => { if (segments[k + 1]) s.end = segments[k + 1].start; });
	const cum = [0];
	for (const e of entries) cum.push(cum[cum.length - 1] + (e.type === "message" ? estimateTokens(e.message) : 0));
	return { path, header, cwd: header.cwd, entries, systemTokens, segments, cum };
}

/** A boundary where a cut can be made mid-task: the entries before it end in a tool result and an assistant response follows. */
export function validBoundary(rec: Recording, i: number): boolean {
	const before = rec.entries[i - 1], after = rec.entries[i];
	return Boolean(before && after && before.type === "message" && before.message.role === "toolResult" && after.type === "message" && after.message.role === "assistant");
}

/** The raw positions cuts are made at, the same for every compactor. */
export function schedule(rec: Recording, firstCutTokens: number, delta = DELTA): number[] {
	const positions: number[] = [];
	let target = firstCutTokens;
	for (let i = 1; i < rec.entries.length; i++) {
		if (rec.cum[i] >= target && validBoundary(rec, i)) {
			positions.push(i);
			target = rec.cum[i] + delta;
		}
	}
	return positions;
}

let counter = 0;
export const compactionEntry = (c: Compaction, parentId: string | null): Entry => ({
	type: "compaction", id: `c${(counter++).toString(36)}${Math.random().toString(36).slice(2, 8)}`, parentId, timestamp: new Date().toISOString(),
	summary: c.summary, firstKeptEntryId: c.firstKeptEntryId, tokensBefore: c.tokensBefore, details: c.details, fromHook: true,
} as Entry);

/** The branch a compactor's session has at raw position `position`: the raw entries up to it, with each earlier cut inserted where it was made. */
export function stateEntries(rec: Recording, cuts: Compaction[], position: number): Entry[] {
	const out: Entry[] = [];
	const push = (e: Entry) => out.push({ ...e, parentId: out.length ? out[out.length - 1].id : null } as Entry);
	let next = 0;
	for (let i = 0; i < position; i++) {
		while (next < cuts.length && cuts[next].position === i) push(compactionEntry(cuts[next++], null));
		push(rec.entries[i]);
	}
	while (next < cuts.length && cuts[next].position === position) push(compactionEntry(cuts[next++], null));
	return out;
}

export function sessionOf(rec: Recording, entries: Entry[]): SessionManager {
	return SessionManager.inMemory(rec.cwd, undefined, [rec.header, ...entries] as any);
}

/** Pi's chars/4 estimate of the conversation a session sends, the one measure used for every compactor's "context carried". */
export function carried(manager: SessionManager): number {
	return manager.buildSessionProjection().messages.reduce((n: number, m: any) => n + estimateTokens(m), 0);
}

/** Raw tokens before a cut that no probe's evidence may fall in, so that no compactor's kept tail can hold a probed fact. Probes whose evidence a
 * compactor kept anyway are dropped at analysis time. */
export const PROBE_CUTOFF_TOKENS = 35_000;

export function scheduleFor(rec: Recording, option: (name: string, fallback: string) => string): number[] {
	const room = WINDOW - RESERVE, band = room - Math.ceil(room * 0.02);
	return schedule(rec, Number(option("--first-cut", String(band - rec.systemTokens))), Number(option("--delta", String(DELTA))));
}

/** True when a provider reports a plan or rate cap rather than a fault in the request. */
export const isUsageLimit = (message: string) => /usage limit|rate limit|quota|too many requests|\b429\b/i.test(message);
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
/** Runs `attempt` until it stops failing on a plan or rate cap, waiting between tries (30 minutes, as a cap that resets in hours is the case to ride out).
 * `attempt` returns an error string or undefined, or throws. Gives up after `maxHours`. */
export async function untilNotCapped<T>(label: string, attempt: () => Promise<{ error?: string; value: T }>, maxHours = 72): Promise<{ error?: string; value: T; waitedMs: number }> {
	const started = Date.now();
	for (;;) {
		let outcome: { error?: string; value: T };
		try { outcome = await attempt(); } catch (error) { outcome = { error: (error as Error).message, value: undefined as T }; }
		if (!outcome.error || !isUsageLimit(outcome.error) || Date.now() - started > maxHours * 3_600_000) return { ...outcome, waitedMs: Date.now() - started };
		console.error(`${new Date().toISOString()} ${label}: usage cap, retrying in 30 min`);
		await sleep(30 * 60_000);
	}
}
