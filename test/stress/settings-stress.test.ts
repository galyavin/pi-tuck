/**
 * The settings stress test: real Pi, real pi-tuck, a scripted model, and settings sampled across the whole range they can take.
 *
 * A unit test asks whether one case works. This asks whether any combination of context window, response reserve, keep-recent, output cap and
 * tokenizer density can leave a session stuck, send a request over the window, save a summary that does not fit, refuse without saying why, or
 * answer the same input two different ways. Every cell runs to the end: a violation is recorded and the run goes on, because the second finding
 * is as valuable as the first.
 *
 * Two things make the named cells worth reading. Every size is exact: a prompt that says 36,000 tokens is 36,000 tokens of what pi-tuck counts,
 * so a cell cannot report a state it never reached. And the scripted provider counts the way a dense tokenizer does — the guard's measure times
 * the density the cell declares — and refuses a request whose count passes its own window, so density above 1 is tested against the window and
 * Pi's overflow recovery runs. Each named cell then proves at the end that it reached the state its name claims; one that did not is recorded as
 * `hollow`, because a cell that never cuts proves nothing whether or not it found a violation. The coverage line under the summary says how much
 * of the grid actually cut.
 *
 * It is off unless STRESS is set, so the normal suite does not slow down:
 *
 *   STRESS=1 npx vitest run test/stress
 *   STRESS=1 STRESS_CELLS=20 STRESS_REPORT=1 npx vitest run test/stress
 *
 * STRESS_CELLS changes the size of the sampled grid, STRESS_SEED moves it, STRESS_REPORT writes the failures to test/stress/failures.json,
 * STRESS_TRACE="a piece of a cell name" prints what happened to each of that cell's prompts, and STRESS_STRICT=1 turns the table into a failing
 * run. Without STRESS_STRICT the run reports: a finding is a finding whether or not it is fixed yet, and the grid keeps running after the first.
 */
import { afterAll, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { est, harness, nonSystem, type Options } from '../budget-fixture';

const RUN = /^(1|true|yes)$/i.test(process.env.STRESS ?? '');
const CELLS = Math.max(1, Number(process.env.STRESS_CELLS) || 200);
const SEED = (Number(process.env.STRESS_SEED) || 0x5eed) >>> 0;
const REPORT = process.env.STRESS_REPORT;
/** Make the table a gate. Off by default, so a known finding does not turn every run red before it is fixed. */
const STRICT = /^(1|true|yes)$/i.test(process.env.STRESS_STRICT ?? '');
/** Trace one cell by a piece of its name: STRESS_TRACE="cell 1" prints what happened to each of its prompts. */
const TRACE = process.env.STRESS_TRACE;
/** Run only the cells whose name contains this, to work one finding at a time: STRESS_ONLY="keepRecent 2x". */
const ONLY = process.env.STRESS_ONLY;
/** No single prompt or tool result is bigger than this: a 1M-token string would spend the run on text generation rather than on settings. */
const CAP = 120_000;
/** A prompt that has not ended by now is stuck: the turn is aborted, the cell records it, and the session is asked to carry on. A cell whose
 * conversation runs to two million tokens spends real seconds counting it, so this is generous on purpose. */
const PROMPT_MS = 60_000;

/** The fixture's model, which every cell that does not name another goes out on. */
const DEFAULT_API = 'openai-codex-responses (openai-codex/gpt-6.1-sol)';

type Rule = 'stuck' | 'window' | 'summary-room' | 'refusal' | 'notice' | 'no-recovery' | 'determinism' | 'harness' | 'hollow';
type Failure = { cell: string; rule: Rule; message: string; params: Record<string, unknown> };
const failures: Failure[] = [];
const ran: string[] = [];
/** What the grid actually reached, so a run that cut nothing is visible as one that tested nothing. */
const cov = { cells: 0, room: 0, cut: 0, cuts: 0, answered: 0, refused: 0, aboveRoom: 0, overflows: 0 };
/** Coverage describes a cell, not a run of it: outside STRESS_STRICT every named cell runs three times, and the re-runs are a second opinion on the
 * same settings rather than new ground, so only the first run of each name counts here. */
const covCounted = new Set<string>();
/** Every model API the run went out on, so the summary says which ones the numbers came from. */
const apis = new Set<string>();
/** The report goes to stderr: a reporter that hides a passing test's stdout must still show the summary line and the table of failures. */
const report = (line: string) => { process.stderr.write(`${line}\n`); };

/** Everything a cell can be asked about after it ran, measured rather than intended. */
interface Evidence {
 window: number;
 /** The reserve the session must hold: the setting or the model's output cap, whichever is larger. */
 reserve: number;
 room: number;
 /** What the provider's usage implies about pi-tuck's count, floored at 1. */
 factor: number;
 /** What a request costs before any conversation: the system part, the tools and the host's view. */
 floor: number;
 /** What the session held before its first prompt, in tokens: a seeded summary or a reopened history. */
 savedStart: number;
 /** The roles of those saved messages, so a cell can prove it holds a cut's summary and nothing else. */
 savedRoles: string[];
 /** Every request that went out, measured by the guard, in order. */
 guard: number[];
 /** What the provider charged for each of those requests, and whether a reply had reported usage by then. */
 counts: { count: number; known: boolean }[];
 /** Every context build as Pi would put it on the wire, with the requests answered before it. */
 probes: { after: number; at: string; queued: number; complete: number }[];
 /** Tokens of each prompt sent and each tool result produced, as counted, not as asked for. */
 prompts: number[];
 results: number[];
 /** Requests each prompt got out, in order: a prompt of zero asked for nothing, which is what a refusal looks like from outside. */
 requests: number[];
 /** Compactions this cell saved, run-end cuts included. */
 cuts: number;
 answered: number;
 refused: number;
 /** Prompts the run had to abort, and aborts an extension asked for. */
 hung: number;
 aborts: number;
 /** Requests the provider refused for exceeding its own window, vetoes of `session_before_compact`, and replies that reported no usage. */
 overflows: number;
 vetoes: number;
 nonFinite: number;
 notices: number;
 faults: number;
 /** What a prompt threw inside the host, for the case that is about the host refusing before pi-tuck is asked anything. */
 threw: string;
}

/** A named cell's claim about its own run: the state it says it reached, and the arithmetic that shows it did. */
type Reached = { state: string; check: (e: Evidence) => boolean };

interface Cell {
 name: string;
 window: number;
 /** pi-tuck's reserve setting; the room is the window less the larger of this and the model's output cap. */
 reserve: number;
 keepRecent: number;
 /** The model's own maximum reply length. */
 maxTokens: number;
 /** What the provider reports as input usage, as a multiple of pi-tuck's estimate: the tokenizer's density. */
 usageRatio?: number;
 system: number;
 host: number;
 prompts: number[];
 rounds: number[];
 results: number[];
 /** Why a refusal is legitimate here. Only a case named below may set it. */
 why?: string;
 /** Which model API the run went out on. The fixture's model answers every sampled cell; a case that names another says which. */
 api?: string;
 /** The prompt whose run's last request never answers: the turn not ending is the state under test, and recovery is the rule. The cell names the
  * prompt; which request that is follows from the run's tool rounds, unless the cell names the request itself. Only that prompt gets the shorter
  * turn budget, and only its hang is expected. */
 stallPrompt?: number;
 abortAfter?: number;
 /** A state the host itself cannot carry: the prompt throws inside Pi before pi-tuck is asked anything. The cell asserts that Pi said this and
 * that pi-tuck did not fault, and the rules a working session is held to are not applied to it. */
 hostFault?: string;
 /** The state this cell exists to exercise. Without it the cell can pass having tested nothing, which is worse than failing. */
 reached?: Reached;
 extra?: Partial<Options>;
}

const base = (name: string, over: Partial<Cell>): Cell => {
 const cell: Cell = {
  name, window: 32_768, reserve: 2_048, keepRecent: 0, maxTokens: 2_048, system: 800, host: 200,
  prompts: [200, 600, 1_200, 200], rounds: [0, 1, 0, 0], results: [300, 900], ...over,
 };
 // A stalled run: each prompt takes one request and each of its tool rounds another, so the request that would answer the stall prompt is its run's
 // last one. The fixture stalls requests by number, so a cell names the prompt and this works out which request that is.
 if (cell.stallPrompt !== undefined) {
  const at = cell.stallPrompt - 1;
  const last = 1 + cell.prompts.slice(0, at).reduce((ahead, _, i) => ahead + 1 + (cell.rounds[i] ?? 0), 0) + (cell.rounds[at] ?? 0);
  cell.extra = { ...cell.extra, neverEnds: cell.extra?.neverEnds ?? (request => request === last) };
 }
 return cell;
};

/** A fixed generator, so the grid is the same grid on every machine and every run. */
function rng(seed: number) {
 let s = seed >>> 0;
 const next = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
 const log = (lo: number, hi: number) => Math.exp(Math.log(Math.max(1, lo)) + next() * (Math.log(Math.max(1, hi)) - Math.log(Math.max(1, lo))));
 return { next, log, uniform: (lo: number, hi: number) => lo + next() * (hi - lo), int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)) };
}

