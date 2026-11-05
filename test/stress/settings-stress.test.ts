/**
 * The settings stress test: real Pi, real pi-tuck, a scripted model, and settings sampled across the whole range they can take.
 *
 * A unit test asks whether one case works. This asks whether any combination of context window, response reserve, keep-recent, output cap and
 * tokenizer density can leave a session stuck, send a request over the window, save a summary that does not fit, refuse without saying why, or
 * answer the same input two different ways. Every cell runs to the end: a violation is recorded and the run goes on, because the second finding
 * is as valuable as the first.
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
/** No single prompt or tool result is bigger than this: a 1M-token string would spend the run on text generation rather than on settings. */
const CAP = 120_000;
/** A prompt that has not ended by now is stuck: the turn is aborted, the cell records it, and the session is asked to carry on. */
const PROMPT_MS = 30_000;

/** The fixture's model, which every cell that does not name another goes out on. */
const DEFAULT_API = 'openai-codex-responses (openai-codex/gpt-6.1-sol)';

type Rule = 'stuck' | 'window' | 'summary-room' | 'refusal' | 'notice' | 'no-recovery' | 'determinism' | 'harness';
type Failure = { cell: string; rule: Rule; message: string; params: Record<string, unknown> };
const failures: Failure[] = [];
const ran: string[] = [];
/** Every model API the run went out on, so the summary says which ones the numbers came from. */
const apis = new Set<string>();
/** The report goes to stderr: a reporter that hides a passing test's stdout must still show the summary line and the table of failures. */
const report = (line: string) => { process.stderr.write(`${line}\n`); };

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
 /** The case stalls a request on purpose: the turn not ending is the state under test, and recovery is the rule. */
 stalls?: boolean;
 abortAfter?: number;
 /** A state the host itself cannot carry: the prompt throws inside Pi before pi-tuck is asked anything. The cell asserts that Pi said this and
 * that pi-tuck did not fault, and the rules a working session is held to are not applied to it. */
 hostFault?: string;
 extra?: Partial<Options>;
}

