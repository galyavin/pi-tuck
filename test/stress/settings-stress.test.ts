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
 *   STRESS=1 STRESS_SETUP=1 npx vitest run test/stress
 *
 * STRESS_CELLS changes the size of the sampled grid, STRESS_SEED moves it, STRESS_REPORT writes the failures to test/stress/failures.json,
 * STRESS_TRACE="a piece of a cell name" prints what happened to each of that cell's prompts, and STRESS_STRICT=1 turns the table into a failing
 * run. Without STRESS_STRICT the run reports: a finding is a finding whether or not it is fixed yet, and the grid keeps running after the first.
 * STRESS_SETUP="a piece of a cell name" runs only the cells that carry a setup size — the sampled ones and the named grid — which is the part that
 * answers whether setup size and thrash are the real bottleneck; the rest of the grid is skipped, so one command finishes inside a minute or two.
 */
import { mulberry32 } from '../random-sessions';
import { afterAll, expect, test } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { est, harness, nonSystem, nonSystemCount, type Options } from '../budget-fixture';
import { DEFAULT_CUT_AT, bandOf } from '../../src/budget.js';
// The subpath the package's exports map allows; the file is pi-ai's own classifier, so the cells read the version under test.
import { isContextOverflow } from '@earendil-works/pi-ai/utils/overflow';
import { exemptUsefulCut, floorCase, forcedPointParity, nativeState, refusalParity, type BudgetObservation, type NativeState } from '../native-parity';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';

const RUN = /^(1|true|yes)$/i.test(process.env.STRESS ?? '');
const CELLS = Math.max(1, Number(process.env.STRESS_CELLS) || 200);
const SEED = (Number(process.env.STRESS_SEED) || 0x5eed) >>> 0;
const REPORT = process.env.STRESS_REPORT;
/** Make the table a gate. Off by default, so a known finding does not turn every run red before it is fixed. */
const STRICT = /^(1|true|yes)$/i.test(process.env.STRESS_STRICT ?? '');
/** Ten sampled cells, evenly spaced, are run twice and compared as the named ones are; a seeded grid must give the same answer on the same seed. */
const SAMPLE_EVERY = Math.max(1, Math.floor(CELLS / 10));
/** Trace one cell by a piece of its name: STRESS_TRACE="cell 1" prints what happened to each of its prompts. */
const TRACE = process.env.STRESS_TRACE;
/** Run only the cells whose name contains this, to work one finding at a time: STRESS_ONLY="keepRecent 2x". */
const ONLY = process.env.STRESS_ONLY;
/** Run only the cells whose name contains this, and for the sampled grid any cell that carries a sampled setup: STRESS_SETUP=setup, STRESS_SETUP=provider. */
const SETUP_ONLY = process.env.STRESS_SETUP;
/** More than one cut per five tool rounds means a session repeatedly spends a substantial share of its work on compaction. This is a workload
 * rate, not a claim that every fifth cut is intrinsically bad; short runs are excluded below. */
const THRASH_ROUNDS = 3;
/** No single prompt or tool result is bigger than this: a 1M-token string would spend the run on text generation rather than on settings. */
const CAP = 120_000;
/** A prompt that has not ended by now is stuck: the turn is aborted, the cell records it, and the session is asked to carry on. A cell whose
 * conversation runs to two million tokens spends real seconds counting it, so this is generous on purpose. */
const PROMPT_MS = 60_000;

/** The fixture's model, which every cell that does not name another goes out on. */
const DEFAULT_API = 'openai-codex-responses (openai-codex/gpt-6.1-sol)';

type Rule = 'native-parity' | 'repeat-state' | 'lost-prompt' | 'task-turn' | 'stuck' | 'window' | 'summary-room' | 'refusal' | 'clip-room' | 'no-clip' | 'fresh-room' | 'thrash' | 'useful-cut' | 'notice' | 'provider' | 'no-recovery' | 'determinism' | 'harness' | 'hollow' | 'cut-target';
type Failure = { cell: string; rule: Rule; message: string; params: Record<string, unknown> };
const failures: Failure[] = [];
const ran: string[] = [];
/** What the grid actually reached, so a run that cut nothing is visible as one that tested nothing. */
const cov = { cells: 0, room: 0, cut: 0, cuts: 0, answered: 0, refused: 0, aboveRoom: 0, overflows: 0, truncations: 0, clips: 0 };
/** Coverage describes a cell, not a run of it: outside STRESS_STRICT every named cell runs three times, and the re-runs are a second opinion on the
 * same settings rather than new ground, so only the first run of each name counts here. */
const covCounted = new Set<string>();
/** Every model API the run went out on, so the summary says which ones the numbers came from. */
const apis = new Set<string>();
/** One row per named setup cell: the point is to see a run that is near the limit and still under it, which a pass/fail table cannot show. */
interface SetupRow { name: string; window: number; setup: number; floor: number; room: number; hardLine: number; band: number; postCut: number | undefined; rounds: number; cuts: number; opportunistic: number; perRound: number; nextShare: number; meanFreed: number; thrashes: boolean }
// ---- setup size ----
// A Scoops replay at 131k spends about 24k of a 53k post-cut context on setup, and each cut frees only about 16k, so the setup and the band together
// decide what a session has left to work with. The sampled grid ties setup to the window, so it never shows that; the setup cells cross five setup
// sizes with four windows at Pi's own defaults: reserve 16,384, output cap 8,192, keepRecent 20,000.
const SETUP_RESERVE = 16_384;
const SETUP_MAX = 8_192;
const SETUP_KEEP = 20_000;
const SETUP_SIZE = 24_000;
/** What the fixture adds to a setup whatever its size: the tool schemas the host registers, the overhead of the system message, and its own heading.
 *  Measured off a run with a token-exact system prompt, so a cell that names a setup of 24,000 carries a request whose setup part measures 24,000; the
 *  setup table prints the measured floor beside the setup each cell asked for, which is the check that holds. The fixture's `system` option does not
 *  count what a real setup counts: it sizes the prompt with `text()`, whose items are 13 characters against the 24 the estimator's length count
 *  assumes, so the prompt comes out at about 0.6 of the number asked for. A setup cell asks for `systemTokens` instead. */
const SETUP_SCHEMA = 52;
/** What a probe assumes a request costs before any conversation at a given setup: the setup the cell names plus the round that produced the message.
 *  The probe replaces it with the guard's own measure, which is what every room rule in this file is judged on. */
const SETUP_OVERHEAD = 1_500;


let largestCutOvershoot = -Infinity, cappedCuts = 0;
const setupRows: SetupRow[] = [];
/** One row per provider cell: what the scripted provider really did, and whether pi-ai's own classifier called it a context overflow. That answer
 *  decides whether the host runs its one compact-and-retry at all, and it is pi-ai's fact rather than this test's, so the run prints it. */
interface ProviderRow { name: string; saw: string; pi: number }
const providerRows: ProviderRow[] = [];
const cellRows: Record<string, unknown>[] = [];
const usefulExemptCells = new Set<string>();
let usefulExemptCuts = 0;
const nativeCoverage = { observations: 0, sends: 0, compactThenSend: 0, refusals: 0, pastWindow: 0, failedReply: 0, promptCheck: 0, replyFloor: 0, forcedCuts: 0, overflowCompactions: 0 };
type NativeRefusal = { prompt: number; recovery: boolean; afterRequest: number; reason: string; state: NativeState };

/** The builders of the cells whose sizes depend on the floor pi-tuck's guard measures. `namedCells()` fills this in and the test runs each one twice:
 *  a probe to measure the floor, then the cell at that floor. */
const calibrationCells: ((floor: number) => Cell)[] = [];
const setupSeen = new Set<string>();
/** The report goes to stderr: a reporter that hides a passing test's stdout must still show the summary line and the table of failures. */
const report = (line: string) => { process.stderr.write(`${line}\n`); };

/** Everything a cell can be asked about after it ran, measured rather than intended. */
interface Evidence {
 window: number;
 /** The reserve the branch currently requires. */
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
 /** Cuts whose calibrated decision boundary was below the room. */
 opportunistic: number;
 /** Guard measurements of requests after observable cuts. */
 postCuts: number[];
 answered: number;
 refused: number;
 /** Prompts the run had to abort, and aborts an extension asked for. */
 hung: number;
 aborts: number;
 /** Requests the provider refused for exceeding its own window, vetoes of `session_before_compact`, and replies that reported no usage. */
 overflows: number;
 /** How many of the replies this run kept pi-ai's own isContextOverflow classes as a context overflow, at the cell's window. Which wordings and
  *  which truncations Pi reads as an overflow decides whether the host retries at all, so the provider cells name it. */
 piOverflow: number;
 vetoes: number;
 nonFinite: number;
 /** Requests a server took over its own window and answered anyway, and requests that went out carrying a clipped fresh result. */
 truncations: number;
 clips: number;
 /** The largest fresh tool result and the largest fresh assistant body the run sent: the two sizes a cut cannot reach. */
 maxFresh: number;
 maxAssistant: number;
 /** The largest calibration factor the run produced, which is what turns pi-tuck's measure into the provider's count. */
 maxFactor: number;
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
 /** Pi's reserve setting, raised to the output cap only after a length stop or a context-overflow refusal on this branch. */
 reserve: number;
 /** The setup the run carries: system message plus tool schemas plus the host's view. Sampled cells leave this unset and scale it with the window;
  * the setup grid names it, because a replay at 131k spends about 24k of a 53k post-cut context on setup and each cut frees only about 16k. */
 setup?: number;
 /** True for the sampled grid, so a rule can reach those cells by their shape rather than by their name. */
 sampled?: boolean;
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
 /** The provider refused the request of its own accord, in wording Pi does not class as a context overflow, so the turn ends in the provider's
  * error and pi-tuck is never asked to refuse. `refusal` and `notice` hold pi-tuck to a room the provider never showed it, so for this cell they
  * are replaced by the stated ones, named `provider`: the provider's error reaches the operator as a stop error; pi-tuck raises no refusal of its
  * own; the next short prompt gets a request (the `no-recovery` rule, which stays); and the session file still reopens. */
 providerRejection?: boolean;
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
 /** Clear what the cell records for itself. The harness state is built fresh for every run, and a cell that runs twice - the determinism repeat -
  * must not read a state its own first run recorded. */
 reset?: () => void;
 extra?: Partial<Options>;
 /** A run that exists to measure the request, not to test anything: no finding is counted from it, no coverage and no setup row. The cells whose sizes
  * depend on the floor pi-tuck measures are built twice, once as a probe and once at the floor the probe measured. */
 probe?: boolean;
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

/** Independent room oracle, shared by generated sizes and every rule: start at Pi's reserve, then hold the cap after a length stop or a refusal
 * pi-ai classes as a context overflow on the branch; other errors (a 503) keep the reserve. Read native entries rather than pi-tuck's helper or
 * receipts, so the same oracle judges 1.0.19 and the candidate. */
function limitsOf(cell: Pick<Cell, 'window' | 'reserve' | 'maxTokens'>, branch: readonly SessionEntry[] = []) {
 const failed = branch.some(e => e.type === 'message' && e.message.role === 'assistant' &&
  (e.message.stopReason === 'length' || (e.message.stopReason === 'error' && isContextOverflow(e.message as never))));
 const reserve = failed ? Math.max(cell.reserve, cell.maxTokens) : cell.reserve;
 const largest = Math.max(4_096, ...branch.flatMap(e => e.type === 'message' && e.message.role === 'assistant' && Number.isFinite(e.message.usage?.output) ? [e.message.usage.output] : []));
 const replyFloor = failed ? reserve : Math.min(reserve, Math.ceil(largest));
 return { reserve, replyFloor, room: cell.window - reserve, hardLine: cell.window - replyFloor };
}

/** The single arithmetic oracle for a setup that leaves no conversation capacity. */
const noRoom = (setup: number, hardLine: number) => setup >= hardLine;

/** A fixed generator, so the grid is the same grid on every machine and every run. */
function rng(seed: number) {
 const next = mulberry32(seed);
 const log = (lo: number, hi: number) => Math.exp(Math.log(Math.max(1, lo)) + next() * (Math.log(Math.max(1, hi)) - Math.log(Math.max(1, lo))));
 return { next, log, uniform: (lo: number, hi: number) => lo + next() * (hi - lo), int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)) };
}