/** One cell of the sampled grid. */
function sample(i: number): Cell {
 const r = rng(SEED + i * 7919);
 const window = Math.round(r.log(8_000, 1_000_000));
 const reserve = r.next() < 0.05 ? 0 : Math.round(r.log(1, window));
 const maxTokens = Math.round(r.log(1_000, 2 * window));
 const room = Math.max(0, window - Math.max(reserve, maxTokens));
 const keepRecent = Math.round(r.uniform(0, 2 * room));
 const usageRatio = Number(r.uniform(0.7, 1.5).toFixed(3));
 // The system part and the host's view scale with the window: a fixed 12,000-token prompt would leave a 4,000-token window nothing to test.
 const system = Math.min(12_000, Math.max(200, Math.round(window * 0.08)));
 const host = Math.min(6_000, Math.max(50, Math.round(window * 0.03)));
 const sizes = [0.02, 0.2, 0.55, 1.15, 0.03, 0.35].map(f => Math.max(20, Math.min(CAP, Math.round(room * f))));
 const rounds = [0, 1, 2, 0, 1, 3].map(k => Math.max(0, k + r.int(-1, 1)));
 const results = [0.05, 0.15, 0.3].map(f => Math.max(20, Math.min(CAP, Math.round(room * f))));
 return {
  name: `cell ${i} (window ${window}, reserve ${reserve}, keepRecent ${keepRecent}, maxTokens ${maxTokens}, usage ${usageRatio})`,
  window, reserve, keepRecent, maxTokens, usageRatio, system, host, prompts: sizes, rounds, results,
  // With no room at all, nothing but a refusal is possible, and the rules below say so by arithmetic rather than by exemption.
  why: room <= 0 ? 'the reserve and the output cap leave no room at all' : undefined,
 };
}

type Harness = Awaited<ReturnType<typeof harness>>;

/** The last exception a prompt threw, for the one case that is about the host throwing. Cells run one at a time. */
let lastThrew = '';

/** Send one prompt and wait for the turn to end. A turn that never ends is aborted, and the caller is told which happened. */
async function drive(h: Harness, body: string, ms: number): Promise<'ended' | 'hung'> {
 lastThrew = '';
 const run = (async () => { try { await h.session.prompt(body); } catch (e) { lastThrew = String(e); /* a prompt that throws still ends the turn; the rules read the requests, not the exception */ } })();
 const hung = await Promise.race([run.then(() => false), new Promise<boolean>(resolve => { const timer = setTimeout(() => resolve(true), ms); timer.unref?.(); })]);
 if (!hung) return 'ended';
 try { await h.session.abort(); } catch { /* the abort is the point, not its outcome */ }
 return 'hung';
}