const base = (name: string, over: Partial<Cell>): Cell => ({
 name, window: 32_768, reserve: 2_048, keepRecent: 0, maxTokens: 2_048, system: 800, host: 200,
 prompts: [200, 600, 1_200, 200], rounds: [0, 1, 0, 0], results: [300, 900], ...over,
});

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
 const reserve = Math.max(cell.reserve, cell.maxTokens);
 const room = cell.window - reserve;
 let startReq = 0, roundEnd = 0;
 const h = await harness({
  at: 'prompt', complete: Math.max(2_000, cell.window), host: cell.host, noHistory: true, oneTurn: true, system: cell.system,
  limits: { contextWindow: cell.window, maxTokens: cell.maxTokens },
  reserveTokens: cell.reserve, keepRecent: cell.keepRecent, usageRatio: cell.usageRatio,
  toolCalls: request => request > startReq && request <= roundEnd,
  toolResultTokens: call => cell.results[(call - 1) % cell.results.length] ?? 100,
  ...cell.extra,
 });
 const guard: number[] = [], summaries: string[] = [], stops: string[] = [];
 if (TRACE && cell.name.includes(TRACE)) console.log(`trace cell ${cell.name}: window=${cell.window} reserve=${cell.reserve} keepRecent=${cell.keepRecent} maxTokens=${cell.maxTokens} usage=${cell.usageRatio} system=${cell.system} host=${cell.host} prompts=${JSON.stringify(cell.prompts)} rounds=${JSON.stringify(cell.rounds)} results=${JSON.stringify(cell.results)}`);
 try {
  // What a request costs before any conversation: the system part, the tools and the host's view. A cut removes conversation, never this.
  const floor = h.mandatory + nonSystem([h.hostInput()]);
  let cuts = 0;
  for (let i = 0; i < cell.prompts.length; i++) {
   const body = h.text(Math.max(20, Math.min(CAP, cell.prompts[i] ?? 100)));
   const tokens = est({ role: 'user', content: body, timestamp: 0 });
   const ms = cell.abortAfter ?? PROMPT_MS;
   startReq = h.state.requests; roundEnd = startReq + (cell.rounds[i] ?? 0);
   const seen = { requests: h.state.requests, notices: h.notices.length, faults: h.faults.length, guard: h.guard.length, stops: h.state.stops.length, results: h.state.results.length };
   const outcome = await drive(h, body, ms);
   const requests = h.state.requests - seen.requests;
   // Every request has exactly one context build before it, and both lists grow in order, so the first `requests` measures are the requests that
   // went out. A build that never became a request was refused before it was sent, and so cannot have exceeded the window.
   const sent = h.guard.slice(seen.guard, seen.guard + requests);
   const peak = sent.length ? Math.max(...sent) : 0;
   guard.push(...sent);
   // The turn answered if an assistant message this turn produced ended normally: a tool round ends with toolUse, the last message of the whole
   // session can belong to an earlier prompt, and a cut can drop messages, so the message's own time is what ties it to this turn.
   const stopped = h.state.stops.slice(seen.stops);
   const stoppedLast = stopped.at(-1);
   stops.push(outcome === 'hung' ? 'hung' : stoppedLast ?? 'none');
   if (outcome === 'hung' && !cell.stalls) record(cell, 'stuck', `prompt ${i + 1} never ended; the turn was aborted after ${ms} ms`, { prompt: i + 1, tokens });
  // What the session said when it refused: the notice the operator saw and the fault pi-tuck recorded.
  const said = `${h.notices.slice(-1).join(' | ').slice(0, 120) || 'no notice'} / ${h.faults.slice(-1).join(' | ').slice(0, 90) || 'no fault'}`;
   if (requests > 0 && peak + reserve > cell.window) record(cell, 'window', `a request of ${peak} tokens plus the reserve of ${reserve} exceeds the window of ${cell.window}: ${said}`, { prompt: i + 1, peak });
   // A refusal is a turn that asked for nothing or ended without an answer, other than one the cell stalled on purpose.
  const refused = outcome !== 'hung' && (requests === 0 || !stopped.includes('stop'));
  if (cell.hostFault) {
   if (!lastThrew.includes(cell.hostFault)) record(cell, 'harness', `the host was expected to refuse this state with "${cell.hostFault}", but the prompt ${lastThrew ? `said "${lastThrew.slice(0, 140)}"` : 'ended quietly'}`);
   if (h.faults.length > seen.faults) record(cell, 'refusal', `pi-tuck faulted in a state the host itself cannot carry: ${h.faults.at(-1)}`);
  }
  if (!cell.hostFault && refused && h.notices.length === seen.notices) record(cell, 'notice', `prompt ${i + 1} was refused (stop ${stopped.join(',') || 'none'}, ${requests} requests) with no notice to the operator`, { prompt: i + 1, tokens, requests });
  // The prompt alone fits the room when the request it would make, at the reserve the session must hold and the counting factor the provider's
  // own usage implies, stays inside the window. The turn's own tool results count too: a cut never drops the prompt it answers or a result that
  // has not reached the model yet, so a run whose turn is bigger than the room is refused whatever the prompt alone weighs. A non-finite usage
  // number is no observation at all, so it counts as 1.
  const carried = h.state.results.slice(seen.results).reduce((a, b) => a + b, 0);
   const factor = Number.isFinite(cell.usageRatio) ? Math.max(1, cell.usageRatio!) : 1;
   // The smallest request that can answer this prompt: the mandatory part, the prompt, the results the turn already holds, and a summary that
   // quotes the prompt verbatim as its contract requires, with room for its headings and counts. If that fits the room, refusing is not the last
   // resort: some cut could have carried it.
  const smallest = floor + 2 * tokens + carried + 200 + Math.floor(room * 0.05);
  const fitsAlone = Math.ceil(smallest * factor) + reserve < cell.window - 64;
   if (!cell.hostFault && refused && fitsAlone && !cell.why) record(cell, 'refusal', `prompt ${i + 1} of ${tokens} tokens was refused although the smallest request that answers it fits the room (${smallest} of a room of ${room}, factor ${factor.toFixed(2)}, prompt ${tokens}, carried ${carried}, floor ${floor}): ${said}`, { prompt: i + 1, tokens, carried, floor, smallest, room, factor });
   if (!cell.hostFault && (refused || outcome === 'hung')) {
    // Nothing may leave a session unable to take the next prompt: a short one has to get through, when the room can hold it at all — which
    // means beside the conversation the failure left behind, not only beside the prompt.
    const left = nonSystem(h.saved());
    if (Math.ceil((floor + left + 60) * factor) + reserve < cell.window - 64) {
     startReq = h.state.requests; roundEnd = startReq;
     const again = await drive(h, h.text(60), ms);
     if (again === 'hung' || h.state.requests === startReq) record(cell, 'no-recovery', `a short prompt after prompt ${i + 1} got no request either`, { prompt: i + 1, stop: stoppedLast ?? 'none' });
    }
   }
   for (const cut of h.compactions().slice(cuts)) {
    const tokens = est({ role: 'compactionSummary', summary: cut.summary, tokensBefore: 0, timestamp: 0 });
    if (tokens + reserve > cell.window) record(cell, 'summary-room', `a saved summary of ${tokens} tokens does not fit the room of ${room}`, { prompt: i + 1, summary: tokens, room });
    summaries.push(cut.summary);
   }
   cuts = h.compactions().length;
   if (TRACE && cell.name.includes(TRACE)) console.log(`trace p${i + 1}: tokens=${tokens} requests=${requests} stop=${stopped.join(',') || 'none'} peak=${peak} floor=${floor} room=${room} cuts=${cuts} notice=${h.notices.length} ${(h.faults.at(-1) ?? 'no fault').slice(0, 700)}`);
  }
 } finally { await h.cleanup(); }
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