/** One cell of the sampled grid. */
function sample(i: number): Cell {
 const r = rng(SEED + i * 7919);
 const window = Math.round(r.log(8_000, 1_000_000));
 const reserve = r.next() < 0.05 ? 0 : Math.round(r.log(1, window));
 const maxTokens = Math.round(r.log(1_000, 2 * window));
 const room = Math.max(0, limitsOf({ window, reserve, maxTokens }).room);
 const keepRecent = Math.round(r.uniform(0, 2 * room));
 const usageRatio = Number(r.uniform(0.7, 1.5).toFixed(3));
 // Setup size is its own axis, sampled log-uniform from 1,000 to 60,000. Tying it to the window at 8% hid the case a replay shows: at 131k about
 // 24k of a 53k post-cut context is setup, and each cut frees only about 16k, so the setup and the band, not the window, decide what is left.
 const setup = Math.round(r.log(1_000, 60_000));
 const host = Math.max(50, Math.round(setup * 0.1));
 const system = Math.max(200, setup - host - SETUP_SCHEMA);
 const sizes = [0.02, 0.2, 0.55, 1.15, 0.03, 0.35].map(f => Math.max(20, Math.min(CAP, Math.round(room * f))));
 const rounds = [0, 1, 2, 0, 1, 3].map(k => Math.max(0, k + r.int(-1, 1)));
 const results = [0.05, 0.15, 0.3].map(f => Math.max(20, Math.min(CAP, Math.round(room * f))));
 return {
  name: `cell ${i} (window ${window}, setup ${setup}, reserve ${reserve}, keepRecent ${keepRecent}, maxTokens ${maxTokens}, usage ${usageRatio})`,
  window, reserve, keepRecent, maxTokens, usageRatio, system, host, setup, sampled: true, prompts: sizes, rounds, results,
  // With no room at all, nothing but a refusal is possible, and the rules below say so by arithmetic rather than by exemption. A setup at or above
  // the room is the same kind of arithmetic: the request has no conversation left to cut, so the only answer is a refusal.
  why: noRoom(setup, limitsOf({ window, reserve, maxTokens }).hardLine) ? 'the setup alone reaches the hard line' : undefined,
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
 if (!cell.probe) return runCellInner(cell);
 // A probe measures the request and nothing else: no finding is counted from a cell that was built for a floor the guard has not measured yet.
 const counting = COUNT; COUNT = false;
 try { return await runCellInner(cell); } finally { COUNT = counting; }
}

async function runCellInner(cell: Cell): Promise<Run> {
 const t0 = Date.now();
 cell.reset?.();
 let { reserve, room, hardLine, replyFloor } = limitsOf(cell);
 // The point a cut aims under: pi-tuck's band, which is what a setup at or above it leaves nothing to cut into.
 const band = bandOf(Math.max(0, room), DEFAULT_CUT_AT);
 // A non-finite usage number is no observation at all, so it counts as 1.
 const factor = Number.isFinite(cell.usageRatio) ? Math.max(1, cell.usageRatio!) : 1;
 let startReq = 0, roundEnd = 0, currentPrompt = 0, currentPromptTokens = 0, recovery = false;
 let lastBudget: BudgetObservation | undefined;
 let overflowRecovery = false;
 const nativeBuilds: NativeState[] = [], nativeRefusals: NativeRefusal[] = [];
 const guardPrompts: number[] = [];
 const nativeRefusalKeys = new Set<string>();
 const h = await harness({
  // The setup the cell carries: the system message, and the host's view of the conversation, which together stand in for a real system prompt and
  // its tool schemas. A cell that names a setup gets exactly that much setup; the sampled grid scales it with the window.
  at: 'prompt', complete: cell.setup ?? Math.max(2_000, cell.window), host: cell.host, noHistory: true, oneTurn: true, systemTokens: cell.system,
  cutAtDefault: cell.setup !== undefined,
  limits: { contextWindow: cell.window, maxTokens: cell.maxTokens },
  reserveTokens: cell.reserve, keepRecent: cell.keepRecent, usageRatio: cell.usageRatio,
  // The provider counts by its own tokenizer and holds its window: a request whose count passes it comes back as an overflow, not an answer.
  rejectOverWindow: true,
  toolCalls: request => request > startReq && request <= roundEnd,
  toolResultTokens: call => cell.results[(call - 1) % cell.results.length] ?? 100,
  ...cell.extra,
  // The shared fixture defaults to the host path. This grid tests standalone, on both builds.
  onBeforeCompact: (event, ctx) => {
   overflowRecovery = event.reason === 'overflow';
   if (overflowRecovery && COUNT && !cell.probe && !covCounted.has(cell.name)) nativeCoverage.overflowCompactions++;
   cell.extra?.onBeforeCompact?.(event, ctx);
  },
  onFailure: error => {
   if (!lastBudget) throw new Error('Native parity has no observed pi-tuck budget for this refusal');
   const reason = String(error), key = JSON.stringify([currentPrompt, recovery, h.state.requests, reason]);
   if (nativeRefusalKeys.has(key)) return;
   nativeRefusalKeys.add(key);
   nativeRefusals.push({ prompt: currentPrompt, recovery, afterRequest: h.state.requests, reason, state: { ...nativeState(lastBudget, h.settings), overflowRecovery, expectedHardLine: limitsOf(cell, h.manager.getBranch()).hardLine } });
  },
  compaction: { ...cell.extra?.compaction, requestReserve: undefined, observeBudget: measure => { lastBudget = measure; } },
 });
 const requestLimits: ReturnType<typeof limitsOf>[] = [];
 h.extension().on('context_with_system', () => {
  requestLimits.push(limitsOf(cell, h.manager.getBranch()));
  guardPrompts.push(currentPromptTokens);
  if (!lastBudget) throw new Error('Native parity budget observation is unavailable');
  nativeBuilds.push({ ...nativeState(lastBudget, h.settings), overflowRecovery });
  overflowRecovery = false;
 });
 const guard: number[] = [], summaries: string[] = [], stops: string[] = [], counts: { count: number; known: boolean }[] = [];
 const promptSizes: number[] = [], resultSizes: number[] = [], threw: string[] = [], promptRequests: number[] = [], resultCounts: number[] = [];
 // Compactions this cell saved, run-end cuts included: a cut that closes a run is still a cut the session keeps.
 const initialCuts = new Set(h.compactions().map(entry => entry.id));
 const cutStart = h.manager.getEntries().filter(e => e.type === 'compaction').length;
 const savedCuts = () => h.manager.getEntries().filter(e => e.type === 'compaction').length - cutStart;
 let answered = 0, refused = 0, hung = 0, cuts = 0, piOver = 0;
 if (TRACE && cell.name.includes(TRACE)) report(`trace cell ${cell.name}: window=${cell.window} reserve=${cell.reserve} keepRecent=${cell.keepRecent} maxTokens=${cell.maxTokens} usage=${cell.usageRatio} system=${cell.system} host=${cell.host} prompts=${JSON.stringify(cell.prompts)} rounds=${JSON.stringify(cell.rounds)} results=${JSON.stringify(cell.results)}`);
 try {
  // What a request costs before any conversation: the system part, the tools and the host's view. A cut removes conversation, never this.
  const floor = h.mandatory + nonSystem([h.hostInput()]);
  // The state the cell starts from, before its first prompt: a seeded summary, a reopened history, or nothing.
  const savedStart = nonSystem(h.saved());
  const savedRoles = h.saved().map(m => m.role);
  const probeStart = h.probes.length;
  // One answer per context build, not its text: a grid's requests held in memory run the worker out of heap.
  const carriedPrompt: boolean[] = [];
  let carriedSeen = 0, opening = '';
  const answeredPrompts: { prompt: number; opening: string }[] = [];
  h.extension().on('context_with_system', event => { carriedPrompt.push(JSON.stringify(event.messages).includes(opening)); });
  for (let i = 0; i < cell.prompts.length; i++) {
   ({ reserve, room, hardLine, replyFloor } = limitsOf(cell, h.manager.getBranch()));
   // Exactly the size the cell names: a prompt that says 36,000 tokens is 36,000 tokens of what pi-tuck counts.
   const body = h.sized(Math.max(20, Math.min(CAP, cell.prompts[i] ?? 100)));
   const tokens = est({ role: 'user', content: body, timestamp: 0 });
   promptSizes.push(tokens); currentPrompt = i + 1; currentPromptTokens = tokens; recovery = false; overflowRecovery = false;
   opening = JSON.stringify(body.slice(0, 80)).slice(1, -1);
   const cutsBefore = h.compactions().length;
   const ms = cell.stallPrompt === i + 1 ? cell.abortAfter ?? 1_500 : PROMPT_MS;
   startReq = h.state.requests; roundEnd = startReq + (cell.rounds[i] ?? 0);
   const seen = { requests: h.state.requests, notices: h.notices.length, faults: h.faults.length, guard: h.guard.length, stops: h.state.stops.length, results: h.state.results.length, counts: h.state.counts.length, clips: h.state.clips, answers: h.state.answers.length };
   const outcome = await drive(h, body, ms);
   // The reply may itself have raised the branch reserve. Judge refusals/recovery against the room now required; sent requests retain
   // their own pre-reply snapshots below, so a first length/error cannot retroactively make an admitted request a window violation.
   ({ reserve, room, hardLine, replyFloor } = limitsOf(cell, h.manager.getBranch()));
   threw.push(lastThrew);
   const requests = h.state.requests - seen.requests;
   // Every prompt reaches the model and stays in the session, whatever a cut did, or the operator is told. Long prompts may be quoted by a summary with a
   // locator to the rest, so the check reads the prompt's opening. A prompt the model never saw looks like an ordinary answer to everything else.
   const built = carriedPrompt.slice(carriedSeen, carriedSeen + requests);
   carriedSeen = carriedPrompt.length;
   const missing = built.filter(carried => !carried).length;
   if (missing) record(cell, 'lost-prompt', `prompt ${i + 1} of ${cell.prompts[i] ?? 100} tokens was missing from ${missing} of its ${requests} requests`, { prompt: i + 1 });
   // Which earlier prompt is the task can't be known without reading it, so the first answered prompt (the goal of a long session) and the newest
   // 8 answered prompts (where the current task is) must keep at least their openings through a cut, in the summary or the kept tail. A prompt
   // refused for being larger than the room was never taken up and is not counted.
   if (requests > 0) answeredPrompts.push({ prompt: i + 1, opening });
   if (h.compactions().length > cutsBefore) {
    const saved = JSON.stringify(h.manager.buildSessionProjection().messages);
    // The first answered prompt is the session's first user turn only where the case seeds no opening turn before it.
    const goal = cell.extra?.noOpening && answeredPrompts[0] ? [answeredPrompts[0]] : [];
    const watched = [...new Set([...goal, ...answeredPrompts.slice(-8)])];
    const lost = watched.filter(p => !saved.includes(p.opening)).map(p => p.prompt);
    if (lost.length) record(cell, 'task-turn', `after a cut during prompt ${i + 1}, earlier prompts ${lost.join(', ')} are in neither the summary nor the kept tail`, { prompt: i + 1, lost });
   }
   if (requests > 0 && !JSON.stringify(h.manager.buildSessionProjection().messages).includes(opening)) record(cell, 'lost-prompt', `prompt ${i + 1} of ${cell.prompts[i] ?? 100} tokens reached the model but is gone from the saved session`, { prompt: i + 1 });
   // Every request has exactly one context build before it, and both lists grow in order, so the first `requests` measures are the requests that
   // went out. A build that never became a request was refused before it was sent, and so cannot have exceeded the window.
   const sent = h.guard.slice(seen.guard, seen.guard + requests);
   const peak = sent.length ? Math.max(...sent) : 0;
   guard.push(...sent);
   const charged = h.state.counts.slice(seen.counts, seen.counts + requests);
   counts.push(...charged);
   promptRequests.push(requests);
   // A tool round is a round where the model asked for work and a result came back: that is the denominator the thrash rule counts, not the requests a
   // turn cost, which also counts the plain answer that closes the turn.
   resultCounts.push(h.state.results.length - seen.results);
   resultSizes.push(...h.state.results.slice(seen.results));
   // The turn answered if an assistant message this turn produced ended normally: a tool round ends with toolUse, the last message of the whole
   // session can belong to an earlier prompt, and a cut can drop messages, so the message's own time is what ties it to this turn.
   const stopped = h.state.stops.slice(seen.stops);
   // Whether pi-ai classes what came back as an overflow is a fact of pi-ai, not of this test: it decides whether the host runs its one
   // compact-and-retry at all, so each provider cell names the classification it expects and a wrong guess shows up as a hollow cell. The fixture
   // hands over the message exactly as the scripted model returned it, which is the message the host reads.
   // pi-ai reads message.usage without guarding it, so asking it about a reply that reported no usage throws - which is the host fault the
   // "no usage reported" cell names, and a classification question only for a reply that got far enough to carry a usage object.
   for (const reply of h.state.answers.slice(seen.answers)) if (reply.usage && isContextOverflow(reply, cell.window)) piOver++;
   const stoppedLast = stopped.at(-1);
   stops.push(outcome === 'hung' ? 'hung' : stoppedLast ?? 'none');
   if (outcome === 'hung') hung++;
   if (outcome === 'hung' && cell.stallPrompt !== i + 1) record(cell, 'stuck', `prompt ${i + 1} never ended; the turn was aborted after ${ms} ms`, { prompt: i + 1, tokens });
  // What the session said when it refused: the notice the operator saw and the fault pi-tuck recorded.
  const said = `${h.notices.slice(-1).join(' | ').slice(0, 120) || 'no notice'} / ${h.faults.slice(-1).join(' | ').slice(0, 90) || 'no fault'}`;
   for (const [n, tokens] of sent.entries()) {
    const held = requestLimits[seen.guard + n]!.replyFloor;
    if (tokens + held > cell.window) record(cell, 'window', `a request of ${tokens} tokens plus the reserve of ${held} exceeds the window of ${cell.window}: ${said}`, { prompt: i + 1, peak: tokens });
   }
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
  if (!cell.hostFault && !cell.providerRejection && wasRefused && h.notices.length === seen.notices) record(cell, 'notice', `prompt ${i + 1} was refused (stop ${stopped.join(',') || 'none'}, ${requests} requests) with no notice to the operator`, { prompt: i + 1, tokens, requests });
  // The stated rules for a provider that rejects a request in wording Pi does not class as an overflow. pi-tuck planned a request its own measure
  // put inside the room; the provider counted it differently and said no, and the only account the operator gets is the provider's. So the test is
  // not "did pi-tuck explain itself" but "did pi-tuck stay out of the way and leave the session whole": the error must arrive, pi-tuck must add no
  // refusal of its own, and the file must still reopen (checked at the end of the run). That the next short prompt gets a request is `no-recovery`.
  if (cell.providerRejection && wasRefused) {
   const ours = [...h.notices.slice(seen.notices), ...h.faults.slice(seen.faults)];
   if (ours.length) record(cell, 'provider', `prompt ${i + 1}: pi-tuck raised a refusal of its own over the provider's rejection: ${ours.join(' | ').slice(0, 160)}`, { prompt: i + 1 });
   else if (requests === 0) record(cell, 'provider', `prompt ${i + 1} was refused before a request reached the provider, so the rejection is pi-tuck's own`, { prompt: i + 1, tokens });
   else if (!stopped.includes('error')) record(cell, 'provider', `prompt ${i + 1} ended ${stopped.join(',') || 'nothing'} instead of carrying the provider's error to the operator`, { prompt: i + 1, stop: stopped.join(',') || 'none' });
  }
  // A refusal is only the last resort when nothing that fits the room can answer the prompt. The bound is the smallest request that could:
  // the mandatory part, the prompt, a summary that quotes the prompt verbatim as its contract requires with room for its headings, and the fresh
  // messages the turn has produced. A mid-run cut carries the prompt once, as that quote, so the prompt is counted once and not twice. A fresh
  // tool result can be clipped since 1.0.8, so it counts at 200 tokens rather than at its own size. A fresh assistant message can be clipped by
  // nothing and dropped by no cut, so it counts whole. Then the factor the provider's own usage implies, and the reserve the session must hold.
  const fresh = h.state.results.slice(seen.results);
  const carried = h.state.assistantSizes.slice(seen.requests, h.state.requests).reduce((a, b) => a + b, 0);
  const smallest = Math.ceil((floor + tokens + 200 + carried + 200 * fresh.length) * factor);
  const fitsAlone = smallest < hardLine - 64;
  // pi-tuck sizes a clip at half the room its own measure leaves (src/compaction.ts). The provider counts that clipped round at the factor, so a
  // clip sized without the factor can still go over the window; if a clip sized to the room the provider actually leaves would have fit, the clip
  // budget is the reason the run refused, and a refusal is a finding whether or not a clip was tried.
  const clipAware = Math.floor((room - Math.ceil(floor * factor)) / 2);
  const afterClip = Math.ceil((floor + tokens + 200 + carried + Math.max(0, clipAware)) * factor);
  const clipWouldFit = fresh.length > 0 && afterClip < hardLine - 64;
  // A fresh assistant body above the free room as pi-tuck estimates it, but below the free room as the provider counts it, is a message the cut
  // that answers this round cannot see coming: pi-tuck planned the request before the model wrote the body that overflows it.
  const freeRoom = Math.floor(room / factor) - floor;
  const freshAssistant = Math.max(0, ...h.state.assistantSizes.slice(seen.requests, h.state.requests));
  // The claim is that the model's own reply overflowed a room pi-tuck thought it had, so there must be such a room and such a reply: a run whose
  // setup already leaves nothing free is the arithmetic case, and a reply of no content is not the cause of anything.
  const assistantOverRoom = freeRoom > 0 && freshAssistant > 0 && freshAssistant > freeRoom && freshAssistant < room - floor;
  if (!cell.hostFault && wasRefused && !cell.why && assistantOverRoom) record(cell, 'fresh-room', `prompt ${i + 1} was refused on a fresh assistant body of ${freshAssistant} tokens, above the free room as pi-tuck estimates it (${freeRoom}) and below what the room holds at the provider's count (${room - floor}): nothing clips or cuts a fresh assistant message, so the run stopped where the model's own reply overflowed`, { prompt: i + 1, tokens, freshAssistant, freeRoom, floor });
  else if (!cell.hostFault && wasRefused && !cell.why && fitsAlone && clipWouldFit) record(cell, h.state.clips > seen.clips ? 'clip-room' : 'no-clip', `prompt ${i + 1} of ${tokens} tokens was refused although a clip sized to the room the provider leaves would fit (${afterClip} of a room of ${room}, factor ${factor.toFixed(2)}, prompt ${tokens}, ${fresh.length} fresh result(s), floor ${floor}, clip budget ${Math.max(0, clipAware)} against pi-tuck's own ${Math.floor((room - floor) / 2)}): ${said}`, { prompt: i + 1, tokens, fresh: fresh.length, floor, afterClip, clipAware, room, factor });
  else if (!cell.hostFault && !cell.providerRejection && wasRefused && fitsAlone) record(cell, 'refusal', `prompt ${i + 1} of ${tokens} tokens was refused although the smallest request that answers it fits the room (${smallest} of a room of ${room}, factor ${factor.toFixed(2)}, prompt ${tokens}, ${fresh.length} fresh result(s), fresh assistant body ${carried}, floor ${floor}): ${said}`, { prompt: i + 1, tokens, fresh: fresh.length, carried, floor, smallest, room, factor });
   if (!cell.hostFault && (wasRefused || outcome === 'hung')) {
    // Nothing may leave a session unable to take the next prompt: a short one has to get through, when the room can hold it at all — which
    // means beside the conversation the failure left behind, not only beside the prompt.
    const left = nonSystem(h.saved());
    if (Math.ceil((floor + left + 60) * factor) < hardLine - 64) {
     startReq = h.state.requests; roundEnd = startReq;
     recovery = true; currentPromptTokens = 60;
     const again = await drive(h, h.sized(60), ms);
     recovery = false;
     if (again === 'hung' || h.state.requests === startReq) record(cell, 'no-recovery', `a short prompt after prompt ${i + 1} got no request either`, { prompt: i + 1, stop: stoppedLast ?? 'none' });
    }
   }
   for (const cut of h.compactions().slice(cuts)) {
    if (!initialCuts.has(cut.id)) {
     const details = cut.details as { tokensAfter?: number; carriedTarget?: number };
     if (typeof details.carriedTarget !== 'number' || typeof details.tokensAfter !== 'number') record(cell, 'cut-target', 'a generated cut has no measured after/target receipt');
     else {
      const overshoot = details.tokensAfter - details.carriedTarget;
      largestCutOvershoot = Math.max(largestCutOvershoot, overshoot); cappedCuts++;
      if (overshoot > 0) record(cell, 'cut-target', `cut carries ${details.tokensAfter}, exceeding its target ${details.carriedTarget} by ${overshoot}`);
     }
    }
    const tokens = est({ role: 'compactionSummary', summary: cut.summary, tokensBefore: 0, timestamp: 0 });
    if (tokens + replyFloor > cell.window) record(cell, 'summary-room', `a saved summary of ${tokens} tokens does not fit the room of ${room}`, { prompt: i + 1, summary: tokens, room });
    summaries.push(cut.summary);
   }
   cuts = h.compactions().length;
   if (TRACE && cell.name.includes(TRACE)) report(`trace p${i + 1}: tokens=${tokens} requests=${requests} stop=${stopped.join(',') || 'none'} peak=${peak} floor=${floor} room=${room} cuts=${savedCuts()} notice=${h.notices.length} counts=${JSON.stringify(charged)} probes=${JSON.stringify(h.probes.slice(Math.max(probeStart, h.probes.length - 6)))} threw=${lastThrew.slice(0, 900)} ${(h.faults.at(-1) ?? 'no fault').slice(0, 500)}`);
  }
  // A failed request's actual provider context may never be sent again, even during Pi's native retry.
  for (let at = 0; at < h.state.answers.length; at++) {
   const answer = h.state.answers[at]!;
   if (answer.stopReason !== 'length' && !(answer.stopReason === 'error' && isContextOverflow(answer))) continue;
   if (h.state.requestStates.slice(at + 1).includes(h.state.requestStates[at]!)) record(cell, 'repeat-state', `request ${at + 1} was sent again after its length/overflow failure`);
  }
  // The last stated rule for a provider that rejects a request in wording Pi does not class as an overflow: whatever the provider did to the
  // request, the session's own state must survive. The file is all the operator has if the run ends here, so it must reopen with the conversation
  // the session holds in memory.
  if (cell.providerRejection || cell.extra?.replyWindow) {
   const left = nonSystemCount(h.saved());
   try {
    const back = h.reopenFile();
    if (back < left) record(cell, 'provider', `the session file reopened with ${back} messages against the ${left} the session holds`);
   } catch (error) {
    record(cell, 'provider', `the session file no longer reopens: ${error instanceof Error ? error.message : String(error)}`);
   }
  }
  // Thrash: cuts against rounds, counted from the run's first cut. A cut that lands under the band and is followed by another cut on the very next
  // request freed less than the round it answered, so the session pays a summary for every round of work. Nothing is exempt: a setup at or above the
  // band is exactly the case under test. Cuts and fresh messages are indexed by context build, since a refused build is a step the session took too.
  const rounds = resultCounts.reduce((a, b) => a + b, 0);
  // Builds are 0-based context builds, one per request. `cutCounts[j]` is the compactions saved when build j was measured, and the probe runs before
  // pi-tuck's own hook in the same event, so build j is the last build still measured at full size and build j+1 the first measured after the cut: the
  // cut removed what those two builds differ by, once the messages the turn added between them are put back.
  const builds = h.state.cutCounts;
  const cutBuilds: number[] = [];
  for (let j = 0; j < builds.length; j++) if (builds[j] > (j === 0 ? cutStart : builds[j - 1])) cutBuilds.push(j);
  // A prompt cut is previewed on the first request and saved at its first boundary; tool-loop cuts are saved before the next request. Use the
  // receipt to identify that request even when new content makes it larger than the preceding one. Run-end cuts have no comparable pre-cut probe.
  const entries = h.manager.getEntries().filter(e => e.type === 'compaction').slice(cutStart);
  const cutRequests: { at: number; reason: string; entry: typeof entries[number] }[] = [];
  let observed = 0;
  for (let j = 0; j < builds.length; j++) {
   const count = builds[j]! - cutStart;
   while (observed < count) {
    const entry = entries[observed++];
    if (!entry || entry.type !== 'compaction') continue;
    const reason = (entry.details as { diagnosticReceipt?: { reason?: string } } | undefined)?.diagnosticReceipt?.reason;
    if (!reason) continue; // A native or foreign compaction does not carry pi-tuck's boundary receipt.
    const at = reason === 'prompt' ? j - 1 : j;
    if (at >= 0 && h.guard[at] !== undefined) cutRequests.push({ at, reason, entry });
   }
  }
  const postCuts = cutRequests.map(({ at }) => h.guard[at]!);
  // Compare the guard to the pre-cut boundary on the same request, not to the preceding request (which lacks the newly produced tool result).
  const freedCuts = cutRequests.flatMap(({ at, reason, entry }) => {
   if (reason === 'run-end') return [];
   const probe = h.probes.findLast(p => p.after === at && p.at === (reason === 'prompt' ? 'prompt' : 'tool'));
   return probe && probe.complete >= h.guard[at]! ? [{ freed: probe.complete - h.guard[at]!, at, entry }] : [];
  });
  const freed = freedCuts.map(cut => cut.freed);
  const meanFreed = freed.length ? Math.round(freed.reduce((a, b) => a + b, 0) / freed.length) : 0;
  const nextShare = cutBuilds.length ? cutBuilds.filter(j => cutBuilds.includes(j + 1)).length / cutBuilds.length : 0;
  // The rate needs a run long enough to be a rate: one cut in three rounds says nothing, so the rule reaches runs of at least 12 tool rounds, named or
  // sampled, and exempts nothing else. A setup at or above the band is exactly the case under test.
  const thrashApplies = rounds >= 12;
  const cutsAt = savedCuts();
  // Classify each cut at its own decision boundary, including run-end cuts: the receipt records both the pre-cut conversation and mandatory input.
  // A cut at the calibrated room is forced and does not count towards the opportunistic thrash rate.
  let unclassifiedCuts = 0;
  const opportunistic = entries.filter(entry => {
   const receipt = (entry.details as { diagnosticReceipt?: { before?: { value: number }; settings?: { mandatoryInputTokens?: number; calibrationFactor?: number } } } | undefined)?.diagnosticReceipt;
   const mandatory = receipt?.settings?.mandatoryInputTokens;
   if (receipt?.before === undefined || mandatory === undefined) { unclassifiedCuts++; return false; }
   const cutRoom = limitsOf(cell, h.manager.getBranch(entry.id)).room;
   return Math.ceil((receipt.before.value + mandatory) * (receipt.settings?.calibrationFactor ?? 1)) < cutRoom;
  }).length;
  if (unclassifiedCuts) record(cell, 'harness', `${unclassifiedCuts} cuts have no decision receipt, so their relation to the room cannot be classified`);
  const thrashes = thrashApplies && opportunistic * THRASH_ROUNDS > rounds;
  if (thrashApplies && thrashes) record(cell, 'thrash', `${opportunistic} cuts below the room in ${rounds} tool rounds is more than one per ${THRASH_ROUNDS}: the mean cut freed ${meanFreed} tokens against an initial band of ${band} and a setup of ${cell.setup ?? floor}, and ${Math.round(nextShare * 100)}% of cuts were followed by another cut on the very next request`, { window: cell.window, setup: cell.setup ?? floor, band, rounds, cuts: cutsAt, opportunistic, meanFreed, nextShare });
  // A slow-growing session can cut infrequently while every cut buys almost no room. On a long run, require the mean of at least three comparable
  // cuts to free one tenth of the room: ten such gains together equal the whole usable room, a scale independent of the chosen round size.
  let exemptCuts = 0;
  const usefulFreed = freedCuts.filter(({ entry, at }) => {
   const receipt = (entry.details as { diagnosticReceipt: { before: { value: number }; settings: { responseReserveTokens: number; mandatoryInputTokens: number; calibrationFactor?: number } } }).diagnosticReceipt;
   const cutRoom = cell.window - receipt.settings.responseReserveTokens, cutFactor = receipt.settings.calibrationFactor ?? 1;
   const forced = Math.ceil((receipt.before.value + receipt.settings.mandatoryInputTokens) * cutFactor) >= cutRoom;
   if (!exemptUsefulCut(forced, Math.ceil(((cell.setup ?? floor) + (guardPrompts[at] ?? 0)) * cutFactor), cutRoom)) return true;
   exemptCuts++; return false;
  }).map(cut => cut.freed);
  if (rounds >= 12 && freed.length >= 3 && exemptCuts && COUNT && !cell.probe && !covCounted.has(cell.name)) {
   usefulExemptCells.add(cell.name); usefulExemptCuts += exemptCuts;
  }
  const usefulMean = usefulFreed.length ? Math.round(usefulFreed.reduce((a, b) => a + b, 0) / usefulFreed.length) : 0;
  if (rounds >= 12 && room > 0 && usefulFreed.length >= 3 && usefulMean < room / 10)
   record(cell, 'useful-cut', `${usefulFreed.length} measured non-exempt cuts freed a mean of ${usefulMean} tokens, less than one tenth of the ${room}-token room`, { room, measuredCuts: usefulFreed.length, meanFreed: usefulMean, exemptCuts });
  // The table covers the named setup cells and any sampled run long enough for the thrash rule to reach it; a sampled cell of six rounds is a rate
  // measured over nothing, and the sampled grid is reported by the coverage line.
  if (cell.setup !== undefined && !cell.probe && (cell.name.startsWith('setup ') || rounds >= 12) && !setupSeen.has(cell.name)) {
   setupSeen.add(cell.name);
   const orderedPostCuts = [...postCuts].sort((a, b) => a - b);
   setupRows.push({ name: cell.name, window: cell.window, setup: cell.setup, floor, room, hardLine, band, postCut: orderedPostCuts[Math.floor(orderedPostCuts.length / 2)], rounds, cuts: cutsAt, opportunistic, perRound: rounds ? opportunistic / rounds : 0, nextShare, meanFreed, thrashes });
  }
  // The cell's own claim, read off what happened rather than what was asked for. A cell that never reached its state tested nothing, and that is
  // a finding about the test: it is recorded so it cannot hide behind a clean table.
  if (cell.reached) {
   const e: Evidence = {
    window: cell.window, reserve, room, factor, floor, savedStart, savedRoles, guard, counts,
    probes: h.probes.slice(probeStart), prompts: promptSizes, results: resultSizes, requests: promptRequests, cuts: savedCuts(), opportunistic, postCuts,
    answered, refused, hung, aborts: h.state.aborts, overflows: h.state.overflows, vetoes: h.state.vetoes,
    truncations: h.state.truncations, clips: h.state.clips, piOverflow: piOver, maxFresh: Math.max(0, ...h.state.results), maxAssistant: Math.max(0, ...h.state.assistantSizes),
    maxFactor: Math.max(1, ...h.state.counts.map((c, k) => c.known ? c.count / Math.max(1, h.guard[k]) : 1)),
    nonFinite: h.state.nonFinite, notices: h.notices.length, faults: h.faults.length, threw: threw.filter(Boolean).join(' | '),
   };
   if (cell.name.startsWith('provider:') && !covCounted.has(cell.name)) {
    providerRows.push({
     name: cell.name.slice('provider: '.length),
     saw: h.state.truncations ? `truncated ${h.state.truncations}x` : `rejected ${e.overflows}x`,
     pi: e.piOverflow,
    });
   }
   if (!cell.reached.check(e)) {
    const numbers = `room=${room} band=${band} floor=${floor} saved=${savedStart} prompts=${JSON.stringify(promptSizes)} results=${JSON.stringify(resultSizes)} guard=${JSON.stringify(guard)} probes=${JSON.stringify(e.probes)} cuts=${e.cuts} rounds=${rounds} fresh=${e.maxFresh} assistant=${e.maxAssistant} truncations=${e.truncations} clips=${e.clips} piOverflow=${e.piOverflow} answered=${answered} refused=${refused} hung=${hung} aborts=${e.aborts} overflows=${e.overflows} vetoes=${e.vetoes} counts=${JSON.stringify(counts)}`;
    record(cell, 'hollow', `the run never reached the state the cell names (${cell.reached.state}): ${numbers}`, { room, floor, savedStart, cuts: e.cuts });
   }
   if (TRACE && cell.name.includes(TRACE)) report(`trace reached ${cell.reached.check(e)}: ${cell.reached.state} ms=${Date.now() - t0} cutBuilds=${JSON.stringify(cutBuilds)} freed=${JSON.stringify(freed)} guard=${JSON.stringify(guard.slice(0, 40))}`);
  }
  const workLost = {
   lostPrompt: failures.some(f => f.cell === cell.name && f.rule === 'lost-prompt'),
   lostTask: failures.some(f => f.cell === cell.name && f.rule === 'task-turn'),
   strand: failures.some(f => f.cell === cell.name && f.rule === 'no-recovery'),
  };
  const parity = nativeRefusals.map(refusal => ({ ...refusal, ...refusalParity(refusal.state, refusal.reason), floorCase: floorCase(refusal.state) }));
  for (const refusal of parity) if (refusal.violation)
   record(cell, 'native-parity', `prompt ${refusal.prompt}${refusal.recovery ? ' recovery' : ''}: pi-tuck refused ${refusal.state.correctedTokens} corrected tokens; native would ${refusal.state.nativeAction} at point ${refusal.state.nativePoint}`, { clause: 'refusal', ...refusal, workLost });
  for (const entry of entries) {
   const receipt = (entry.details as { diagnosticReceipt?: { before: { value: number }; settings: { responseReserveTokens: number; mandatoryInputTokens: number; calibrationFactor?: number } } }).diagnosticReceipt;
   if (!receipt || !lastBudget) continue;
   const forcedPoint = cell.window - receipt.settings.responseReserveTokens;
   const total = Math.ceil((receipt.before.value + receipt.settings.mandatoryInputTokens) * (receipt.settings.calibrationFactor ?? 1));
   if (total < forcedPoint) continue; // a band cut made by choice
   const state = nativeState({ ...lastBudget, rawTokens: receipt.before.value + receipt.settings.mandatoryInputTokens, tokens: total, factor: receipt.settings.calibrationFactor ?? 1, room: forcedPoint,
    context: Object.create(lastBudget.context, { sessionManager: { value: Object.create(h.manager, { getBranch: { value: () => h.manager.getBranch(entry.id) }, getLeafId: { value: () => entry.id } }) } }) }, h.settings);
   if (COUNT && !cell.probe && !covCounted.has(cell.name)) nativeCoverage.forcedCuts++;
   if (forcedPointParity(state, forcedPoint)) record(cell, 'native-parity', `forced cut point ${forcedPoint} is below native's ${state.nativePoint}`, { clause: 'forced-point', entryId: entry.id, forcedPoint, state, workLost });
  }
  if (COUNT && !cell.probe && !covCounted.has(cell.name)) {
   nativeCoverage.observations += nativeBuilds.length;
   nativeCoverage.sends += nativeBuilds.filter(s => s.nativeAction === 'send').length;
   nativeCoverage.compactThenSend += nativeBuilds.filter(s => s.nativeAction === 'compact-then-send').length;
   nativeCoverage.refusals += parity.length;
   nativeCoverage.pastWindow += parity.filter(r => r.exception === 'past-window').length;
   nativeCoverage.failedReply += parity.filter(r => r.exception === 'failed-reply').length;
   nativeCoverage.promptCheck += parity.filter(r => r.exception === 'prompt-check').length;
   nativeCoverage.replyFloor += parity.filter(r => r.exception === 'reply-floor').length;
  }
  cuts = savedCuts();
  if (!cell.probe && !covCounted.has(cell.name)) cellRows.push({ name: cell.name, window: cell.window,
   initialRoom: limitsOf(cell).room, finalRoom: limitsOf(cell, h.manager.getBranch()).room,
   guard, requestReserves: requestLimits.map(l => l.reserve), stops, requests: promptRequests,
   cuts, opportunistic, rounds, answered, refused, hung, overflows: h.state.overflows, truncations: h.state.truncations,
   cutReserves: entries.map(e => (e.details as { diagnosticReceipt?: { settings?: { responseReserveTokens?: number } } }).diagnosticReceipt?.settings?.responseReserveTokens),
   nativeBuilds, nativeRefusals: parity, workLost, usefulExemptCuts: exemptCuts,
   failures: failures.filter(f => f.cell === cell.name),
  });
 } finally { await h.cleanup(); }
 const summary = { cells: 1, room: room > 0 ? 1 : 0, cut: cuts > 0 ? 1 : 0, cuts, answered, refused, aboveRoom: h.probes.filter(p => p.at === 'prompt' && p.complete > room).length, overflows: h.state.overflows };
 if (!cell.probe && !covCounted.has(cell.name)) { covCounted.add(cell.name); cov.cells++; cov.room += summary.room; cov.cut += summary.cut; cov.cuts += summary.cuts; cov.answered += answered; cov.refused += refused; cov.aboveRoom += summary.aboveRoom; cov.overflows += summary.overflows; cov.truncations += h.state.truncations; cov.clips += h.state.clips; }
 const summariesText = summaries.map(stripTimes).join('\n');
 return { guard, stops, summariesText, faults: [...h.faults], notices: [...h.notices], prompts: promptSizes };
}

/** What a request at this setup costs before any conversation: the guard's own measure of the smallest request that carried a prompt, less that
 *  prompt. Only a run can say, because it is the guard's measure, not the fixture's arithmetic, that every room rule is judged on. */
function measuredFloor(run: Run) {
 const smallest = Math.min(...run.prompts);
 const carrying = run.guard.filter(v => v >= smallest);
 return carrying.length ? Math.min(...carrying) - smallest : 0;
}

/** What one run of a cell is held to: the sizes it asked the model with, the answers it got, what it saved and what it said. */
interface Run { guard: number[]; stops: string[]; summariesText: string; faults: string[]; notices: string[]; prompts: number[] }

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

/** Off while the determinism repeats re-judge the same cell: their findings are counted once, from the first run, and a violation that shows only on a
 * repeat is reported as nondeterminism rather than as a second failure of the same rule. */
let COUNT = true;

function record(cell: Cell, rule: Rule, message: string, params: Record<string, unknown> = {}) {
 if (!COUNT) return;
 failures.push({ cell: cell.name, rule, message, params: { api: cell.api ?? DEFAULT_API, ...params } });
 if (failures.length <= 60) report(`FAIL [${rule}] ${cell.name}: ${message}`);
}

/** Run a cell twice more and compare the two. The repeats re-judge the same cell, so their findings are not counted again; only a difference between
 * them is reported, as nondeterminism. */
async function repeat(cell: Cell) {
 COUNT = false;
 let diff: string | undefined;
 try {
  const a = await runCell(cell);
  const b = await runCell(cell);
  diff = divergence(a, b);
 } finally { COUNT = true; }
 if (diff) record(cell, 'determinism', `the same settings answered differently: ${diff}`);
}

/** The named states, each one run whatever the grid samples. Each says what it exists to exercise and proves at the end that it got there. */
function namedCells(): Cell[] {
 const roomOf = (c: Pick<Cell, 'window' | 'reserve' | 'maxTokens'>) => limitsOf(c).room;
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
  window: 32_768, reserve: 2_048, maxTokens: 40_000, system: 800, host: 200,
  prompts: [300, 800, 300], rounds: [0, 1, 0], results: [400],
  reached: { state: 'short replies with a catalogue cap above the whole window still fit native\'s 30720-token room before any failure', check: e => e.room === 30_720 && e.answered === 3 },
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
 /** A sustained user turn with tool results, following a seeded summary and complete user/tool turns. The guard reports the actual post-cut size;
  * the tail is not assumed to survive a cut. */
 const longRun = (window: number) => {
  // A session's tool results don't grow with its window: recorded sessions add about 1.5k tokens a request at every window. A run long enough to fill
  // the room at that rate is too slow at the very largest windows, so those keep a step that scales: they are there for the floor, not the rhythm.
  if (window <= 200_000) return { prompts: [5_000], rounds: [200], results: [2_000, 1_000] };
  const step = Math.max(200, Math.min(20_000, Math.round(Math.max(0, window - SETUP_RESERVE) * 0.08)));
  return { prompts: [11_000], rounds: [60], results: [step, Math.round(step / 2)] };
 };
 const setupReached = (setup: number, band: number, hardLine: number): Reached => ({
  state: `at least one cut with the setup of ${setup} below the band of ${band}, or a noticed refusal where the setup leaves no capacity below ${hardLine}`,
  check: e => setup < band ? e.cuts >= 1 : noRoom(setup, hardLine) ? e.refused >= 1 && e.notices > 0 : e.cuts >= 1 || (e.refused >= 1 && e.notices > 0),
 });
 const setupCell = (window: number, setup: number, label = 'Pi defaults'): Cell => {
  const room = window - SETUP_RESERVE;
  return base(`setup ${setup} at window ${window} (${label})`, {
   window, reserve: SETUP_RESERVE, maxTokens: SETUP_MAX, keepRecent: SETUP_KEEP, setup,
   system: Math.max(200, setup - 500 - SETUP_SCHEMA), host: 500, // the host's view is 500 tokens and the schemas cost SETUP_SCHEMA, so the request's setup part measures the setup the cell names
   ...longRun(window),
   extra: { cutAtDefault: true, seededTail: { summary: 4_000, tail: 20_000, cycle: 2_000 } },
   reached: setupReached(setup, bandOf(Math.max(0, room), DEFAULT_CUT_AT), limitsOf({ window, reserve: SETUP_RESERVE, maxTokens: SETUP_MAX }).hardLine),
   // A setup at or above the room is arithmetic, like a cell whose reserve leaves no room: the request has no conversation left to cut.
   why: noRoom(setup, limitsOf({ window, reserve: SETUP_RESERVE, maxTokens: SETUP_MAX }).hardLine) ? 'the setup alone reaches the hard line' : undefined,
  });
 };
 const setupGrid = [2_000, 12_000, 24_000, 40_000, 60_000].flatMap(setup => [32_768, 65_536, 131_072, 1_000_000].map(window => setupCell(window, setup)));
 // R&D's replay on real recordings: the same settings at the windows those sessions actually ran at, where 1.0.10 cut 21-37 times per 100 turns and
 // 17-33% of cuts were followed by another cut on the very next request. Those windows answer to the same rules as every other cell.
 const replayWindows = [57_344, 61_440, 73_728, 81_920].map(window => setupCell(window, SETUP_SIZE, 'replay window'));
 const realPostCut = setupCell(81_920, SETUP_SIZE, 'real post-cut 49k');
 // Smaller mixed tool rounds allow the trigger to cross the margin without routinely jumping past the room. The prompt remains in the
 // protected current turn and is sized so the measured request includes a realistic setup, summary and tail together.
 realPostCut.prompts = [5_000];
 realPostCut.rounds = [100];
 realPostCut.results = [600, 600];
 realPostCut.reached = {
  state: 'a seeded summary and tool tail, with a median measured post-cut request between 40k and 55k and most cuts below the room',
  check: e => {
   const measured = [...e.postCuts].sort((a, b) => a - b);
   const median = measured[Math.floor(measured.length / 2)];
   return e.savedRoles.includes('compactionSummary') && e.savedRoles.includes('toolResult') && median !== undefined && median >= 40_000 && median <= 55_000 && e.opportunistic > e.cuts / 2;
  },
 };
 const replaySetups = [55_000, 62_000, 68_000].map(setup => setupCell(131_072, setup, 'replay setup'));
 // The replay's second prompt: at 131,072 with a 68k setup the second prompt is refused with "Complete Pi context and response reserve exceed", which
 // is Pi's own check rather than pi-tuck's. The cell asks only that the session says so, in words, and takes the prompt after it.
 // A run of tasks at a small window: each task is a longer prompt followed by short steps and tool rounds, so cuts fall while the current task is
 // several turns back. The newest task must survive every cut.
 // Tasks whose steps are long too: what follows a task can be larger than the whole quote budget, and the task must still keep its head.
 const longSteps = [32_768, 81_920].map(window => base(`a task followed by long steps at a ${window} window`, {
  window, reserve: 16_384, maxTokens: 8_192, keepRecent: 20_000, system: 1_500, host: 200,
  prompts: [2_000, 3_000, 3_000, 3_000, 3_000, 2_000, 3_000, 3_000, 3_000, 3_000], rounds: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1], results: [1_500],
 }));
 // One long spec, then many steering turns that paste logs or errors: the spec is the goal and must keep its opening through every cut.
 const specThenSteering = [32_768, 81_920].map(window => base(`a spec followed by 30 steering turns at a ${window} window`, {
  window, reserve: 16_384, maxTokens: 8_192, keepRecent: 20_000, system: 1_500, host: 200,
  prompts: [4_000, ...Array(30).fill(1_500)], rounds: Array(31).fill(1), results: [1_000],
  extra: { noOpening: true },
 }));
 const tasksSmallWindow = base('a run of tasks at a 32,768 window', {
  window: 32_768, reserve: 16_384, maxTokens: 8_192, keepRecent: 20_000, system: 1_500, host: 200,
  prompts: [2_000, 100, 100, 100, 2_500, 100, 100, 100, 3_000, 100, 100, 100, 2_000, 100, 100], rounds: [1, 2, 2, 1, 1, 2, 2, 1, 1, 2, 2, 1, 1, 2, 2], results: [1_500, 800],
 });
 // A host engine that patches a large system section in and out: 8k tokens, then 24k. Each iteration is a stand-off prompt and short steps with tool
// rounds. Two timings: the section comes with a stand-off and goes at the third, or it comes on the first step turn after a stand-off and goes at the
// next stand-off, as Nautilus does (changes of up to ~95k characters either way).
const standoffTimings: [string, (run: number) => number | null | undefined][] = [
 ['on stand-offs', run => run === 0 ? 8_000 : run === 4 ? 24_000 : run === 8 ? null : undefined],
 ['on step turns, gone at the stand-off', run => run === 1 ? 8_000 : run === 4 ? null : run === 5 ? 24_000 : run === 8 ? null : undefined],
];
const standoffSection = [65_536, 81_920].flatMap(window => [false, true].flatMap(late => standoffTimings.map(([timing, systemSection], i) => base(
 `a host patches an 8k then 24k system section${i ? ` ${timing}` : ' per iteration'} at a ${window} window, ${late ? 'after' : 'before'} pi-tuck`, {
  window, reserve: 16_384, maxTokens: 8_192, keepRecent: 20_000, system: 1_500, host: 200,
  prompts: [2_000, 100, 100, 100, 2_000, 100, 100, 100, 2_000, 100, 100, 100], rounds: [3, 3, 3, 2, 3, 3, 3, 2, 3, 3, 3, 2], results: [4_000, 2_500],
  extra: { systemSection, systemSectionLate: late },
 }))));
const replaySecond = base('setup 68000 at window 131072, second prompt (replay)', {
  window: 131_072, reserve: SETUP_RESERVE, maxTokens: SETUP_MAX, keepRecent: SETUP_KEEP, setup: 68_000, system: 68_000 - 500 - SETUP_SCHEMA, host: 500,
  prompts: [40_000, 40_000, 300], rounds: [1, 0, 0], results: [2_000],
  // On 1.0.10 the second prompt was refused with "Complete Pi context and response reserve exceed", which is Pi's own check rather than pi-tuck's. What
  // the cell holds either way is that a second prompt of the size that refused forces a cut or a refusal with a notice, and that the session takes the
  // short prompt after it: a run that let the prompt through untouched tested nothing about the replay.
  reached: { state: 'a second prompt of the size the replay refused at, cut or refused with a notice', check: e => (e.cuts >= 1 || (e.refused >= 1 && e.notices > 0)) && e.answered >= 3 },
 });
 // A fresh tool result and a fresh assistant body are the two sizes no cut drops and no request arrives without. Both cells put one just above the
 // free room as pi-tuck estimates it — the room divided by the factor the provider's usage implies, less the mandatory part — and below what the room
 // actually holds, which is the band where a clip should carry the round and a refusal is a finding.
 const freshBand = (window: number, ratio: number, floor: number) => {
  const room = window - SETUP_RESERVE;
  return { room, estimated: Math.floor(room / ratio) - floor, actual: room - floor };
 };
 const freshResult = (window: number, ratio: number, floor: number): Cell => {
  const { room, estimated, actual } = freshBand(window, ratio, floor);
  const size = Math.max(200, Math.round((estimated + actual) / 2));
  // pi-tuck clips a fresh result to half the room its own measure leaves (src/compaction.ts), and sizes the request it sends at the provider's count.
  // The prompt therefore has to be small enough that a clip sized to the room the provider actually leaves would still fit: otherwise the prompt alone
  // busts the room and the refusal is arithmetic, not the clip budget. The 400 is the summary heading and the slack of the bound that reads the run.
  const clipAware = Math.floor((room - Math.ceil(floor * ratio)) / 2);
  const prompt = Math.max(200, Math.min(2_000, Math.floor(room / ratio) - floor - clipAware - 400));
  return base(`setup ${SETUP_SIZE} with a fresh result of ${size} above the estimated room at window ${window} (factor ${ratio})`, {
   window, reserve: SETUP_RESERVE, maxTokens: SETUP_MAX, keepRecent: SETUP_KEEP, setup: SETUP_SIZE, system: SETUP_SIZE - 500 - SETUP_SCHEMA, host: 500,
   usageRatio: ratio, prompts: [prompt, 200], rounds: [1, 0], results: [size],
   // The inequality is checked against what the request measured, not only against what the cell asked for: the conversation the prompt left behind is
   // read off the guard's own measure of the request the result went into, so the free room is the one pi-tuck had in front of it.
   reached: { state: `a fresh result of ${size} above the free room as pi-tuck estimates it and below what the room holds`, check: e => freshResultFits(e, size) },
  });
 };
 const freshAssistant = (window: number, ratio: number, floor: number, reserve = SETUP_RESERVE): Cell => {
  const { estimated, actual } = freshBand(window, ratio, floor);
  const size = Math.max(200, Math.round(estimated * 1.05));
  return base(`setup ${SETUP_SIZE} with a fresh assistant body of ${size} above the estimated room at window ${window} (factor ${ratio})`, {
   window, reserve, maxTokens: SETUP_MAX, keepRecent: SETUP_KEEP, setup: SETUP_SIZE, system: SETUP_SIZE - 500 - SETUP_SCHEMA, host: 500,
   usageRatio: ratio, prompts: [200, 200], rounds: [1, 0], results: [200], extra: { replyTokens: request => (request === 1 ? size : 0) },
   reached: { state: `a fresh assistant body of ${size} above the free room as pi-tuck estimates it and below what the room holds`, check: e => freshBodyFits(e, size) },
  });
 };
 // ---- provider behaviour, faked ----
 // Real-provider checks are barred, so these cells are the only coverage of provider behaviour and no test here calls a hosted API. The scripted
 // model speaks the provider's own words: these are the strings Pi lists in pi-ai's utils/overflow.js, sent when the request is over the window.
 // Each cell makes the request go over by the tokenizer's density, which is how it happens in the field: the guard's measure stays inside the room
 // and the provider's count is over its window. The first request of a session is planned before any usage has reported a factor, so pi-tuck sends it
 // without knowing, and what the session does next is the finding.
 const providerCell = (label: string, extra: Partial<Options>, over: Partial<Cell> = {}): Cell => base(`provider: ${label}`, {
  window: 16_384, reserve: 2_048, maxTokens: 2_048, system: 600, host: 400, usageRatio: 1.9,
  prompts: [9_000, 300, 300], rounds: [0, 0, 0], results: [], reached: { state: 'a request the scripted provider rejected for its own window, in wording pi-ai classes as an overflow', check: e => e.overflows >= 1 && e.piOverflow >= 1 }, ...over,
  extra: { rejectWith: 'the request exceeds the available context size, try increasing it', ...extra },
 });
 const providerCells = [
  providerCell('Anthropic rejects the prompt', { rejectWith: 'prompt is too long: 21000 tokens > 20000 maximum' }),
  providerCell('OpenAI rejects the prompt', { rejectWith: 'Your input exceeds the context window of this model. Please adjust your input.' }),
  providerCell('Google rejects the prompt', { rejectWith: 'The input token count (21000) exceeds the maximum number of tokens allowed (20000).' }),
  providerCell('llama.cpp rejects the prompt', { rejectWith: 'the request exceeds the available context size, try increasing it' }),
  // `providerRejection` on the two cells below: pi-ai does not class either wording as a context overflow, so Pi ends the turn on the provider's
  // error and never asks pi-tuck to reduce the request. A refusal or a notice finding would hold pi-tuck to a room the provider never showed it,
  // so the cell states the `provider` rules instead — see the Cell field. `persist` gives those rules a session file to reopen.
  providerCell('HTTP 413 with no body', { rejectWith: '', rejectStatus: 413, persist: true }, { providerRejection: true, reached: { state: 'a bodyless HTTP 413, which pi-ai classes as an overflow only for a Cerebras request', check: e => e.overflows >= 1 && e.piOverflow === 0 } }),
  // A wording Pi does not recognise arrives as a plain provider error. The session must still take the next prompt, and pi-tuck must not fault on its
  // own: an unrecognised refusal is the host's business, and pi-tuck's job is to leave the session able to answer it.
  providerCell('a wording Pi does not recognise', { rejectWith: 'upstream refused: too many bytes for this deployment', persist: true }, { providerRejection: true, reached: { state: 'a refusal in wording pi-ai does not class as an overflow', check: e => e.overflows >= 1 && e.piOverflow === 0 } }),
  // A server that keeps the end of an oversize request answers it anyway and reports usage equal to the window, so the session's own count comes back
  // smaller than the context it believes it sent. The Xiaomi variant Pi lists reports a stop for length with no output at all. The density has to be
  // the one that puts the provider's count over its window while pi-tuck's measure of the same request is still inside the room (14,336): 1.35x does it.
  // pi-ai's silent-overflow check wants input *above* the window, so a server that reports exactly the window passes it for an answer; the Xiaomi
  // variant, a length stop with no output and the window read back as input, is the one it catches.
  providerCell('silent truncation, answered normally', { truncateOverWindow: 'stop' }, { usageRatio: 1.35, prompts: [12_000, 300, 300], reached: { state: 'a truncated reply whose usage equals the window, which pi-ai reads as an answer rather than an overflow', check: e => e.truncations >= 1 && e.piOverflow === 0 } }),
  providerCell('silent truncation, stop for length and no output', { truncateOverWindow: 'lengthZero' }, { usageRatio: 1.35, prompts: [12_000, 300, 300], reached: { state: 'a length stop with no output filling the window, which pi-ai classes as an overflow', check: e => e.truncations >= 1 && e.piOverflow >= 1 } }),
 ];
 // Above-cap cells use the same prompts and oracle on both builds. The first prompt fits native's room but not 1.0.19's; later tool rounds
 // exercise recovery and the unchanged thrash rule (at least 12 rounds). A short final prompt must finish even after a provider failure.
 const replyReserveCells = [
  { window: 81_920, reserve: 16_384, maxTokens: 32_768, prompt: 54_000, result: 1_000 },
  { window: 16_384, reserve: 2_048, maxTokens: 8_192, prompt: 10_000, result: 250 },
 ].flatMap(size => (['clip', 'refuse'] as const).map(replyWindow => base(`reply reserve: window ${size.window}, ${replyWindow}`, {
  ...size, system: 600, host: 200, prompts: [size.prompt, ...Array(5).fill(200)], rounds: [0, 3, 3, 3, 3, 0], results: [size.result],
  extra: { replyWindow, replyWindowOutput: request => request === 1 ? size.maxTokens : 48, persist: true, noOpening: true },
  reached: { state: 'a cap above the reserve, then 12 tool rounds and a completed recovery prompt',
   check: e => e.requests.length === 6 && e.requests[1]! >= 4 && e.requests.at(-1)! > 0 && e.answered >= 5 && e.results.length >= 12 &&
    (e.requests[0] === 0 || (replyWindow === 'clip' ? e.truncations === 1 : e.overflows === 1 && e.piOverflow >= 1)) },
 })));
 // Both fake transports exercise the new admission band, actual output exhaustion and input overflow.
 const floorCells = ['openai-codex', 'openai'].flatMap(provider => {
  const model = { provider, id: 'gpt-6.1-sol' };
  const common = { window: 65_536, reserve: 16_384, maxTokens: 32_768, system: 600, host: 200,
   prompts: [50_000, 200, 200], rounds: [0, 1, 0], results: [100], api: `fake ${provider}` };
  return [
   base(`floor failure: ${provider} length at window end`, { ...common,
    extra: { model, stableHost: true, replyWindow: 'clip', replyWindowOutput: n => n === 1 ? 32_768 : 48, persist: true, noOpening: true },
    reached: { state: 'one length stop at the physical window end followed by an answered next prompt', check: e => e.truncations === 1 && e.requests[1]! >= 2 && e.requests.at(-1)! > 0 && e.answered >= 2 },
   }),
   base(`floor failure: ${provider} input overflow`, { ...common, usageRatio: 1.4,
    extra: { model, stableHost: true, persist: true, noOpening: true },
    reached: { state: 'an input over the provider window refused as context overflow, then an answered next prompt', check: e => e.overflows >= 1 && e.piOverflow >= 1 && e.requests[1]! >= 2 && e.requests.at(-1)! > 0 && e.answered >= 2 },
   }),
   base(`floor setup: ${provider} setup between room and hard line`, {
    // Above the former 8,192-floor line, below the new 4,096-floor line; the first reply needs the full new minimum.
    window: 32_768, reserve: 16_384, maxTokens: 8_192, setup: 26_000, system: 25_448, host: 500,
    prompts: [200, 200, 200], rounds: [0, 2, 0], results: [200], api: `fake ${provider}`,
    extra: { model, stableHost: true, seededTail: { summary: 4_000, tail: 20_000, cycle: 2_000 }, replyWindow: 'clip', replyWindowOutput: n => n === 1 ? 4_096 : 2_048, persist: true, noOpening: true, cutAtDefault: true },
    reached: { state: 'setup above room, the first reply uncut, all prompts answered and at least one cut', check: e => e.truncations === 0 && e.maxAssistant >= 4_096 && e.guard[0]! > e.room && e.answered === 3 && e.refused === 0 && e.cuts >= 1 },
   }),
  ];
 });
 // A transient provider error is not a reply that did not fit: after a 503 the branch keeps native's room, so a prompt that fits native's room but
 // not the output cap's is answered, not refused or cut for want of room.
 replyReserveCells.push(base('reply reserve: window 81920, a 503 keeps native room', {
  window: 81_920, reserve: 16_384, maxTokens: 32_768, system: 600, host: 200, prompts: [200, 54_000, 200], rounds: [0, 0, 0], results: [100],
  extra: { transientErrorAt: request => request === 1, persist: true, noOpening: true },
  // The 503 is the provider's own error, not a pi-tuck refusal: the provider rules judge prompt 1, as for the HTTP 413 cell.
  providerRejection: true,
  reached: { state: 'a 503 on the first request, then a prompt above the cap room and below native room', check: e => e.requests.length === 3 && e.requests[1]! > 0 && e.answered >= 2 },
 }));
 // Usage that is a wrong observation rather than no observation: a count that jumps tenfold for one reply, a count of zero beside a cache that holds
 // the whole session, and a count that adds the cached tokens to the input as well. Each must leave the session taking its next prompt. The cell
 // records the report the scripted model actually sent, so reaching the state is that the odd usage went out, not that the cell asked for one.
 type UsagePatch = ReturnType<NonNullable<Options['usageAt']>>;
 const oddUsage = (label: string, at: (request: number, measured: number) => UsagePatch, state: string): Cell => {
  const fired: number[] = [];
  const cell = base(`usage: ${label}`, {
   window: 32_768, reserve: 4_096, maxTokens: 4_096, system: 800, host: 200, usageRatio: 1.1,
   prompts: [4_000, 6_000, 8_000, 300], rounds: [1, 1, 0, 0], results: [1_500],
   extra: { usageAt: (request, measured) => { const patch = at(request, measured); if (Object.keys(patch).length) fired.push(request); return patch; } },
   reached: { state, check: e => fired.length >= 1 && e.counts.some(c => c.known) },
  });
  cell.reset = () => { fired.length = 0; };
  return cell;
 };
 const oddUsageCells = [
  oddUsage('jumps tenfold on one reply and returns', (request, count) => request === 3 ? { input: count * 10 } : {}, 'a reply whose usage was ten times the request before it'),
  oddUsage('input zero beside a large cache read', request => request === 2 ? { input: 0, cacheRead: 60_000 } : {}, 'a reply that reported no input and a 60,000-token cache'),
  oddUsage('counts the cached tokens twice', (request, count) => request === 2 ? { input: count, cacheRead: count } : {}, 'a reply whose usage counted the cache in the input as well'),
 ];
 // The five cells from Scoops replays that refused mid-run. Their sizes are set against the free room pi-tuck leaves, and only the guard's own measure
 // of the request says what that is, so each is built twice: once as a probe to measure the floor, once at the floor the probe measured.
 calibrationCells.push(
  floor => freshResult(57_344, 1.25, floor),
  floor => freshResult(61_440, 1.25, floor),
  floor => freshResult(65_536, 1.25, floor),
  floor => freshAssistant(61_440, 1.44, floor),
  floor => freshAssistant(32_768, 1.44, floor),
 );
 return [
  atDefaults(32_768), atDefaults(65_536), atDefaults(131_072), atDefaults(1_000_000),
  keepAt(1), keepAt(2),
  promptOverRoom, promptOverWindow, resultOverWindow, reopened, aborted, stalled,
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
  ...setupGrid, ...replayWindows, realPostCut, ...replaySetups, replaySecond, ...standoffSection, tasksSmallWindow, ...longSteps, ...specThenSteering,
  ...providerCells, ...replyReserveCells, ...floorCells, ...oddUsageCells,
 ];
}