/** What a run is compared on: a summary quotes entry ids and stamps, and those are fresh every run and say nothing about what pi-tuck decided. */
const stripTimes = (s: string) => s.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, 'T').replace(/\b01[0-9A-HJKMNP-TV-Z]{24}\b/g, 'ID').replace(/\b[0-9A-HJKMNP-TV-Z]{26}\b/g, 'ID');

/** Run one cell: six prompts of mixed size with tool rounds of mixed result size, and every rule applied as it goes. */
async function runCell(cell: Cell): Promise<Run> {
 const t0 = Date.now();
 const reserve = Math.max(cell.reserve, cell.maxTokens);
 const room = cell.window - reserve;
 // A non-finite usage number is no observation at all, so it counts as 1.
 const factor = Number.isFinite(cell.usageRatio) ? Math.max(1, cell.usageRatio!) : 1;
 let startReq = 0, roundEnd = 0;
 const h = await harness({
  at: 'prompt', complete: Math.max(2_000, cell.window), host: cell.host, noHistory: true, oneTurn: true, system: cell.system,
  limits: { contextWindow: cell.window, maxTokens: cell.maxTokens },
  reserveTokens: cell.reserve, keepRecent: cell.keepRecent, usageRatio: cell.usageRatio,
  // The provider counts by its own tokenizer and holds its window: a request whose count passes it comes back as an overflow, not an answer.
  rejectOverWindow: true,
  toolCalls: request => request > startReq && request <= roundEnd,
  toolResultTokens: call => cell.results[(call - 1) % cell.results.length] ?? 100,
  ...cell.extra,
 });
 const guard: number[] = [], summaries: string[] = [], stops: string[] = [], counts: { count: number; known: boolean }[] = [];
 const promptSizes: number[] = [], resultSizes: number[] = [], threw: string[] = [], promptRequests: number[] = [];
 // Compactions this cell saved, run-end cuts included: a cut that closes a run is still a cut the session keeps.
 const cutStart = h.manager.getEntries().filter(e => e.type === 'compaction').length;
 const savedCuts = () => h.manager.getEntries().filter(e => e.type === 'compaction').length - cutStart;
 let answered = 0, refused = 0, hung = 0, cuts = 0;
 if (TRACE && cell.name.includes(TRACE)) report(`trace cell ${cell.name}: window=${cell.window} reserve=${cell.reserve} keepRecent=${cell.keepRecent} maxTokens=${cell.maxTokens} usage=${cell.usageRatio} system=${cell.system} host=${cell.host} prompts=${JSON.stringify(cell.prompts)} rounds=${JSON.stringify(cell.rounds)} results=${JSON.stringify(cell.results)}`);
 try {
  // What a request costs before any conversation: the system part, the tools and the host's view. A cut removes conversation, never this.
  const floor = h.mandatory + nonSystem([h.hostInput()]);
  // The state the cell starts from, before its first prompt: a seeded summary, a reopened history, or nothing.
  const savedStart = nonSystem(h.saved());
  const savedRoles = h.saved().map(m => m.role);
  const probeStart = h.probes.length;
  for (let i = 0; i < cell.prompts.length; i++) {
   // Exactly the size the cell names: a prompt that says 36,000 tokens is 36,000 tokens of what pi-tuck counts.
   const body = h.sized(Math.max(20, Math.min(CAP, cell.prompts[i] ?? 100)));
   const tokens = est({ role: 'user', content: body, timestamp: 0 });
   promptSizes.push(tokens);
   const ms = cell.stallPrompt === i + 1 ? cell.abortAfter ?? 1_500 : PROMPT_MS;
   startReq = h.state.requests; roundEnd = startReq + (cell.rounds[i] ?? 0);
   const seen = { requests: h.state.requests, notices: h.notices.length, faults: h.faults.length, guard: h.guard.length, stops: h.state.stops.length, results: h.state.results.length, counts: h.state.counts.length };
   const outcome = await drive(h, body, ms);
   threw.push(lastThrew);
   const requests = h.state.requests - seen.requests;
   // Every request has exactly one context build before it, and both lists grow in order, so the first `requests` measures are the requests that
   // went out. A build that never became a request was refused before it was sent, and so cannot have exceeded the window.
   const sent = h.guard.slice(seen.guard, seen.guard + requests);
   const peak = sent.length ? Math.max(...sent) : 0;
   guard.push(...sent);
   const charged = h.state.counts.slice(seen.counts, seen.counts + requests);
   counts.push(...charged);
   promptRequests.push(requests);
   resultSizes.push(...h.state.results.slice(seen.results));
   // The turn answered if an assistant message this turn produced ended normally: a tool round ends with toolUse, the last message of the whole
   // session can belong to an earlier prompt, and a cut can drop messages, so the message's own time is what ties it to this turn.
   const stopped = h.state.stops.slice(seen.stops);
   const stoppedLast = stopped.at(-1);
   stops.push(outcome === 'hung' ? 'hung' : stoppedLast ?? 'none');
   if (outcome === 'hung') hung++;
   if (outcome === 'hung' && cell.stallPrompt !== i + 1) record(cell, 'stuck', `prompt ${i + 1} never ended; the turn was aborted after ${ms} ms`, { prompt: i + 1, tokens });
  // What the session said when it refused: the notice the operator saw and the fault pi-tuck recorded.
  const said = `${h.notices.slice(-1).join(' | ').slice(0, 120) || 'no notice'} / ${h.faults.slice(-1).join(' | ').slice(0, 90) || 'no fault'}`;
   if (requests > 0 && peak + reserve > cell.window) record(cell, 'window', `a request of ${peak} tokens plus the reserve of ${reserve} exceeds the window of ${cell.window}: ${said}`, { prompt: i + 1, peak });
   // The provider's own count is what its window is measured in. Once a reply has reported a finite input, the density behind that count is a fact
   // of the session and not a guess, so a request the provider will not take is the guard's failure to hold the window. Before any reply has
   // reported usage the count is only what this cell declared, and only the recovery rules apply.
   for (const [n, c] of charged.entries()) {
    if (c.known && c.count > cell.window) record(cell, 'window', `the provider counted request ${seen.counts + n + 1} at ${c.count} tokens against its window of ${cell.window} (measured ${sent[n]} at factor ${factor.toFixed(3)}), so it refused the request: ${said}`, { prompt: i + 1, count: c.count, measured: sent[n] });
   }
   // A refusal is a turn that asked for nothing or ended without an answer, other than one the cell stalled on purpose.
  const wasRefused = outcome !== 'hung' && (requests === 0 || !stopped.includes('stop'));
   if (wasRefused) refused++; else answered++;
   if (cell.hostFault) {
   if (!lastThrew.includes(cell.hostFault)) record(cell, 'harness', `the host was expected to refuse this state with "${cell.hostFault}", but the prompt ${lastThrew ? `said "${lastThrew.slice(0, 140)}"` : 'ended quietly'}`);
   if (h.faults.length > seen.faults) record(cell, 'refusal', `pi-tuck faulted in a state the host itself cannot carry: ${h.faults.at(-1)}`);
  }
  if (!cell.hostFault && wasRefused && h.notices.length === seen.notices) record(cell, 'notice', `prompt ${i + 1} was refused (stop ${stopped.join(',') || 'none'}, ${requests} requests) with no notice to the operator`, { prompt: i + 1, tokens, requests });
  // The prompt alone fits the room when the request it would make, at the reserve the session must hold and the counting factor the provider's
  // own usage implies, stays inside the window. The turn's own tool results count too: a cut never drops the prompt it answers or a result that
  // has not reached the model yet, so a run whose turn is bigger than the room is refused whatever the prompt alone weighs.
  const carried = h.state.results.slice(seen.results).reduce((a, b) => a + b, 0);
   // The smallest request that can answer this prompt: the mandatory part, the prompt, the results the turn already holds, and a summary that
   // quotes the prompt verbatim as its contract requires, with room for its headings and counts. If that fits the room, refusing is not the last
   // resort: some cut could have carried it.
  const smallest = floor + 2 * tokens + carried + 200 + Math.floor(room * 0.05);
  const fitsAlone = Math.ceil(smallest * factor) + reserve < cell.window - 64;
   if (!cell.hostFault && wasRefused && fitsAlone && !cell.why) record(cell, 'refusal', `prompt ${i + 1} of ${tokens} tokens was refused although the smallest request that answers it fits the room (${smallest} of a room of ${room}, factor ${factor.toFixed(2)}, prompt ${tokens}, carried ${carried}, floor ${floor}): ${said}`, { prompt: i + 1, tokens, carried, floor, smallest, room, factor });
   if (!cell.hostFault && (wasRefused || outcome === 'hung')) {
    // Nothing may leave a session unable to take the next prompt: a short one has to get through, when the room can hold it at all — which
    // means beside the conversation the failure left behind, not only beside the prompt.
    const left = nonSystem(h.saved());
    if (Math.ceil((floor + left + 60) * factor) + reserve < cell.window - 64) {
     startReq = h.state.requests; roundEnd = startReq;
     const again = await drive(h, h.sized(60), ms);
     if (again === 'hung' || h.state.requests === startReq) record(cell, 'no-recovery', `a short prompt after prompt ${i + 1} got no request either`, { prompt: i + 1, stop: stoppedLast ?? 'none' });
    }
   }
   for (const cut of h.compactions().slice(cuts)) {
    const tokens = est({ role: 'compactionSummary', summary: cut.summary, tokensBefore: 0, timestamp: 0 });
    if (tokens + reserve > cell.window) record(cell, 'summary-room', `a saved summary of ${tokens} tokens does not fit the room of ${room}`, { prompt: i + 1, summary: tokens, room });
    summaries.push(cut.summary);
   }
   cuts = h.compactions().length;
   if (TRACE && cell.name.includes(TRACE)) report(`trace p${i + 1}: tokens=${tokens} requests=${requests} stop=${stopped.join(',') || 'none'} peak=${peak} floor=${floor} room=${room} cuts=${savedCuts()} notice=${h.notices.length} counts=${JSON.stringify(charged)} probes=${JSON.stringify(h.probes.slice(probeStart))} threw=${lastThrew.slice(0, 900)} ${(h.faults.at(-1) ?? 'no fault').slice(0, 500)}`);
  }
  // The cell's own claim, read off what happened rather than what was asked for. A cell that never reached its state tested nothing, and that is
  // a finding about the test: it is recorded so it cannot hide behind a clean table.
  if (cell.reached) {
   const e: Evidence = {
    window: cell.window, reserve, room, factor, floor, savedStart, savedRoles, guard, counts,
    probes: h.probes.slice(probeStart), prompts: promptSizes, results: resultSizes, requests: promptRequests, cuts: savedCuts(),
    answered, refused, hung, aborts: h.state.aborts, overflows: h.state.overflows, vetoes: h.state.vetoes,
    nonFinite: h.state.nonFinite, notices: h.notices.length, faults: h.faults.length, threw: threw.filter(Boolean).join(' | '),
   };
   if (!cell.reached.check(e)) {
    const numbers = `room=${room} floor=${floor} saved=${savedStart} prompts=${JSON.stringify(promptSizes)} results=${JSON.stringify(resultSizes)} guard=${JSON.stringify(guard)} probes=${JSON.stringify(e.probes)} cuts=${e.cuts} answered=${answered} refused=${refused} hung=${hung} aborts=${e.aborts} overflows=${e.overflows} vetoes=${e.vetoes} counts=${JSON.stringify(counts)}`;
    record(cell, 'hollow', `the run never reached the state the cell names (${cell.reached.state}): ${numbers}`, { room, floor, savedStart, cuts: e.cuts });
   }
   if (TRACE && cell.name.includes(TRACE)) report(`trace reached ${cell.reached.check(e)}: ${cell.reached.state} ms=${Date.now() - t0}`);
  }
  cuts = savedCuts();
 } finally { await h.cleanup(); }
 const summary = { cells: 1, room: room > 0 ? 1 : 0, cut: cuts > 0 ? 1 : 0, cuts, answered, refused, aboveRoom: h.probes.filter(p => p.at === 'prompt' && p.complete > room).length, overflows: h.state.overflows };
 if (!covCounted.has(cell.name)) { covCounted.add(cell.name); cov.cells++; cov.room += summary.room; cov.cut += summary.cut; cov.cuts += summary.cuts; cov.answered += answered; cov.refused += refused; cov.aboveRoom += summary.aboveRoom; cov.overflows += summary.overflows; }
 const summariesText = summaries.map(stripTimes).join('\n');
 const payload = JSON.stringify({ guard, stops, summariesText, faults: h.faults, notices: h.notices });
 return { digest: createHash('sha256').update(payload).digest('hex').slice(0, 16), guard, stops, summariesText, faults: [...h.faults], notices: [...h.notices] };
}

