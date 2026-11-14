/** Cold file-backed resume on the settings grid. No hosted provider or semantic worker is started.
 * STRESS=1 STRESS_STRICT=1 npx vitest run test/stress/resume-stress.test.ts --testTimeout=1800000
 * RESUME_ONLY narrows this suite by shape name; STRESS_CELLS uses the original sampled-grid size.
 * Reports include unreachable checkpoints rather than substituting a different point in the script.
 */
import { expect, test, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { isContextOverflow } from '@earendil-works/pi-ai/utils/overflow';
import { nonSystem } from '../budget-fixture';
import {
 calibrationCells, gridFailures, limitsOf, measureCell, measuredFloor, namedCells, runCell, sample,
 type Cell, type GridHooks, type Harness,
} from './settings-grid';

const RUN = /^(1|true|yes)$/i.test(process.env.STRESS ?? '');
const STRICT = /^(1|true|yes)$/i.test(process.env.STRESS_STRICT ?? '');
const ONLY = process.env.RESUME_ONLY ?? process.env.STRESS_ONLY;
const N = Math.max(1, Number(process.env.STRESS_CELLS) || 200);
const say = (s: string) => process.stderr.write(`resume: ${s}\n`);
// The settings grid's replay-size tolerance (divergence); no new token tolerance.
const TOLERANCE = 4;
type Pause = { prompt: number; round: number; afterCut: boolean };
type Point = 'a:after-saved-cut' | 'b:before-cut-turn' | 'c:tool-then-continue' | 'd:after-output-limit' | 'e:after-refusal';
const POINTS: Point[] = ['a:after-saved-cut', 'b:before-cut-turn', 'c:tool-then-continue', 'd:after-output-limit', 'e:after-refusal'];
type Cut = { id: string; prompt: number; afterRequest: number; ordinal: number; reason: string; before?: number; factor?: number; response?: number; room?: number };
type Request = { prompt: number; ordinal: number; request: number; raw: number; count: number; factor?: number; cap?: number; stop?: string; overflow: boolean; truncation: boolean };
type Budget = { afterRequest: number; raw: number; corrected: number; factor: number; response: number; room: number; hardLine?: number };
type Step = { prompt: number; before: number; after: number; cuts: number; lastIsCut: boolean; lastStop?: string; refused: boolean; saved: number; lastRole?: string; factor?: number; durable: boolean };
type Trace = { requests: Request[]; steps: Step[]; cuts: Cut[]; budgets: Budget[]; failures: ReturnType<typeof gridFailures>; cold?: { prompt: number; afterRequest: number; entries: number; file: string; receipt?: unknown }; paused: boolean; error?: string };
type Verdict = { pass: boolean; requests: string[]; details?: unknown[] };
type Row = { shape: string; provider: string; factor: number; window: number; point: Point; status: string; reason?: string; checkpoint?: number; unpairedRequests?: string[]; rules?: Record<string, Verdict>; precision?: { resumed: number; uninterrupted: number; delta: number; percentRoom: number; requestsUntilMatchingCut: number | null; remainingRequests: number }; resumed?: Trace; native?: Trace; uninterrupted?: Trace };

// Identical prompt text in all arms; request/tool scripts retain their original absolute counters across resume.
function script(cell: Cell, pause?: Pause) {
 const prompts = [...cell.prompts], rounds = [...cell.rounds];
 let split = -1;
 if (pause) {
  split = pause.prompt;
  if (split >= 0) {
   prompts.splice(split + 1, 0, 2); rounds.splice(split + 1, 0, Math.max(0, rounds[split]! - pause.round)); rounds[split] = pause.round;
  }
 }
 let unique = 0;
 const bodies = prompts.map((n, p) => {
  if (p === split + 1 && split >= 0) return 'continue';
  const want = Math.min(120_000, Math.max(20, n)) * 4;
  let body = `Resume workload prompt ${p + 1}. `;
  while (body.length < want) body += `item ${(++unique).toString(36)} data; `;
  return body.slice(0, want);
 });
 return { prompts, rounds, bodies, split };
}

async function arm(source: Cell, plainPi: boolean, checkpoint: number | undefined, pause?: Pause): Promise<Trace> {
 const trace: Trace = { requests: [], steps: [], cuts: [], budgets: [], failures: [], paused: false };
 const plan = script(source, pause);
 let p = 0, start = 0, guardStart = 0, cutsSeen = new Set<string>();
 let lastFactor: number | undefined;
 const beforeFailures = gridFailures().length;
 const cell: Cell = { ...source,
  prompts: plan.prompts, rounds: plan.rounds, reached: undefined,
  stallPrompt: source.stallPrompt !== undefined && plan.split >= 0 && source.stallPrompt - 1 > plan.split ? source.stallPrompt + 1 : source.stallPrompt,
  extra: { ...source.extra, persist: true, reopen: false, stableHost: true, trackRuntimeSpies: false,
   compaction: { ...source.extra?.compaction, observeBudget: m => {
    lastFactor = m.factor;
    trace.budgets.push({ afterRequest: activeHarness?.state.requests ?? 0,
     raw: m.rawTokens, corrected: m.tokens, factor: m.factor, response: m.response, room: m.room, hardLine: m.hardLine });
   } },
  },
 };
 let activeHarness: Harness | undefined;
 const captureCuts = (h: Harness) => {
  for (const e of h.manager.getEntries()) {
   if (e.type !== 'compaction' || cutsSeen.has(e.id)) continue;
   cutsSeen.add(e.id);
   const r = (e.details as any)?.diagnosticReceipt;
   trace.cuts.push({ id: e.id, prompt: p, afterRequest: h.state.requests, ordinal: h.state.requests - start,
    reason: r?.reason ?? 'native', before: r?.before?.value, factor: r?.settings?.calibrationFactor,
    response: r?.settings?.responseReserveTokens, room: r ? cell.window - r.settings.responseReserveTokens : undefined });
  }
 };
 const observeSavedCuts = (h: Harness) => {
  const manager = h.manager, append = manager.appendCompaction.bind(manager);
  manager.appendCompaction = (...args) => {
   const result = append(...args);
   captureCuts(h); // after the native file append succeeds, before another request can start
   if (pause?.afterCut && !plainPi && p === pause.prompt && h.state.requests - start === pause.round && !trace.paused) {
    trace.paused = true;
    h.session.agent.abort();
   }
   return result;
  };
 };
 const hooks: GridHooks = {
  body: i => plan.bodies[i]!,
  paused: i => Boolean(pause && i === plan.split && trace.paused),
  ready(h) {
   activeHarness = h;
   cutsSeen = new Set(h.manager.getEntries().filter(e => e.type === 'compaction').map(e => e.id));
   observeSavedCuts(h);
   h.observeExtension(pi => pi.on('turn_end', event => {
    captureCuts(h);
    if (pause && (!pause.afterCut || plainPi) && p === plan.split && h.state.requests - start >= pause.round && !trace.paused && event.toolResults.length) {
     // Pi has persisted both the assistant and tool result before this public boundary. A graceful quit aborts further work.
     trace.paused = true;
     h.session.agent.abort();
    }
   }));
  },
  async beforePrompt(h, i) {
   p = i; start = h.state.requests; guardStart = h.guard.length;
   if (i === checkpoint) {
    if (pause && !trace.paused) throw Error('The scripted tool boundary was never reached; cannot resume faithfully');
    const before = JSON.stringify(h.manager.buildSessionProjection().messages);
    const cold = await h.coldResume();
    observeSavedCuts(h);
    expect(JSON.stringify(h.manager.buildSessionProjection().messages)).toBe(before);
    const latestCut = h.manager.getBranch().findLast(e => e.type === 'compaction');
    trace.cold = { ...cold, prompt: i, afterRequest: start,
     receipt: (latestCut?.type === 'compaction' ? latestCut.details as any : undefined)?.diagnosticReceipt?.settings };
   }
  },
  afterPrompt(h, i) {
   captureCuts(h);
   const branch = h.manager.getBranch();
   for (let j = start; j < h.state.requests; j++) {
    const answer = h.state.answers[j];
    const raw = h.guard[guardStart + j - start]!;
    const count = h.state.counts[j]?.count ?? 0;
    const tool = answer?.stopReason === 'toolUse';
    const replyClip = source.extra?.replyWindow === 'clip' && !tool && answer?.stopReason === 'length';
    trace.requests.push({ prompt: i, ordinal: j - start, request: j + 1, raw, count,
     factor: trace.budgets.findLast(b => b.afterRequest === j)?.factor,
     cap: h.state.requestOptions[j]?.maxTokens, stop: answer?.stopReason,
     overflow: Boolean(answer?.usage && isContextOverflow(answer, cell.window)),
     truncation: Boolean(source.extra?.truncateOverWindow && count > cell.window || replyClip),
    });
   }
   const last = branch.at(-1), lastAnswer = h.state.answers.at(-1);
   trace.steps.push({ prompt: i, before: start, after: h.state.requests, cuts: trace.cuts.length,
    lastIsCut: last?.type === 'compaction', lastStop: h.state.requests > start ? lastAnswer?.stopReason : undefined,
    refused: !hooks.paused?.(i) && (h.state.requests === start || !h.state.answers.slice(start).some(a => a.stopReason === 'stop')),
    saved: nonSystem(h.saved()), lastRole: last?.type === 'message' ? last.message.role : last?.type, factor: lastFactor,
    durable: Boolean(h.manager.getSessionFile() && existsSync(h.manager.getSessionFile()!)) });
  },
 };
 try {
  if (plainPi) await measureCell(cell, true, hooks); else await runCell(cell, hooks);
 } catch (e) { trace.error = String(e); }
 // ModelRuntime spies otherwise retain every old runtime and its session closures for the entire grid.
 vi.clearAllMocks(); vi.restoreAllMocks();
 trace.failures = gridFailures().slice(beforeFailures);
 return trace;
}

function verdict(requests: string[], details: unknown[] = []): Verdict { return { pass: requests.length === 0, requests: [...new Set(requests)], ...(details.length ? { details } : {}) }; }
function compare(cell: Cell, point: Point, checkpoint: number, warm: Trace, resumed: Trace, native: Trace): Row {
 const start = resumed.cold!.afterRequest;
 const sent = resumed.requests.filter(r => r.prompt >= checkpoint);
 const paired = (r: Request, arm: Trace) => arm.requests.find(n => n.prompt === r.prompt && n.ordinal === r.ordinal);
 const label = (r: Request) => `#${r.request} (p${r.prompt + 1}.${r.ordinal + 1})`;
 const unpairedRequests = sent.filter(r => !paired(r, native)).map(label);
 const larger = sent.filter(r => { const n = paired(r, native); return n && r.raw > n.raw + TOLERANCE; });
 const overflow = sent.filter(r => { const n = paired(r, native); return (r.overflow || r.truncation) && n && !n.overflow && !n.truncation; });
 const failures = resumed.failures.filter(f => {
  const prompt = Number(f.params.prompt);
  const refusal = f.params.clause === 'refusal' ? Number(f.params.prompt) : NaN;
  return Number.isFinite(prompt) ? prompt >= checkpoint + 1 : Number.isFinite(refusal) ? refusal >= checkpoint + 1 : true;
 });
 const rules: Record<string, Verdict> = {
  '1:request-size': verdict(larger.map(label), larger.map(r => ({ request: r.request, tuck: r.raw, native: paired(r, native)?.raw, warm: paired(r, warm)?.raw }))),
  '2:cut-point': verdict(failures.filter(f => f.params.clause === 'forced-point').map(f => {
   const cut = resumed.cuts.find(c => c.id === f.params.entryId);
   return cut ? `after #${cut.afterRequest} p${cut.prompt + 1}.${cut.ordinal}` : String(f.params.entryId);
  }), failures.filter(f => f.params.clause === 'forced-point')),
  '3:early-refusal': verdict(failures.filter(f => f.params.clause === 'refusal' || ['refusal', 'clip-room', 'no-clip', 'fresh-room'].includes(f.rule)).map(f => `after #${(f.params as any).afterRequest ?? resumed.steps.find(s => s.prompt + 1 === Number(f.params.prompt))?.after ?? '?'} p${f.params.prompt}`), failures.filter(f => f.params.clause === 'refusal' || ['refusal', 'clip-room', 'no-clip', 'fresh-room'].includes(f.rule))),
  '4:overflow-truncation': verdict(overflow.map(label), overflow.map(r => ({ ...r, native: paired(r, native) }))),
  'lost-prompt': verdict(failures.filter(f => ['lost-prompt', 'task-turn'].includes(f.rule)).map(f => `p${f.params.prompt}`)),
  'stranded': verdict(failures.filter(f => ['no-recovery', 'stuck', 'harness'].includes(f.rule)).map(f => f.message)),
  'thrash': verdict(failures.filter(f => ['thrash', 'useful-cut'].includes(f.rule)).map(f => f.message)),
  'grid-other': verdict(failures.filter(f => !['lost-prompt', 'task-turn', 'no-recovery', 'stuck', 'harness', 'thrash', 'useful-cut', 'native-parity', 'refusal', 'clip-room', 'no-clip', 'fresh-room'].includes(f.rule)).map(f => f.message)),
 };
 const first = sent[0], prior = first && paired(first, warm);
 const matching = resumed.cuts.filter(c => c.prompt >= checkpoint).find(c => warm.cuts.some(w => w.prompt === c.prompt && w.ordinal === c.ordinal && w.reason === c.reason));
 const room = limitsOf(cell).room;
 const precision = first && prior ? { resumed: first.raw, uninterrupted: prior.raw, delta: first.raw - prior.raw,
  percentRoom: (first.raw - prior.raw) * 100 / room,
  requestsUntilMatchingCut: matching ? Math.max(0, matching.afterRequest - start) : null, remainingRequests: sent.length } : undefined;
 return { shape: cell.name, provider: cell.extra?.model?.provider ?? 'openai-codex', factor: cell.usageRatio ?? 1,
  window: cell.window, point, checkpoint: checkpoint + 1, status: Object.values(rules).every(v => v.pass) ? 'pass' : 'fail', unpairedRequests, rules, precision, resumed, native, uninterrupted: warm };
}

function checkpoint(point: Point, warm: Trace): number | undefined {
 const steps = warm.steps;
 if (point.startsWith('b:')) {
  const cut = warm.cuts.find(c => c.prompt > 0 && c.reason === 'prompt');
  return cut?.prompt;
 }
 const step = steps.find(s => s.prompt < steps.length - 1 &&
  (point.startsWith('a:') ? s.lastIsCut && s.cuts > (steps[s.prompt - 1]?.cuts ?? 0) :
   point.startsWith('d:') ? s.lastStop === 'length' : s.refused));
 return step ? step.prompt + 1 : undefined;
}

function precisionSummary(rows: Row[]) {
 const values = rows.filter(r => r.status === 'pass' && !r.unpairedRequests?.length && r.precision).map(r => r.precision!);
 const sorted = values.map(p => Math.abs(p.percentRoom)).sort((a, b) => a - b);
 const median = sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)]! + sorted[Math.floor(sorted.length / 2)]!) / 2 : null;
 return { count: values.length, medianAbsolutePercentRoom: median, maxAbsolutePercentRoom: sorted.at(-1) ?? null,
  signedPercentRoom: values.map(v => v.percentRoom), requestsUntilMatchingCut: values.map(v => v.requestsUntilMatchingCut), censored: values.filter(v => v.requestsUntilMatchingCut === null).length };
}