/** The inequality the cell exists to hold, measured against the guard's own floor: the fresh result is bigger than the free room as pi-tuck's
 *  calibration leaves it beside the setup, and smaller than what the room actually holds. In that band a clip carries the round and the request fits,
 *  so a refusal there is a finding. Reaching the state is the message really being sent at that size, which the harness records itself, and the free
 *  room being what the cell sized it against. */
function freshResultFits(e: Evidence, size: number) {
 return Math.abs(e.maxFresh - size) <= 4 && freeRoomHolds(size, e);
}
/** The same for a fresh assistant body, which no cut drops and no clip reaches: it sits in the request that answers the round it came from. A setup
 *  that leaves no free room at all is arithmetic, like the no-room cells: the cell reaches when the run refused or cut on it. */
function freshBodyFits(e: Evidence, size: number) {
 // A setup that leaves no free room at all is arithmetic, like the no-room cells: nothing of the cell's own sizing ever gets sent, so the cell reaches
 // when the run refused or cut on the setup alone.
 if (e.room - e.floor <= 0) return e.floor + e.reserve >= e.window && (e.refused >= 1 || e.cuts >= 1);
 return Math.abs(e.maxAssistant - size) <= 40 && freeRoomHolds(size, e);
}
const freeRoomHolds = (size: number, e: Evidence) => size > Math.floor(e.room / e.factor) - e.floor && size < e.room - e.floor;

