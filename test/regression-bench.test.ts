import { test, expect, afterAll } from 'vitest';
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import { SessionManager, estimateTokens, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { DEFAULT_CUT_AT, bandOf, decideCut, measurableConversationTokens, planningReserve, projectedConversationTokens, type Plan } from '../src/budget';
import { assertNativeToolRounds } from '../src/protocol';
import { tuck, tuckObservedDraft } from '../src/tuck';

// A model-free regression benchmark: how often pi-tuck cuts, what each cut frees and carries, and what it costs, on four fixed sessions at three
// windows. Each session is appended one message at a time; at every tool boundary (a tool result that ends its round, where compaction.ts's
// turn_end trigger decides) the REAL decision path runs: the room and band of the window (bandOf at DEFAULT_CUT_AT), planningReserve, decideCut
// and tuckObservedDraft as the trigger calls them. A cut is appended as the product appends it (cut-yield.test.ts does the same).
// Nothing calls a model, so every number but the time is a pure function of the code and the fixtures (two runs agree exactly). A recording's last
// tool result is a boundary too: turn_end decides before the next assistant message exists.
//
// Accounting is cut-yield.test.ts's: calibration factor 1 (no receipts, so the factor is its floor of 1) and a fixed `mandatory` for the system
// prompt and tools (3000 at 32k and 12000 at 128k as there; 6000 at 64k, between the two). `before` and `after` are counted by the trigger's own
// measure (projectedConversationTokens); the draft is planned with the planner's (measurableConversationTokens), as compaction.ts does.
// `carried` is benchmark/replay/lib.ts's measure: Pi's estimateTokens summed over the projection a cut leaves.
//
// test/regression-bench.json holds the metrics. GOLDEN_RECORD=1 rewrites it instead of checking it (the convention of view-golden.test.ts).
// The three recordings in test/fixtures/regression are sanitized public SWE-bench sessions; they are inputs and are never edited. A window the
// recording is too short for records cuts 0 (and says so in the golden): it still asserts that nothing cuts and nothing is refused.

const baselinePath = process.env.PART3_BASELINE;
// Test-only counterfactual. Production never imports or runs the old allocator.
const baseline: typeof import('../src/tuck') | undefined = baselinePath ? await import(/* @vite-ignore */ pathToFileURL(baselinePath).href) : undefined;
const baselineBudget: typeof import('../src/budget') | undefined = baselinePath ? await import(/* @vite-ignore */ pathToFileURL(baselinePath.replace(/tuck\.js$/, 'budget.js')).href) : undefined;
const performanceRows: Record<string, { v117: number; current: number; ratio: number }> = {};
interface CutObservation { round: number; target: string; before: number; after: number; carried: number; cap: number; overshoot: number;
  mode: string; boundary: number; baselineMode?: string; baselineBoundary?: number; baselineAfter?: number; baselineCarried?: number; baselineUnavailable?: string }
const cutObservations: Record<string, CutObservation[]> = {};
const capFailures: Record<string, string[]> = {};
const decisionObservations: Record<string, unknown[]> = {};
afterAll(() => {
  if (process.env.PART3_DECISION_REPORT) writeFileSync(process.env.PART3_DECISION_REPORT, JSON.stringify(decisionObservations, null, 2) + '\n');
  if (process.env.PART3_PERF_REPORT) writeFileSync(process.env.PART3_PERF_REPORT, JSON.stringify(performanceRows, null, 2) + '\n');
  if (process.env.PART3_CUT_REPORT) writeFileSync(process.env.PART3_CUT_REPORT, JSON.stringify(cutObservations, null, 2) + '\n');
});

type Message = Parameters<SessionManager['appendMessage']>[0];
type Header = NonNullable<ReturnType<SessionManager['getHeader']>>;
interface Session { name: string; cwd: string; header?: Header; messages: Message[] }
interface Window { window: number; response: number; mandatory: number }

const WINDOWS: Window[] = [
	{ window: 32768, response: 8192, mandatory: 3000 },
	{ window: 65536, response: 16384, mandatory: 6000 },
	{ window: 131072, response: 16384, mandatory: 12000 },
];
// Long enough that the synthetic session cuts several times at the largest window (the smaller ones cut far more often).
const SYNTHETIC_TURNS = 240;
const UNREDUCED = 'Tool-loop preflight compaction did not reduce context within the estimated request budget';
const CAPACITY = "mandatory context cannot fit or reduce the request budget";

function recording(name: string): Session {
	const lines = readFileSync(new URL(`./fixtures/regression/${name}.jsonl`, import.meta.url), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
	const header = lines[0];
	if (header.type !== 'session') throw new Error(`${name}: no session header`);
	// Only messages are replayed (compactions and model changes in a recording are not); a system message would be the mandatory input, and these have none.
	const messages = lines.slice(1).filter(entry => entry.type === 'message' && entry.message.role !== 'system').map(entry => entry.message as Message);
	return { name, cwd: header.cwd, header, messages };
}

// The 'low-prose' shape of test/synthetic-sessions.ts (same seed, vocabulary, times and message order), grown by `turns`. It is copied, not
// imported, so that a change to the shared generator does not move this benchmark's input; the golden pins what it produces.
const WORDS = 'parser cache index token budget summary recall branch module schema router worker queue retry timeout config build test lint deploy migrate session window ledger anchor cursor shard vector'.split(' ');
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const reply = (content: unknown[], stopReason: string, timestamp: number) =>
	({ role: 'assistant', content, api: 'openai-completions', provider: 'probe', model: 'probe', usage, stopReason, timestamp }) as never as Message;
function syntheticLowProse(turns: number): Session {
	let seed = 7;
	const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
	const words = (n: number) => Array.from({ length: n }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(' ');
	let clock = 1_700_000_000_000;
	const stamp = () => (clock += 1000);
	const messages: Message[] = [];
	const user = (text: string) => messages.push({ role: 'user', content: text, timestamp: stamp() });
	const result = (id: string, name: string, text: string, isError = false) =>
		messages.push({ role: 'toolResult', toolCallId: id, toolName: name, content: [{ type: 'text', text }], isError, timestamp: stamp() });
	const call = (id: string, name: string, args: object) => ({ type: 'toolCall', id, name, arguments: args });
	let calls = 0;
	for (let turn = 1; turn <= turns; turn++) {
		const file = `src/${WORDS[turn % WORDS.length]}/${WORDS[(turn * 7) % WORDS.length]}-${turn % 97}.ts`;
		if (turn % 60 === 1) user(`Task ${turn}: please ${words(40)}`);
		const a = `c${++calls}`, b = `c${++calls}`, e = `c${++calls}`;
		messages.push(reply([{ type: 'text', text: `Checking ${file}. ${words(12)}` }, call(a, 'read', { path: file }),
			call(b, 'bash', { command: `npm test -- ${WORDS[turn % 11]} && rg ${WORDS[turn % 13]} src` })], 'toolUse', stamp()));
		result(a, 'read', words(500));
		result(b, 'bash', words(250), turn % 9 === 0);
		messages.push(reply([call(e, 'edit', { path: file, oldText: words(12), newText: words(14) })], 'toolUse', stamp()));
		result(e, 'edit', 'Edited.');
		messages.push(reply([{ type: 'text', text: `Round ${turn} done. ${words(15)}` }], turn % 60 === 0 ? 'stop' : 'toolUse', stamp()));
	}
	return { name: 'synthetic-low-prose', cwd: '/tmp/synthetic-project', messages };
}

interface Metrics {
	/** Tool boundaries the trigger decided at. */
	rounds: number; cuts: number; cutsPer100Rounds: number;
	/** Share of cuts that freed less than room/10 tokens of conversation. */
	lowYieldShare: number;
	carriedMean: number; carriedMax: number; summaryCharsMean: number; summaryCharsMax: number;
	/** Boundaries where the decision was a fault, or a draft reported that the mandatory context cannot fit or reduce the request budget. */
	refusals: number;
	medianCutMs: number;
	note?: string;
}

function replay(session: Session, { window, response, mandatory }: Window, reference = false): Metrics & { refusalReasons: string[] } {
	const name = `${session.name}@${window / 1024}k`;
	const observations: CutObservation[] = cutObservations[name] = [];
	const failures: string[] = capFailures[name] = [];
	const manager = SessionManager.inMemory(session.cwd, undefined, session.header ? [session.header] : undefined);
	const ctx = { sessionManager: manager, cwd: session.cwd, model: { contextWindow: window, maxTokens: response, provider: 'regression', id: 'regression', api: 'openai-completions' } } as unknown as ExtensionContext;
	const owner = reference ? baselineBudget! : { projectedConversationTokens, measurableConversationTokens };
	const compiler = reference ? baseline! : { tuck, tuckObservedDraft };
	const measure = (messages: never[]) => owner.projectedConversationTokens(messages, ctx);
	const plannerMeasure = (messages: never[]) => owner.measurableConversationTokens(messages, ctx);
	const room = window - response, band = bandOf(room, DEFAULT_CUT_AT), fits = (tokens: number, limit: number) => tokens < limit;
	const carried = () => manager.buildSessionProjection().messages.reduce((n, m) => n + estimateTokens(m), 0);
	let rounds = 0, refusals = 0, low = 0;
	const refusalReasons: string[] = [], carriedAfter: number[] = [], chars: number[] = [], times: number[] = [];
	session.messages.forEach((message, i) => {
		manager.appendMessage(message);
		if (message.role !== 'toolResult' || session.messages[i + 1]?.role === 'toolResult') return;
		rounds++;
		const saved = manager.buildSessionProjection().messages as never[];
		const before = measure(saved);
		const previousSummary = (saved.find(m => (m as { role: string }).role === 'compactionSummary') as { summary?: string } | undefined)?.summary;
		let refused: string | undefined;
		const plans: Record<string, unknown> = {};
		const started = performance.now();
		const decision = decideCut({ total: before + mandatory, mandatory, before, room, band, fits, unreduced: UNREDUCED,
			plan: (target): Plan<{ compaction: NonNullable<ReturnType<typeof tuckObservedDraft>['compaction']> }> => {
				const reserve = planningReserve(window, target === 'band' ? band : room, 1, mandatory);
				const draft = compiler.tuckObservedDraft(compiler.tuck, { branchEntries: manager.getBranch(), tokensBefore: before, previousSummary }, ctx, reserve, plannerMeasure as never, {}, true);
                plans[target] = draft.compaction ? { after: draft.after, mode: draft.mode } : { reason: draft.unavailable };
				if (!draft.compaction) {
					if (draft.unavailable.includes(CAPACITY)) refused ??= draft.unavailable;
					return { draft: false, capacityRejected: Boolean(draft.capacityRejected), reason: draft.unavailable };
				}
				const preview = SessionManager.inMemory(session.cwd, undefined, [manager.getHeader()!, ...manager.getBranch()]);
				preview.appendCompaction(draft.compaction.summary, draft.compaction.firstKeptEntryId, before, draft.compaction.details, true);
				const messages = preview.buildSessionProjection().messages;
				assertNativeToolRounds(messages);
				return { draft: true, after: measure(messages as never[]), mode: draft.mode, compaction: draft.compaction };
			} });
		const ms = performance.now() - started;
        if (process.env.PART3_DECISION_REPORT && baseline && !reference) {
            const oldPlans: Record<string, unknown> = {};
            const oldDecision = decideCut({ total: before + mandatory, mandatory, before, room, band, fits, unreduced: UNREDUCED,
                plan: (target): Plan => {
                    const reserve = planningReserve(window, target === 'band' ? band : room, 1, mandatory);
                    const draft = baseline.tuckObservedDraft(baseline.tuck, { branchEntries: manager.getBranch(), tokensBefore: before, previousSummary }, ctx, reserve, plannerMeasure as never, {}, true);
                    oldPlans[target] = draft.compaction ? { after: draft.after, mode: draft.mode } : { reason: draft.unavailable };
                    return draft.compaction ? { draft: true, after: draft.after, mode: draft.mode } : { draft: false, reason: draft.unavailable, capacityRejected: Boolean(draft.capacityRejected) };
                } });
            (decisionObservations[name] ??= []).push({ round: rounds, before, total: before + mandatory, room, band,
                kind: decision.kind, target: decision.kind === 'cut' ? decision.target : undefined, plans,
                baselineKind: oldDecision.kind, baselineTarget: oldDecision.kind === 'cut' ? oldDecision.target : undefined, baselinePlans: oldPlans });
        }
		if (decision.kind === 'fault') refused ??= decision.message;
		if (refused !== undefined) { refusals++; refusalReasons.push(`round ${rounds}: ${refused}`); }
		if (decision.kind !== 'cut') return;
		const c = decision.plan.compaction;
        const cap = (c.details as { carriedTarget: number }).carriedTarget;
        if (!reference && !Number.isFinite(cap)) failures.push(`round ${rounds}: missing carried target`);
        if (!reference && decision.plan.after > cap) failures.push(`round ${rounds}: ${decision.plan.after} exceeds target ${cap}`);
        const observation: CutObservation = { round: rounds, target: decision.target, before, after: decision.plan.after, carried: 0, mode: decision.plan.mode, boundary: manager.getBranch().findIndex(entry => entry.id === c.firstKeptEntryId), cap, overshoot: decision.plan.after - cap };
        if (baseline && !reference && !process.env.PART3_PERF_REPORT) {
            const reserve = planningReserve(window, decision.target === 'band' ? band : room, 1, mandatory);
            const old = baseline.tuckObservedDraft(baseline.tuck, { branchEntries: manager.getBranch(), tokensBefore: before, previousSummary }, ctx, reserve, plannerMeasure as never, {}, true);
            if (old.compaction) {
                observation.baselineAfter = old.after;
                observation.baselineMode = old.mode; observation.baselineBoundary = manager.getBranch().findIndex(entry => entry.id === old.compaction!.firstKeptEntryId);
                const preview = SessionManager.inMemory(session.cwd, undefined, [manager.getHeader()!, ...manager.getBranch()]);
                preview.appendCompaction(old.compaction.summary, old.compaction.firstKeptEntryId, before, old.compaction.details, true);
                observation.baselineCarried = preview.buildSessionProjection().messages.reduce((n, m) => n + estimateTokens(m), 0);
                if (process.env.PART3_ENFORCE === '1' && decision.plan.after > old.after)
                    failures.push(`round ${rounds}: ${decision.plan.after} exceeds v1.0.17 at this cut point (${old.after})`);
            } else observation.baselineUnavailable = old.unavailable;
        }
		manager.appendCompaction(c.summary, c.firstKeptEntryId, before, c.details, true);
		if (before - decision.plan.after < room / 10) low++;
        observation.carried = carried(); observations.push(observation);
		carriedAfter.push(observation.carried); chars.push(c.summary.length); times.push(ms);
	});
	const mean = (xs: number[]) => xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0;
	const max = (xs: number[]) => Math.max(0, ...xs);
	const median = (xs: number[]) => xs.length ? [...xs].sort((a, b) => a - b)[xs.length >> 1]! : 0;
	const cuts = carriedAfter.length;
	return { rounds, cuts, cutsPer100Rounds: Math.round(cuts / rounds * 1e4) / 100, lowYieldShare: cuts ? Math.round(low / cuts * 1e4) / 1e4 : 0,
		carriedMean: mean(carriedAfter), carriedMax: max(carriedAfter), summaryCharsMean: mean(chars), summaryCharsMax: max(chars),
		refusals, medianCutMs: Math.round(median(times) * 10) / 10, ...(cuts ? {} : { note: 'never cuts at this window: the session stays below the band' }), refusalReasons };
}

const sessions: (() => Session)[] = [() => recording('prose-heavy'), () => recording('low-prose'), () => recording('large-tool-output'), () => syntheticLowProse(SYNTHETIC_TURNS)];
const goldenUrl = new URL('./regression-bench.json', import.meta.url);
const recordGolden = process.env.GOLDEN_RECORD !== undefined;
const recorded: Record<string, Metrics> = {};
afterAll(() => { if (recordGolden) writeFileSync(goldenUrl, JSON.stringify(recorded, null, '\t') + '\n'); });

// Within ±10% of the golden; a golden of 0 admits only 0.
const near = (actual: number, golden: number) => Math.abs(actual - golden) <= Math.abs(golden) * 0.1;

for (const make of sessions) {
	const session = make();
	for (const w of WINDOWS) {
		const name = `${session.name}@${w.window / 1024}k`;
		test(`${name}: cut frequency, yield, carried context, summary size and cut time stay at the golden`, () => {
			const { refusalReasons, ...m } = replay(session, w);
			expect(capFailures[name], `${name}: per-cut target`).toEqual([]);
            if (process.env.PART3_PERF_REPORT && baseline && m.cuts) {
                const old: number[] = [], current: number[] = [];
                for (let sample = 0; sample < 5; sample++) {
                    old.push(replay(session, w, true).medianCutMs);
                    current.push(replay(session, w).medianCutMs);
                }
                const median = (xs: number[]) => xs.sort((a,b) => a-b)[2]!;
                const v117 = median(old), now = median(current);
                performanceRows[name] = { v117, current: now, ratio: now / v117 };
                if (process.env.PART3_ENFORCE === '1') expect(now / v117, `${name}: median cut time`).toBeLessThanOrEqual(2);
            }
			if (recordGolden) { recorded[name] = m; return; }
			const g = (JSON.parse(readFileSync(goldenUrl, 'utf8')) as Record<string, Metrics>)[name];
			if (!g) throw new Error(`${name} has no golden: GOLDEN_RECORD=1 records it`);
			// Every metric is checked and every violation reported, so a regression shows all that it moved.
			const violations: string[] = [];
			if (m.refusals !== 0) violations.push(`refusals ${m.refusals}, must be 0: ${refusalReasons.join('; ')}`);
			for (const key of ['cuts', 'cutsPer100Rounds', 'carriedMean', 'carriedMax', 'summaryCharsMean', 'summaryCharsMax'] as const)
				if (!near(m[key], g[key])) violations.push(`${key} ${m[key]}, golden ${g[key]}`);
			// A share is a ratio of few cuts: 0 stays 0, otherwise it may move by 10% of the golden or by 0.05, whichever is more.
			if (Math.abs(m.lowYieldShare - g.lowYieldShare) > (g.lowYieldShare === 0 ? 0 : Math.max(g.lowYieldShare * 0.1, 0.05)))
				violations.push(`lowYieldShare ${m.lowYieldShare}, golden ${g.lowYieldShare}`);
			// A runner can be many times slower than the laptop that recorded the golden: ten times its median, plus 50 ms.
			if (m.medianCutMs > g.medianCutMs * 10 + 50) violations.push(`medianCutMs ${m.medianCutMs}, golden ${g.medianCutMs} (limit ten times plus 50)`);
			expect(violations, JSON.stringify({ got: m, golden: g })).toEqual([]);
		}, 600_000);
	}
}