/** The named states, each one run whatever the grid samples. */
function namedCells(): Cell[] {
 const roomOf = (c: Pick<Cell, 'window' | 'reserve' | 'maxTokens'>) => c.window - Math.max(c.reserve, c.maxTokens);
 const overRoomWindow = { window: 32_768, reserve: 4_096, maxTokens: 4_096 };
 const atDefaults = (window: number): Cell => base(`defaults at ${window} (reserve 16384, keepRecent 20000)`, {
  window, reserve: 16_384, keepRecent: 20_000, maxTokens: 8_192, system: 1_500, host: 600,
  prompts: [300, 3_000, 9_000, 200, 1_000, 400], rounds: [0, 1, 2, 0, 1, 0], results: [400, 1_500, 3_000],
 });
 const small = base('tiny window 4000', { window: 4_000, reserve: 500, maxTokens: 500, system: 300, host: 100, prompts: [40, 200, 700, 1_400, 40, 400], rounds: [0, 1, 1, 0, 0, 1], results: [150, 400] });
 const tiny = base('tiny window 8000', { window: 8_000, reserve: 1_000, maxTokens: 1_000, system: 500, host: 150, prompts: [80, 400, 1_500, 2_800, 80, 900], rounds: [0, 1, 2, 0, 0, 1], results: [300, 800] });
 const big = (window: number) => base(`very large window ${window}`, {
  window, reserve: 32_768, maxTokens: 32_768, system: 12_000, host: 6_000, keepRecent: 20_000,
  prompts: [1_000, 40_000, 120_000, 1_000, 20_000, 60_000], rounds: [0, 1, 2, 0, 1, 2], results: [5_000, 20_000, 60_000],
 });
 const keepAt = (over: number): Cell => {
  const c = base(`keepRecent ${over}x the free room`, { window: 40_000, reserve: 4_000, maxTokens: 2_000, system: 1_000, host: 300, keepRecent: 0, prompts: [300, 2_000, 6_000, 200, 1_000, 400], rounds: [0, 1, 2, 0, 1, 0], results: [500, 2_000] });
  return { ...c, keepRecent: Math.round(roomOf(c) * over) };
 };
 const promptOverRoom = base('prompt bigger than the room, smaller than the window', {
  window: 32_768, reserve: 4_096, maxTokens: 4_096, system: 800, host: 200, why: 'the prompt alone is bigger than the room',
  prompts: [300, roomOf(overRoomWindow) + 800, 300], rounds: [0, 0, 0], results: [300],
 });
 const promptOverWindow = base('prompt bigger than the window', {
  window: 32_768, reserve: 4_096, maxTokens: 4_096, system: 800, host: 200, why: 'the prompt alone is bigger than the window',
  prompts: [300, 36_000, 300], rounds: [0, 0, 0], results: [300],
 });
 const resultOverWindow = base('tool result bigger than the window', {
  window: 32_768, reserve: 4_096, maxTokens: 4_096, system: 800, host: 200, why: 'a tool result bigger than the window arrives in the middle of a run',
  prompts: [300, 600, 300], rounds: [1, 1, 0], results: [34_000, 400],
 });
 const reopened = base('reopened session saved above the room', {
  window: 32_768, reserve: 4_096, maxTokens: 4_096, system: 800, host: 200,
  prompts: [300, 3_000, 200, 1_200], rounds: [0, 1, 0, 0], results: [400],
  extra: { reopen: true, noHistory: false, complete: 32_000, history: 30_000 },
 });
 const aborted = base('aborted turn, then a prompt', {
  window: 32_768, reserve: 4_096, maxTokens: 4_096, system: 800, host: 200, abortAfter: 1_500, stalls: true,
  prompts: [300, 800, 400], rounds: [0, 1, 0], results: [400],
  extra: { neverEnds: request => request === 2 },
 });
 const stalled = base('first request never answers, aborted by a timer', {
  window: 32_768, reserve: 4_096, maxTokens: 4_096, system: 800, host: 200, abortAfter: 1_500, stalls: true,
  prompts: [400, 400], rounds: [0, 0], results: [300],
  extra: { neverEnds: request => request === 1 },
 });
 // The live refusal did not reproduce on openai-codex-responses, so the same state runs on both APIs and each run says which one it used.
 const reasoning = (api: string, model?: { provider: string; id: string }): Cell => {
  const which = model ? `${model.provider}/${model.id}` : 'openai-codex/gpt-6.1-sol';
  return base(`36000 characters of thinking replayed at a 32k window (${api})`, {
   window: 32_768, reserve: 4_096, maxTokens: 4_096, system: 1_200, host: 300, api: `${api} (${which})`,
   prompts: [400, 600, 400, 300], rounds: [1, 1, 0, 0], results: [500, 800],
   extra: { thinkingChars: request => (request === 1 || request === 2 ? 36_000 : 0), ...(model ? { model } : {}) },
  });
 };
 const outputAboveRoom = base('output cap above the room', {
  window: 32_768, reserve: 2_048, maxTokens: 40_000, system: 800, host: 200, why: 'the model cannot answer inside the window, so nothing fits',
  prompts: [300, 800, 300], rounds: [0, 1, 0], results: [400],
 });
 const usage = (label: string, usageRatio?: number, over?: Partial<Cell>): Cell => base(`provider usage: ${label}`, {
  window: 32_768, reserve: 4_096, maxTokens: 4_096, system: 800, host: 200, usageRatio,
  prompts: [300, 2_000, 6_000, 300, 1_000, 400], rounds: [0, 1, 2, 0, 1, 0], results: [500, 1_500], ...over,
 });
 // t03-24: a cut kept only its summary, and the next prompt fits the room alone but not beside that summary. The calibration factor is 1.29.
 const t0324 = base('t03-24: summary alone, then a prompt that fits only without it (factor 1.29)', {
  window: 32_768, reserve: 4_096, maxTokens: 4_096, system: 1_200, host: 300, usageRatio: 1.29,
  prompts: [300, 3_000, 400], rounds: [0, 0, 0], results: [300],
  extra: { summary: true, summaryOnly: true, summaryTokens: 24_000, incoming: 120, complete: 28_000 },
 });
 const veto = base('another extension vetoes session_before_compact', {
  window: 32_768, reserve: 4_096, maxTokens: 4_096, system: 800, host: 200, why: 'another extension vetoes every cut, so a large conversation cannot fit',
  prompts: [300, 4_000, 12_000, 300, 1_000], rounds: [0, 1, 2, 0, 1], results: [800, 3_000], extra: { cancelCompact: true },
 });
 // The host's view is a message prepended in `context` by an extension of its own: this cell makes it large.
 const prepend = base('another extension prepends a message in context', {
  window: 32_768, reserve: 4_096, maxTokens: 4_096, system: 800, host: 9_000,
  prompts: [300, 2_000, 6_000, 300, 1_000, 400], rounds: [0, 1, 2, 0, 1, 0], results: [500, 1_500],
 });
 const boundary = base('another extension appends boundary entries at turn_end', {
  window: 32_768, reserve: 4_096, maxTokens: 4_096, system: 800, host: 200,
  prompts: [300, 2_000, 6_000, 300, 1_000, 400], rounds: [0, 1, 2, 0, 1, 0], results: [500, 1_500], extra: { turnEndEntries: 3 },
 });
 return [
  atDefaults(32_768), atDefaults(65_536), atDefaults(131_072), atDefaults(1_000_000),
  keepAt(1), keepAt(2),
  promptOverRoom, promptOverWindow, resultOverWindow, reopened, aborted,
  reasoning('openai-codex-responses'), reasoning('openai-completions', { provider: 'groq', id: 'openai/gpt-oss-120b' }),
  small, tiny, big(1_000_000), big(2_000_000), outputAboveRoom,
  // Pi always hands a usage object over; a provider that reports nothing arrives as zeros, and a non-finite number is its own case.
  usage('zero (a provider that reports nothing)', 0), usage('far below the estimate', 0.05), usage('far above the estimate', 5), usage('not a number', Number.NaN), usage('infinite', Number.POSITIVE_INFINITY),
  // A provider that reports no usage at all is not a state the host carries: Pi reads usage.input off the last assistant message before it asks
  // pi-tuck anything, and throws. The case records that, so "reports nothing" is exercised as zeros above rather than as a missing object here.
  usage('no usage object at all', undefined, { hostFault: "Cannot read properties of undefined (reading 'input')", extra: { noUsage: true } }),
  stalled, t0324, veto, prepend, boundary,
 ];
}