const unsupported = (cell: Cell, point: Point, reason: string): Row => ({ shape: cell.name, provider: cell.extra?.model?.provider ?? 'openai-codex', factor: cell.usageRatio ?? 1, window: cell.window, point, status: 'not-reached', reason });

/** Bounded workers keep Vitest's re-evaluated module graphs from retaining gigabytes across thousands of cold imports. */
async function runShards() {
 const dir = mkdtempSync(join(tmpdir(), 'pi-tuck-resume-shards-'));
 const cli = join(dirname(createRequire(import.meta.url).resolve('vitest/package.json')), 'vitest.mjs');
 const shards = 16, rows: Row[] = [];
 let shapes = 0;
 for (let shard = 0; shard < shards; shard++) {
  const output = join(dir, String(shard)); mkdirSync(output, { recursive: true });
  const log = join(output, 'runner.log');
  let printed = '';
  const child = spawn(process.execPath, [cli, 'run', 'test/stress/resume-stress.test.ts', '--maxWorkers=1', '--testTimeout=1800000'], {
   cwd: process.cwd(), env: { ...process.env, RESUME_SHARD: String(shard), RESUME_SHARDS: String(shards), RESUME_OUTPUT: output },
   stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', data => { printed += String(data); }); child.stderr.on('data', data => { printed += String(data); });
  const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  writeFileSync(log, printed);
  if (!existsSync(join(output, 'resume.json'))) throw Error(`Resume shard ${shard} exited ${code} without a report; ${log}`);
  const part = JSON.parse(readFileSync(join(output, 'resume.json'), 'utf8'));
  shapes += part.summary.shapes;
  rows.push(...part.rows.map((r: any) => ({ ...r, resumed: part.traces[r.resumed], native: part.traces[r.native], uninterrupted: part.traces[r.uninterrupted] })));
  say(`batch ${shard + 1}/${shards}: ${part.summary.resumed} resumed, ${part.summary.failed} failing, ${part.summary.harnessErrors} harness errors`);
 }
 finish(rows, shapes);
}

function finish(rows: Row[], shapes: number) {
 const summary = { shapes: shapes, cells: rows.length, resumed: rows.filter(r => r.resumed?.cold && r.native?.cold && r.status !== 'not-reached').length,
  passed: rows.filter(r => r.status === 'pass').length, failed: rows.filter(r => r.status === 'fail').length,
  notReached: rows.filter(r => r.status === 'not-reached').length, harnessErrors: rows.filter(r => r.status === 'harness-error').length, precision: precisionSummary(rows) };
 const dir = process.env.RESUME_OUTPUT ?? mkdtempSync(join(tmpdir(), 'pi-tuck-resume-'));
 mkdirSync(dir, { recursive: true });
 // Shared traces are stored once per arm to keep the report reasonably small.
 const traces: Trace[] = [], ids = new Map<Trace, number>();
 const id = (t: Trace | undefined) => { if (!t) return undefined; if (!ids.has(t)) { ids.set(t, traces.length); traces.push(t); } return ids.get(t); };
 const compactRows = rows.map(({ resumed, native, uninterrupted, ...row }) => ({ ...row, resumed: id(resumed), native: id(native), uninterrupted: id(uninterrupted) }));
 writeFileSync(join(dir, 'resume.json'), JSON.stringify({ summary, tolerance: TOLERANCE, rows: compactRows, traces }, null, 1));
 const table = ['| Shape | Provider / factor / window | R (next prompt) | 1 size | 2 cut | 3 refusal | 4 overflow | Prompt / strand / thrash | Precision Δ / room | Matching cut after requests |', '|---|---|---|---|---|---|---|---|---|---|'];
 const cellVerdict = (row: Row, rule: string) => { const v = row.rules?.[rule]; return v ? v.pass ? 'pass' : `FAIL ${v.requests.join(', ')}` : '—'; };
 for (const row of rows) table.push(`| ${row.shape} | ${row.provider} / ${row.factor} / ${row.window} | ${row.point} (${row.checkpoint ?? '—'}) | ${cellVerdict(row, '1:request-size')} | ${cellVerdict(row, '2:cut-point')} | ${cellVerdict(row, '3:early-refusal')} | ${cellVerdict(row, '4:overflow-truncation')} | ${row.rules ? ['lost-prompt', 'stranded', 'thrash'].map(r => cellVerdict(row, r)).join(' / ') : row.reason} | ${row.precision ? row.precision.percentRoom.toFixed(3) + '%' : '—'} | ${row.precision ? row.precision.requestsUntilMatchingCut ?? 'not matched in remaining ' + row.precision.remainingRequests : '—'} |`);
 writeFileSync(join(dir, 'cells.md'), table.join('\n') + '\n');
 say(JSON.stringify(summary)); say(`report ${dir}`);
 expect(summary.harnessErrors, 'Resume harness failures; see resume.json').toBe(0);
 if (STRICT) expect(summary.failed, `Resume parity violations; see ${dir}/resume.json`).toBe(0);
}

test.skipIf(!RUN)('cold resume parity over the settings grid', { timeout: 0 }, async () => {
 if (process.env.RESUME_SHARD === undefined) return runShards();
 const rows: Row[] = [];
 const named = namedCells();
 // Cross the existing capped and silently truncating fakes with the two recorded undercount factors.
 const densityCross = named.filter(c => c.name.startsWith('floor failure:') || c.name.startsWith('provider: silent truncation'))
  .flatMap(c => [1.25, 1.44].map(usageRatio => ({ ...c, name: `${c.name} (resume factor ${usageRatio})`, usageRatio })));
 const cells = [...Array.from({ length: N }, (_, i) => sample(i)), ...named, ...densityCross];
 // The five calibrated shapes use the same measured-floor builder as the original grid.
 for (const build of calibrationCells) {
  if (ONLY && !build(25_500).name.includes(ONLY)) continue;
  const probe = await runCell({ ...build(25_500), probe: true });
  cells.push(build(measuredFloor(probe) || 25_500));
 }
 const shard = Number(process.env.RESUME_SHARD), shards = Number(process.env.RESUME_SHARDS);
 const selected = cells.filter(c => !ONLY || c.name.includes(ONLY)).filter((_, i) => i % shards === shard);
 for (const cell of selected) {
  if (cell.wrongWindow) {
   for (const point of POINTS) rows.push(unsupported(cell, point, 'This shape uses measureWrongWindow with a different logical tool/recovery driver; the generic driver cannot faithfully resume it.'));
   continue;
  }
  const warm = await arm(cell, false, undefined);
  for (const point of POINTS) {
   let pause: Pause | undefined;
   if (point.startsWith('c:')) {
    const prompt = cell.rounds.findIndex(n => n > 0);
    if (prompt >= 0) pause = { prompt, round: 1, afterCut: false };
   } else if (point.startsWith('a:') && checkpoint(point, warm) === undefined) {
    const cut = warm.cuts.find(c => c.reason === 'tool-loop' && c.ordinal > 0 && c.ordinal <= (cell.rounds[c.prompt] ?? 0));
    if (cut) pause = { prompt: cut.prompt, round: cut.ordinal, afterCut: true };
   }
   const plan = script(cell, pause);
   const baseline = pause ? await arm(cell, false, undefined, pause) : warm;
   const at = pause ? baseline.paused ? plan.split + 1 : undefined : point.startsWith('c:') ? undefined : checkpoint(point, baseline);
   if (at === undefined || baseline.error) {
    rows.push(unsupported(cell, point, baseline.error ?? (pause ? 'No completed tool boundary to interrupt.' : point.startsWith('a:') ? 'No saved cut at a settled boundary with a remaining prompt; an in-flight cut would require changing the remaining script.' : point.startsWith('b:') ? 'No prompt-triggered cut after an earlier turn; tool-boundary cuts cannot be replaced by a new prompt without changing this script.' : point.startsWith('d:') ? 'No final output-limit reply with a remaining prompt (recovered intermediate length stops are not approximated).' : 'No refusal with a remaining prompt.')));
    continue;
   }
   if (!baseline.steps[at - 1]?.durable) {
    rows.push(unsupported(cell, point, 'Pi has not flushed a session file at this point; there is no durable session to reopen.'));
    continue;
   }
   const resumed = await arm(cell, false, at, pause);
   const native = await arm(cell, true, at, pause);
   if ([resumed.error, native.error].some(error => error?.includes('scripted tool boundary was never reached'))) {
    rows.push({ ...unsupported(cell, point, `The native and guarded arms do not both reach the selected tool round: tuck=${resumed.error ?? 'reached'}, native=${native.error ?? 'reached'}. No substitute boundary was used.`), resumed, native });
    continue;
   }
   if (!resumed.cold || !native.cold || resumed.error || native.error) {
    rows.push({ ...unsupported(cell, point, `Resume could not be built: tuck=${resumed.error ?? Boolean(resumed.cold)}, native=${native.error ?? Boolean(native.cold)}`), status: 'harness-error', resumed, native });
   } else rows.push(compare(cell, point, at, baseline, resumed, native));
  }
  if (rows.length % 50 === 0) say(`${rows.length} cells checked; latest ${cell.name}`);
 }
 finish(rows, selected.length);
});