/** What one run of a cell is held to: the sizes it asked the model with, the answers it got, what it saved and what it said. */
interface Run { digest: string; guard: number[]; stops: string[]; summariesText: string; faults: string[]; notices: string[] }

/** Two runs of one cell match when every quantity agrees. A saved summary quotes entry ids, and those are fresh every run, so a count may move
 * by a few tokens; anything larger is the same input giving a different answer. */
function divergence(a: Run, b: Run): string | undefined {
 if (a.guard.length !== b.guard.length) return `the two runs asked ${a.guard.length} and ${b.guard.length} requests`;
 const worst = a.guard.map((v, i) => Math.abs(v - b.guard[i]!));
 const at = worst.indexOf(worst.length ? Math.max(...worst) : 0);
 if (at >= 0 && worst[at]! > 4) return `request ${at + 1} measured ${a.guard[at]} tokens against ${b.guard[at]} tokens`;
 if (a.stops.join(',') !== b.stops.join(',')) return `the two runs were answered ${a.stops.join(',')} and ${b.stops.join(',')}`;
 if (a.summariesText !== b.summariesText) {
  let at = 0; while (at < a.summariesText.length && at < b.summariesText.length && a.summariesText[at] === b.summariesText[at]) at++;
  return `they saved different summaries ("${a.summariesText.slice(Math.max(0, at - 50), at + 70)}" against "${b.summariesText.slice(Math.max(0, at - 50), at + 70)}")`;
 }
 if (a.faults.join('|') !== b.faults.join('|')) return `they faulted differently (${a.faults.length} against ${b.faults.length})`;
 if (a.notices.join('|') !== b.notices.join('|')) return `they told the operator different things (${a.notices.length} against ${b.notices.length})`;
 return undefined;
}