test(`settings stress: ${CELLS} sampled cells and the named edge cases`, async () => {
 if (!RUN) return;
 const started = Date.now();
 for (let i = 0; i < CELLS; i++) {
  const cell = sample(i);
  ran.push(cell.name); apis.add(cell.api ?? DEFAULT_API);
  try { await runCell(cell); } catch (error) { record(cell, 'harness', `the cell could not run: ${String(error).slice(0, 300)}`); }
 }
 for (const cell of namedCells()) {
  ran.push(cell.name); apis.add(cell.api ?? DEFAULT_API);
  try { await runCell(cell); } catch (error) { record(cell, 'harness', `the case could not run: ${String(error).slice(0, 300)}`); }
 }
 // The same input gives the same output: ten sampled cells run twice and their request digests are compared.
 for (const i of [0, 17, 43, 61, 88, 105, 122, 141, 167, 191].map(i => i % CELLS)) {
  const cell = sample(i);
  try {
   const a = await runCell(cell), b = await runCell(cell);
   const apart = divergence(a, b);
   if (apart) record(cell, 'determinism', `the same cell gave two different runs (${a.digest} then ${b.digest}): ${apart}`);
  } catch (error) { record(cell, 'harness', `the rerun could not run: ${String(error).slice(0, 300)}`); }
 }
 report(`stress: finished ${ran.length} cells in ${((Date.now() - started) / 1000).toFixed(1)}s on ${[...apis].sort().join(' and ')}`);
 // Report first: the table is printed by afterAll whether the run passes or not, and only STRESS_STRICT makes findings fail the run.
 if (STRICT) expect(failures.length, `${failures.length} rule violations; the table follows`).toBe(0);
}, Math.max(600_000, CELLS * 15_000));

afterAll(() => {
 if (!RUN) { report('stress: skipped (set STRESS=1 to run test/stress)'); return; }
 const byClass = new Map<Rule, { count: number; cells: Set<string> }>();
 for (const f of failures) { const row = byClass.get(f.rule) ?? { count: 0, cells: new Set<string>() }; row.count++; row.cells.add(f.cell); byClass.set(f.rule, row); }
 const sorted = [...byClass.entries()].sort((a, b) => b[1].count - a[1].count);
 report(`\nstress: cells run ${ran.length}, failures ${failures.length}, top failure class ${sorted[0]?.[0] ?? 'none'}`);
 report('class           failures  cells');
 for (const [rule, row] of sorted) report(`${rule.padEnd(15)} ${String(row.count).padStart(8)}  ${String(row.cells.size).padStart(5)}`);
 if (REPORT) {
  mkdirSync('test/stress', { recursive: true });
  writeFileSync('test/stress/failures.json', JSON.stringify({ seed: SEED, cells: CELLS, ran: ran.length, failures }, null, 1));
  report(`stress: wrote ${failures.length} failures to test/stress/failures.json`);
 }
});