test(`settings stress: ${CELLS} sampled cells and the named edge cases`, { timeout: 0 }, async () => {
 if (!RUN) return;
 const started = Date.now();
 for (let i = 0; i < CELLS; i++) {
  const cell = sample(i);
  if (ONLY && !cell.name.includes(ONLY)) continue;
  if (SETUP_ONLY && cell.setup === undefined) continue;
  ran.push(cell.name); apis.add(cell.api ?? DEFAULT_API);
  try { await runCell(cell); } catch (error) { record(cell, 'harness', `the cell could not run: ${String(error).slice(0, 300)}`); }
  if (i % SAMPLE_EVERY !== 0) continue;
  try { await repeat(cell); } catch (error) { record(cell, 'harness', `the repeat could not run: ${String(error).slice(0, 300)}`); }
 }
 for (const cell of namedCells()) {
  if (ONLY && !cell.name.includes(ONLY)) continue;
  if (SETUP_ONLY && SETUP_ONLY !== '1' && !cell.name.includes(SETUP_ONLY)) continue;
  ran.push(cell.name); apis.add(cell.api ?? DEFAULT_API);
  try { await runCell(cell); } catch (error) { record(cell, 'harness', `the case could not run: ${String(error).slice(0, 300)}`); }
  // The determinism check runs the cell twice more and compares, sampled cells and named ones alike, under STRESS_STRICT as well.
  try { await repeat(cell); } catch (error) { record(cell, 'harness', `the repeat could not run: ${String(error).slice(0, 300)}`); }
 }
 // The two cells that size a fresh message against the free room can only be sized by measurement: what pi-tuck has room for depends on the floor its
 // own guard reads, and that is not known until the harness exists. The first pass is the probe, and the second is the cell.
 for (const build of calibrationCells) {
  if (ONLY && !build(SETUP_SIZE + SETUP_OVERHEAD).name.includes(ONLY)) continue;
  if (SETUP_ONLY && SETUP_ONLY !== '1' && !build(SETUP_SIZE + SETUP_OVERHEAD).name.includes(SETUP_ONLY)) continue;
  const probe = await runCell({ ...build(SETUP_SIZE + SETUP_OVERHEAD), probe: true });
  const floor = measuredFloor(probe);
  // A cell whose setup leaves no free room at all cannot be probed: nothing gets a request through to measure. Its assumed floor stands, and the cell
  // is the arithmetic case, whose `reached` says so.
  const sized = build(floor > 0 ? floor : SETUP_SIZE + SETUP_OVERHEAD);
  ran.push(sized.name); apis.add(sized.api ?? DEFAULT_API);
  await runCell(sized);
  await repeat(sized);
 }
 // Every rule holds after the last cell, so a finding is reported whatever the order the cells ran in.
 if (failures.length > 60) report(`stress: ${failures.length - 60} further failures not printed above`);

 if (REPORT) mkdirSync('test/stress', { recursive: true });
 const byClass = new Map<Rule, { count: number; cells: Set<string> }>();
 for (const f of failures) { const row = byClass.get(f.rule) ?? { count: 0, cells: new Set<string>() }; row.count++; row.cells.add(f.cell); byClass.set(f.rule, row); }
 const sorted = [...byClass.entries()].sort((a, b) => b[1].count - a[1].count);
 report(`\nstress: cells run ${ran.length}, failures ${failures.length}, top failure class ${sorted[0]?.[0] ?? 'none'}`);
 // What the grid actually reached. A run that cut nothing tested nothing, and this line is where that shows.
 report(`stress: coverage: cells with room ${cov.room}/${cov.cells}, cells with a cut ${cov.cut}/${cov.cells}, total cuts ${cov.cuts}, prompts answered ${cov.answered}, prompts refused ${cov.refused}, prompts planned above the room ${cov.aboveRoom}, provider overflows ${cov.overflows}, provider truncations ${cov.truncations}, clips ${cov.clips}`);
 report(`stress: cut-target: ${cappedCuts} generated cuts checked, largest overshoot ${Number.isFinite(largestCutOvershoot) ? largestCutOvershoot : 0}`);
 report(`stress: useful-cut exemption: ${usefulExemptCells.size} cells, ${usefulExemptCuts} forced cuts (setup + prompt above room)`);
 report(`stress: native-parity coverage: ${JSON.stringify(nativeCoverage)}`);
 report('class           failures  cells  examples');
 for (const [rule, row] of sorted) report(`${rule.padEnd(15)}  ${String(row.count).padStart(8)}  ${String(row.cells.size).padStart(5)}  ${[...row.cells].slice(0, 2).join(' | ')}${row.cells.size > 2 ? ` | +${row.cells.size - 2} more` : ''}`);
 // One row per named setup cell. A pass/fail table cannot show a run that is near the limit and still under it, and that is where a session spends
 // its life: `near` marks the cells whose cuts per round are within a third of the thrash limit without crossing it.
 if (setupRows.length) {
  report('window    setup   floor   initial-band  post-cut  rounds  cuts  below  below/round  next%  mean-freed  verdict  cell');
  for (const r of setupRows) {
   const over = r.setup >= r.band;
   const verdict = noRoom(r.setup, r.hardLine) ? 'no room' : r.rounds < 12 ? `${r.cuts ? 'cut' : 'no cut'}, short run` : r.thrashes ? 'thrash' : r.perRound * THRASH_ROUNDS >= 0.67 ? 'near limit' : r.cuts === 0 ? over ? 'no cut, setup over band' : 'no cut' : over ? 'ok, setup over band' : 'ok';
   report(`${String(r.window).padStart(7)}  ${String(r.setup).padStart(6)}  ${String(r.floor).padStart(6)}  ${String(r.band).padStart(12)}  ${String(r.postCut ?? '-').padStart(8)}  ${String(r.rounds).padStart(6)}  ${String(r.cuts).padStart(4)}  ${String(r.opportunistic).padStart(5)}  ${r.perRound.toFixed(3).padStart(11)}  ${String(Math.round(r.nextShare * 100)).padStart(5)}  ${String(r.meanFreed).padStart(10)}  ${verdict}  ${r.name}`);
  }
  report(`stress: setup cells ${setupRows.length}, thrashing ${setupRows.filter(r => r.thrashes).length}, cutting nothing ${setupRows.filter(r => r.cuts === 0).length}`);
 }
 // Whether pi-ai classes each provider's wording as a context overflow is what decides if the host compacts and retries at all, so the run says it
 // per cell instead of leaving it inside a pass. A cell whose expectation was wrong shows up here as well as in its own hollow failure.
 if (providerRows.length) {
  report('provider cell                          the scripted provider  pi-ai calls it an overflow');
  for (const r of providerRows) report(`${r.name.padEnd(35)}  ${r.saw.padStart(12)}  ${r.pi ? `yes, ${r.pi} repl${r.pi > 1 ? 'ies' : 'y'}` : 'no'}`);
 }
 if (REPORT) {
  writeFileSync('test/stress/failures.json', JSON.stringify({ seed: SEED, cells: CELLS, ran: ran.length, coverage: cov, nativeCoverage, usefulCutExemption: { cells: [...usefulExemptCells], cuts: usefulExemptCuts }, cap: { cuts: cappedCuts, largestOvershoot: Number.isFinite(largestCutOvershoot) ? largestCutOvershoot : 0 }, rows: cellRows, failures }, null, 1));
  report(`stress: wrote ${failures.length} failures to test/stress/failures.json`);
 }
 report(`stress: ran ${ran.length} cells in ${((Date.now() - started) / 1000).toFixed(1)}s on ${[...apis].join(', ')}`);
 // The assertion comes last, so the summary, the coverage line and the class table are printed even when the run is failing.
 if (STRICT) expect(failures.length, `${failures.length} rule violations; the table above`).toBe(0);
});