function record(cell: Cell, rule: Rule, message: string, params: Record<string, unknown> = {}) {
 failures.push({ cell: cell.name, rule, message, params: { api: cell.api ?? DEFAULT_API, ...params } });
 if (failures.length <= 60) report(`FAIL [${rule}] ${cell.name}: ${message}`);
}

/** The named states, each one run whatever the grid samples. Each says what it exists to exercise and proves at the end that it got there. */
function namedCells(): Cell[] {
 const roomOf = (c: Pick<Cell, 'window' | 'reserve' | 'maxTokens'>) => c.window - Math.max(c.reserve, c.maxTokens);
 const overRoomWindow = { window: 32_768, reserve: 4_096, maxTokens: 4_096 };
 const cutAtLeast = (what: string): Reached => ({ state: `${what}: at least 1 cut saved`, check: e => e.cuts >= 1 });
 // A cut removes conversation and nothing else, and it is saved only when the summary it writes lands the request at or below the band, 0.6 of the
 // room (src/budget.ts: gateCut asks at the band, chooseCut keeps cutting while the request stays above it). So a cell that must cut keeps its
 // prompts small and grows the conversation with tool results: `grow` lays out a conversation of the given size, as a fraction of the room, that
 // crosses the band on any window while leaving the summary room to fit under it.
 const grow = (room: number, conversation: number) => {
  const unit = Math.max(240, Math.round(room * conversation));
  const piece = (f: number) => Math.max(60, Math.min(CAP, Math.round(unit * f)));
  const prompts = [0.05, 0.15, 0.2, 0.05, 0.15, 0.05].map(piece);
  const rounds = [0, 1, 2, 0, 1, 0];
  const results = [0.2, 0.15].map(piece);
  // A very large room holds more conversation than six prompts and two results can carry at CAP each, so the run keeps prompting until the
  // conversation it names is on the session.
  let left = unit - prompts.reduce((a, b) => a + b, 0) - results.reduce((a, b) => a + b, 0);
  while (left > CAP / 2) { prompts.push(CAP); rounds.push(0); left -= CAP; }
  return { prompts, rounds, results };
 };
 // Pi's own defaults: a reserve of 16,384 and a keep-recent of 20,000. The conversation has to grow past the band (0.6 of the room) for a cut to
 // be asked for at all, so the prompts and results are fractions of the room and the run carries enough of them to cross it.
 // The last of those runs is aborted instead of answered, and an aborted run gets no run-end cut, so the prompt after it starts from whatever the
 // dead run left. This is the live shape: at these defaults the room (16,384) is smaller than pi-tuck's keep-recent (20,000), so a conversation just
 // over the room is one Pi's own cut finder has nothing to cut. To land the session in that band the dying run streams a reply before its transport
 // goes quiet — an aborted message is saved with what arrived, and no boundary follows an abort to tidy it away.
 const atDefaults = (window: number): Cell => {
  const room = roomOf({ window, reserve: 16_384, maxTokens: 8_192 });
  const g = grow(room, 1.08);
  const c = base(`defaults at ${window} (reserve 16384, keepRecent 20000)`, {
   window, reserve: 16_384, keepRecent: 20_000, maxTokens: 8_192, system: 1_500, host: 600,
   prompts: [...g.prompts, 300], rounds: [...g.rounds, 0], results: g.results,
   stallPrompt: g.prompts.length,
   extra: { stallChars: room < 20_000 ? () => Math.round(room * 0.62) : undefined },
  });
  return { ...c, reached: { state: `a conversation at pi-tuck's defaults inside a room of ${roomOf(c)} left above it by an aborted run: at least 1 cut saved`, check: e => e.cuts >= 1 && e.hung + e.aborts >= 1 } };
 };
 // The room is what the conversation is sized against: 0.62 of it, so the history crosses the band whatever the window. No single text may pass
 // CAP, so a room this large is filled by more prompts rather than by one impossible one.
 const big = (window: number): Cell => {
  const c = base(`very large window ${window}`, {
   window, reserve: 32_768, maxTokens: 32_768, system: 12_000, host: 6_000, keepRecent: 20_000,
   ...grow(roomOf({ window, reserve: 32_768, maxTokens: 32_768 }), 1.05),
  });
  return { ...c, reached: cutAtLeast(`a conversation of ${c.prompts.reduce((a, b) => a + b, 0) + c.results.reduce((a, b) => a + b, 0)} tokens inside a room of ${roomOf(c)}`) };
 };
 // Pi's own cut finder keeps the last keepRecentTokens and has nothing to cut when those are the whole conversation; pi-tuck plans its own cut and
 // is not bound by that bound, so a keep-recent as large as the room must still end in a saved cut.
 const keepAt = (over: number): Cell => {
  const c = base(`keepRecent ${over}x the free room`, { window: 40_000, reserve: 4_000, maxTokens: 2_000, system: 1_000, host: 300, keepRecent: 0, ...grow(roomOf({ window: 40_000, reserve: 4_000, maxTokens: 2_000 }), 1.08) });
  return { ...c, keepRecent: Math.round(roomOf(c) * over), reached: cutAtLeast(`a keep-recent of ${Math.round(roomOf(c) * over)} tokens, ${over}x the room of ${roomOf(c)}`) };
 };
 const promptOverRoom = base('prompt bigger than the room, smaller than the window', {
  window: 32_768, reserve: 4_096, maxTokens: 4_096, system: 800, host: 200, why: 'the prompt alone is bigger than the room',
  prompts: [300, roomOf(overRoomWindow) + 800, 300], rounds: [0, 0, 0], results: [300],
  reached: { state: `a prompt above the room of ${roomOf(overRoomWindow)} that Pi takes without a word`, check: e => e.prompts.length > 1 && e.prompts[1]! > e.room && e.prompts[1]! < e.window && e.threw === '' },
 });
 const promptOverWindow = base('prompt bigger than the window', {
  window: 32_768, reserve: 4_096, maxTokens: 4_096, system: 800, host: 200, why: 'the prompt alone is bigger than the window',
  // At the size the cell names, pi-tuck's own gate is the one that speaks: the request this prompt would make cannot fit the window beside the
  // reserve, so nothing goes out and the operator is told. Pi's context limit is a second gate, behind this one.
  prompts: [300, 36_000, 300], rounds: [0, 0, 0], results: [300],
  reached: { state: 'a prompt above the window of 32768 that the session will not carry', check: e => e.prompts.length > 1 && e.prompts[1]! > e.window && e.requests.length > 1 && e.requests[1] === 0 },
 });
 const resultOverWindow = base('tool result bigger than the window', {
  window: 32_768, reserve: 4_096, maxTokens: 4_096, system: 800, host: 200, why: 'a tool result bigger than the window arrives in the middle of a run',
  prompts: [300, 600, 300], rounds: [1, 1, 0], results: [34_000, 400],
  reached: { state: 'a tool result above the window of 32768', check: e => e.results.length > 0 && Math.max(...e.results) > e.window },
 });
 const reopened = base('reopened session saved above the room', {
  window: 32_768, reserve: 4_096, maxTokens: 4_096, system: 800, host: 200,
  prompts: [300, 3_000, 200, 1_200], rounds: [0, 1, 0, 0], results: [400],
  extra: { reopen: true, noHistory: false, complete: 32_000, history: 30_000 },
  reached: { state: 'a session reopened from 30000 saved tokens, above the room of 28672', check: e => e.savedStart > e.room },
 });
 const aborted = base('aborted turn, then a prompt', {
  window: 32_768, reserve: 4_096, maxTokens: 4_096, system: 800, host: 200, abortAfter: 1_500, stallPrompt: 2,
  prompts: [300, 800, 400], rounds: [0, 1, 0], results: [400],
  // This run stalls as it starts, before its tool round, which is not where the derived request would fall.
  extra: { neverEnds: request => request === 2 },
  reached: { state: 'a request that never answered and was aborted', check: e => e.hung + e.aborts >= 1 },
 });
 const stalled = base('first request never answers, aborted by a timer', {
  window: 32_768, reserve: 4_096, maxTokens: 4_096, system: 800, host: 200, abortAfter: 1_500, stallPrompt: 1,
  prompts: [400, 400], rounds: [0, 0], results: [300],
  reached: { state: 'a first request that never answered and was aborted', check: e => e.hung + e.aborts >= 1 },
 });
 // The live refusal did not reproduce on openai-codex-responses, so the same state runs on both APIs and each run says which one it used. It ran
 // at the live settings: a 32,768 window holding 16,384 back for the response, 9,000 tokens of thinking replayed on a tool call, and a history
 // that takes the next request — the one that carries the thinking back — past the room of 16,384.
 const reasoning = (api: string, model?: { provider: string; id: string }): Cell => {
  const which = model ? `${model.provider}/${model.id}` : 'openai-codex/gpt-6.1-sol';
  return base(`36000 characters of thinking replayed at a 32k window (${api})`, {
   window: 32_768, reserve: 16_384, maxTokens: 8_192, system: 1_200, host: 300, api: `${api} (${which})`,
   prompts: [4_000, 3_000, 400, 300], rounds: [1, 1, 0, 0], results: [2_000, 800],
   extra: { thinkingChars: request => (request === 1 || request === 2 ? 36_000 : 0), ...(model ? { model } : {}) },
   reached: { state: 'the request after a 9000-token thinking reply above the room of 16384', check: e => e.probes.some(p => p.after >= 1 && p.complete > e.room) },
  });
 };
 const small = (() => {
  const c = base('tiny window 4000', { window: 4_000, reserve: 500, maxTokens: 500, system: 300, host: 100, ...grow(roomOf({ window: 4_000, reserve: 500, maxTokens: 500 }), 1.05) });
  return { ...c, reached: cutAtLeast('a conversation inside a room of 3500') };
 })();
 const tiny = (() => {
  const c = base('tiny window 8000', { window: 8_000, reserve: 1_000, maxTokens: 1_000, system: 500, host: 150, ...grow(roomOf({ window: 8_000, reserve: 1_000, maxTokens: 1_000 }), 1.05) });
  return { ...c, reached: cutAtLeast('a conversation inside a room of 7000') };
 })();
 const outputAboveRoom = base('output cap above the room', {
  window: 32_768, reserve: 2_048, maxTokens: 40_000, system: 800, host: 200, why: 'the model cannot answer inside the window, so nothing fits',
  prompts: [300, 800, 300], rounds: [0, 1, 0], results: [400],
  reached: { state: 'an output cap of 40000 that leaves no room inside a window of 32768', check: e => e.room <= 0 },
 });
 const usage = (label: string, usageRatio?: number, over?: Partial<Cell>): Cell => base(`provider usage: ${label}`, {
  window: 32_768, reserve: 4_096, maxTokens: 4_096, system: 800, host: 200, usageRatio,
  prompts: [300, 2_000, 6_000, 300, 1_000, 400], rounds: [0, 1, 2, 0, 1, 0], results: [500, 1_500], ...over,
 });
 // t03-24: a cut kept only its summary, and the next prompt fits the room alone but not beside that summary. The calibration factor is 1.29.
 const t0324 = base('t03-24: summary alone, then a prompt that fits only without it (factor 1.29)', {
  window: 32_768, reserve: 16_384, maxTokens: 8_192, system: 1_200, host: 300, usageRatio: 1.29,
  prompts: [3_000, 400, 300], rounds: [0, 0, 0], results: [300],
  extra: { summary: true, summaryOnly: true, summaryTokens: 21_600 },
  reached: {
   state: 'a saved cut that kept only its summary, with a prompt that fits the room of 16384 alone but not beside it',
   check: e => e.savedRoles.length === 1 && e.savedRoles[0] === 'compactionSummary' && e.probes.length > 0 && e.probes[0]!.complete > e.room && e.floor + e.prompts[0]! + e.reserve < e.window,
  },
 });
 // Pi asks for a compaction on its own when a reply reports usage above the window less its reserve (28,672 here). pi-tuck plans a cut from its own
 // measure, corrected by the factor it has learned from reported usage, above 0.6 x that room (17,203). Once that factor has ratcheted, pi-tuck cuts
 // long before Pi's threshold, so the only request whose size Pi learns about first is the very first one, counted at factor 1. A provider that counts
 // 1.9x the measure puts that request in the gap: 15,400 of prompt plus the 712-token floor is 16,112 measured, under pi-tuck's band, and 30,613 real,
 // above Pi's threshold and under its own window. The request to compact is then Pi's, and another extension's veto is what answers it.
 const veto = base('another extension vetoes session_before_compact', {
  window: 32_768, reserve: 4_096, maxTokens: 4_096, system: 800, host: 200, usageRatio: 1.9,
  prompts: [15_400, 300, 300], rounds: [0, 0, 0], results: [], extra: { cancelCompact: true },
  reached: { state: 'session_before_compact vetoed at least once', check: e => e.vetoes >= 1 },
 });
 // The host's view is a message prepended in `context` by an extension of its own: this cell makes it large, so the conversation left to carry is
 // small and a cut has to land beside it.
 const prepend = base('another extension prepends a message in context', {
  window: 32_768, reserve: 4_096, maxTokens: 4_096, system: 800, host: 9_000,
  ...grow(roomOf({ window: 32_768, reserve: 4_096, maxTokens: 4_096 }), 1.05),
  reached: cutAtLeast('a host view of 9000 tokens carried beside the conversation'),
 });
 const boundary = base('another extension appends boundary entries at turn_end', {
  window: 32_768, reserve: 4_096, maxTokens: 4_096, system: 800, host: 200,
  ...grow(roomOf({ window: 32_768, reserve: 4_096, maxTokens: 4_096 }), 1.05), extra: { turnEndEntries: 3 },
  reached: cutAtLeast('boundary entries appended at turn_end'),
 });
 return [
  atDefaults(32_768), atDefaults(65_536), atDefaults(131_072), atDefaults(1_000_000),
  keepAt(1), keepAt(2),
  promptOverRoom, promptOverWindow, resultOverWindow, reopened, aborted,
  reasoning('openai-codex-responses'), reasoning('openai-completions', { provider: 'groq', id: 'openai/gpt-oss-120b' }),
  small, tiny, big(1_000_000), big(2_000_000), outputAboveRoom,
  // What the provider's own count does to the arithmetic: above 1 the guard's measure is too small, far above 1 it is nowhere near, below 1 it is
  // too large, and a reply that reports no usage at all leaves the session with no observation to calibrate on.
  usage('above 1', 1.15, { reached: { state: 'a provider count above pi-tuck\'s measure', check: e => e.counts.some(c => c.known && c.count > e.guard[e.counts.indexOf(c)]!) } }),
  usage('far above 1', 1.9, { ...grow(roomOf({ window: 32_768, reserve: 4_096, maxTokens: 4_096 }), 1.05), reached: cutAtLeast('a provider count of 1.9x the measure') }),
  usage('below 1', 0.8, { reached: { state: 'a provider count below pi-tuck\'s measure', check: e => e.counts.some((c, n) => c.known && c.count < e.guard[n]!) } }),
  // A provider that reports no usage at all leaves pi-tuck with no observation to calibrate on, and the host breaks on the next prompt: its
  // overflow check reads the usage object of the last reply without guarding it (pi-ai utils/overflow.js, isContextOverflow). The cell names that
  // host fault, so what is left to report is that the session never recovers from it.
  usage('no usage reported', undefined, {
   extra: { noUsage: true }, hostFault: "Cannot read properties of undefined (reading 'input')",
   prompts: [300, 2_000], rounds: [0, 1], results: [500],
   reached: { state: 'a reply that reported no usage at all', check: e => e.nonFinite >= 1 },
  }),
  usage('first reply only', 1.4, { extra: { usageFirst: 24_000 }, reached: { state: 'a first reply whose usage set the factor at 1.4', check: e => e.counts.some(c => c.known) } }),
  // The provider counts with its own tokenizer and refuses a request over its window. pi-tuck can only plan with its own measure, and the first
  // request of a session is planned before any reply has reported a usage to calibrate on, so this is the one request whose density it cannot know:
  // the provider's refusal is what Pi's single compact-and-retry runs on. The prompt is sized to fit the room (14,336) alone, so pi-tuck sends it
  // knowingly, and 1.9 times its measure is over the window.
  usage('first request above the provider window', 1.9, {
   window: 16_384, reserve: 2_048, maxTokens: 2_048, system: 600, host: 400,
   prompts: [9_000, 300], rounds: [0, 0], results: [],
   reached: { state: 'a first request the provider refused for its own count', check: e => e.overflows >= 1 },
  }),
  // t03-24: a cut kept only its summary, and the next prompt fits the room alone but not beside that summary. The calibration factor is 1.29.
  t0324, veto, prepend, boundary,
 ];
}

test(`settings stress: ${CELLS} sampled cells and the named edge cases`, async () => {
 if (!RUN) return;
 const started = Date.now();
 for (let i = 0; i < CELLS; i++) {
  const cell = sample(i);
  if (ONLY && !cell.name.includes(ONLY)) continue;
  ran.push(cell.name); apis.add(cell.api ?? DEFAULT_API);
  try { await runCell(cell); } catch (error) { record(cell, 'harness', `the cell could not run: ${String(error).slice(0, 300)}`); }
 }
 for (const cell of namedCells()) {
  if (ONLY && !cell.name.includes(ONLY)) continue;
  ran.push(cell.name); apis.add(cell.api ?? DEFAULT_API);
  try { await runCell(cell); } catch (error) { record(cell, 'harness', `the case could not run: ${String(error).slice(0, 300)}`); }
  if (STRICT) continue;
  // The determinism check runs the cell twice more and compares. It is the expensive part, so it is off under STRESS_STRICT, where the point is
  // the table of findings, not a second opinion on one build.
  const a = await runCell(cell);
  const b = await runCell(cell);
  const diff = divergence(a, b);
  if (diff) record(cell, 'determinism', `the same settings answered differently: ${diff}`);
 }
 // Every rule holds after the last cell, so a finding is reported whatever the order the cells ran in.
 if (failures.length > 60) report(`stress: ${failures.length - 60} further failures not printed above`);
 if (REPORT) mkdirSync('test/stress', { recursive: true });
 const byClass = new Map<Rule, { count: number; cells: Set<string> }>();
 for (const f of failures) { const row = byClass.get(f.rule) ?? { count: 0, cells: new Set<string>() }; row.count++; row.cells.add(f.cell); byClass.set(f.rule, row); }
 const sorted = [...byClass.entries()].sort((a, b) => b[1].count - a[1].count);
 report(`\nstress: cells run ${ran.length}, failures ${failures.length}, top failure class ${sorted[0]?.[0] ?? 'none'}`);
 // What the grid actually reached. A run that cut nothing tested nothing, and this line is where that shows.
 report(`stress: coverage: cells with room ${cov.room}/${cov.cells}, cells with a cut ${cov.cut}/${cov.cells}, total cuts ${cov.cuts}, prompts answered ${cov.answered}, prompts refused ${cov.refused}, prompts planned above the room ${cov.aboveRoom}, provider overflows ${cov.overflows}`);
 report('class           failures  cells');
 for (const [rule, row] of sorted) report(`${rule.padEnd(15)}  ${String(row.count).padStart(6)}  ${[...row.cells].slice(0, 2).join(' | ')}${row.cells.size > 2 ? ` | +${row.cells.size - 2} more` : ''}`);
 if (REPORT) {
  writeFileSync('test/stress/failures.json', JSON.stringify({ seed: SEED, cells: CELLS, ran: ran.length, coverage: cov, failures }, null, 1));
  report(`stress: wrote ${failures.length} failures to test/stress/failures.json`);
 }
 report(`stress: ran ${ran.length} cells in ${((Date.now() - started) / 1000).toFixed(1)}s on ${[...apis].join(', ')}`);
 // The assertion comes last, so the summary, the coverage line and the class table are printed even when the run is failing.
 if (STRICT) expect(failures.length, `${failures.length} rule violations; the table above`).toBe(0);
});
