/** Exact native parity while pi-tuck stands down. All transports are scripted; no hosted API runs.
 * STRESS=1 STRESS_STRICT=1 npx vitest run test/stress/standdown-stress.test.ts
 * STRESS_ONLY filters complete cell names; STRESS_STANDDOWN_REPORT selects the JSON evidence file.
 */
import { afterAll, expect, test } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { harness } from '../budget-fixture';
import { namedCells, optionsOf, type Cell } from './settings-grid';

const RUN = /^(1|true|yes)$/i.test(process.env.STRESS ?? '');
const ONLY = process.env.STRESS_ONLY;
const sources = namedCells();
// Reuse the actual grid scripts and transport behavior, rather than parallel lookalike workloads.
const shapeNames = [
 'tiny window 8000',
 'prompt bigger than the room, smaller than the window',
 'prompt bigger than the window',
 'tool result bigger than the window',
 'reopened session saved above the room',
 '36000 characters of thinking replayed at a 32k window (openai-codex-responses)',
 'another extension prepends a message in context',
 'another extension appends boundary entries at turn_end',
 'provider: Anthropic rejects the prompt',
 'provider: a wording Pi does not recognise',
 'provider: silent truncation, stop for length and no output',
 'floor failure: openai length at window end',
] as const;
const shapes = shapeNames.map(name => {
 const cell = sources.find(c => c.name === name);
 if (!cell) throw Error(`Stand-down workload disappeared from the settings grid: ${name}`);
 return cell;
});
// The three model selections already used by the standard grid (Codex, Responses and Completions).
const providers = [...new Map(sources.map(c => {
 const model = c.extra?.model ?? { provider: 'openai-codex', id: 'gpt-6.1-sol' };
 return [JSON.stringify(model), model] as const;
})).values()];
const setups = [
 { name: 'window 0', reason: 'context window is zero or negative', window: 0 },
 { name: 'window missing', reason: 'context window is missing', missingWindow: true, window: 0 },
 { name: 'window NaN', reason: 'context window is not finite', window: NaN },
 { name: 'pi-virtual / window 0', reason: 'pi-virtual model', modelApi: 'pi-virtual', window: 0 },
 { name: 'pi-virtual / positive window', reason: 'pi-virtual model', modelApi: 'pi-virtual' },
 { name: 'compaction disabled / window 4096', reason: 'compaction is disabled', window: 4096, disabled: true },
] as const;
type Setup = (typeof setups)[number];
const cells = setups.flatMap(setup => shapes.flatMap(shape => providers.map(model => ({
 name: `stand-down: ${setup.name} | ${model.provider}/${model.id} | ${shape.name}`, setup, shape, model,
}))));
const selected = cells.filter(c => !ONLY || c.name.includes(ONLY));
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Read the JSONL file itself. A clean in-memory branch does not prove that no calibration or receipt was appended.
function tuckEntries(entries: readonly SessionEntry[]) {
 return entries.filter(e => e.type === 'custom' && e.customType.startsWith('pi-tuck') ||
  e.type === 'compaction' && ((e.details as { compactor?: string; diagnosticReceipt?: unknown } | undefined)?.compactor === 'pi-tuck' ||
   (e.details as { diagnosticReceipt?: unknown } | undefined)?.diagnosticReceipt !== undefined));
}

async function arm(shape: Cell, setup: Setup, model: { provider: string; id: string }, plainPi: boolean) {
 shape.reset?.();
 let end = 0;
 const disabled = 'disabled' in setup && setup.disabled;
 const window = 'window' in setup ? setup.window : shape.window;
 const options = optionsOf(shape, request => request <= end);
 const h = await harness({ ...options, model, plainPi, nativeCompaction: true,
  limits: { contextWindow: window, maxTokens: shape.maxTokens },
  modelApi: 'modelApi' in setup ? setup.modelApi : undefined,
  missingWindow: 'missingWindow' in setup && setup.missingWindow,
  compactionEnabled: !disabled, reserveTokens: disabled ? 512 : shape.reserve,
  persist: true, stableHost: true, fingerprintWire: true, trackRuntimeSpies: false,
  // The capped-payload helper requires a finite window. Unknown-window cells use the fixture's ordinary scripted stream.
  piRequestPath: !('missingWindow' in setup) && Number.isFinite(window),
  // D6's fixed Date clock, advancing at provider replies. Physical capacity is independent of the unknown catalogue window.
  providerWindow: shape.extra?.providerWindow ?? shape.window,
 });
 try {
  expect(h.session.model?.api === 'pi-virtual').toBe('modelApi' in setup);
  if ('missingWindow' in setup) expect(Object.hasOwn(h.session.model!, 'contextWindow')).toBe(false);
  else expect(h.session.model?.contextWindow).toBe(window);
  const before = h.manager.getEntries().length;
  const prompts: { requests: number; stops: string[]; threw: string; finalStop?: string; finalError?: string }[] = [];
  const prompt = async (tokens: number, rounds: number) => {
   const start = h.state.requests, stop = h.state.stops.length;
   end = start + rounds;
   let threw = '';
   try { await h.session.prompt(h.sized(tokens)); }
   catch (error) { threw = String(error).replaceAll(h.dir, '<session>'); }
   const last = h.session.messages.findLast(m => m.role === 'assistant');
   prompts.push({ requests: h.state.requests - start, stops: h.state.stops.slice(stop), threw,
    finalStop: last?.stopReason, finalError: last?.errorMessage?.replaceAll(h.dir, '<session>') });
  };
  for (const [i, tokens] of shape.prompts.entries()) await prompt(tokens, shape.rounds[i] ?? 0);
  if (disabled) {
   // Every disabled cell must actually send above the hard line, including short source workloads.
   const requests = h.state.requests;
   await prompt(20_000, 0);
   expect(h.state.requests).toBeGreaterThan(requests);
   expect(h.guard.at(-1)).toBeGreaterThan(window);
  }
  expect(h.state.requests, JSON.stringify(prompts)).toBeGreaterThan(0);
  expect(h.state.clips).toBe(0);
  expect(h.faults).toEqual([]);
  expect(h.notices).toEqual([]);
  const cuts = h.manager.getEntries().slice(before).filter(e => e.type === 'compaction');
  expect(tuckEntries(h.manager.getEntries().slice(before))).toEqual([]);
  expect(h.state.nativeCuts).toHaveLength(cuts.length);
  expect(h.providerFingerprints).toHaveLength(h.state.requests + h.state.nativeSummaries.length);
  const outcome = {
   wire: [...h.providerFingerprints], workloadWire: [...h.state.requestFingerprints],
   requests: h.providerFingerprints.length, workloadRequests: h.state.requests,
   providerReplies: [...h.providerRequests],
   requestOptions: [...h.state.requestOptions], summaryOptions: [...h.state.nativeSummaries],
   cuts: { native: [...h.state.nativeCuts], tuck: tuckEntries(cuts).length,
    saved: cuts.map(e => ({ summary: e.summary, tokensBefore: e.tokensBefore, details: e.details,
     firstKeptEntry: h.manager.getEntries().findIndex(entry => entry.id === e.firstKeptEntryId) })) },
   clips: h.state.clips, faults: [...h.faults], prompts,
   refusals: prompts.filter(p => p.requests === 0 || p.threw || p.finalStop === 'error').length,
   providerRefusals: h.state.overflows, truncations: h.state.truncations, stops: [...h.state.stops], aborts: h.state.aborts,
   notices: [...h.notices],
  };
  if (!plainPi) {
   const requests = h.providerFingerprints.length;
   await h.session.prompt('/tuck');
   expect(h.providerFingerprints).toHaveLength(requests);
   expect(h.notices).toHaveLength(1);
   expect(h.notices[0]).toContain(`: standing down: ${setup.reason}; Pi's own compaction runs.`);
  }
  const file = h.manager.getSessionFile();
  expect(file).toBeTruthy();
  const disk = readFileSync(file!, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(tuckEntries(disk)).toEqual([]);
  // Confirm the append-only file contains every compaction we counted in memory.
  expect(disk.filter(e => e.type === 'compaction')).toHaveLength(h.manager.getEntries().filter(e => e.type === 'compaction').length);
  return outcome;
 } finally { await h.cleanup(); }
}

type Outcome = Awaited<ReturnType<typeof arm>>;
const rows: { cell: string; digests: string[]; native: Outcome; tuck: Outcome }[] = [];
test('stand-down matrix crosses all six setups, twelve existing shapes and three grid providers', () => {
 expect(providers.map(p => p.provider).sort()).toEqual(['groq', 'openai', 'openai-codex']);
 expect(new Set(shapeNames).size).toBe(12);
 expect(new Set(cells.map(c => c.name)).size).toBe(216);
});

for (const cell of selected) test.skipIf(!RUN)(cell.name, { timeout: 60_000 }, async () => {
 const runs: { native: Outcome; tuck: Outcome }[] = [];
 for (let run = 0; run < 3; run++) {
  const native = await arm(cell.shape, cell.setup, cell.model, true);
  const tuck = await arm(cell.shape, cell.setup, cell.model, false);
  expect(tuck, `${cell.name}, native parity run ${run + 1}`).toEqual(native);
  runs.push({ native, tuck });
  if (run > 0) expect(runs[run], `${cell.name}, determinism run ${run + 1}`).toEqual(runs[0]);
 }
 rows.push({ cell: cell.name, digests: runs.map(hash), ...runs[0]! });
});

afterAll(() => {
 if (!RUN || !selected.length) return;
 const ordered = rows.toSorted((a, b) => a.cell.localeCompare(b.cell));
 const summary = { cells: rows.length, expected: selected.length, runs: 3, identical: rows.every(r => new Set(r.digests).size === 1),
  digest: hash(ordered), nativeCuts: rows.reduce((n, r) => n + r.native.cuts.native.length, 0),
  summaryRequests: rows.reduce((n, r) => n + r.native.summaryOptions.length, 0),
  providerRefusals: rows.reduce((n, r) => n + r.native.providerRefusals, 0),
  tuckCuts: rows.reduce((n, r) => n + r.tuck.cuts.tuck, 0) };
 const file = process.env.STRESS_STANDDOWN_REPORT ?? join(mkdtempSync(join(tmpdir(), 'pi-tuck-standdown-')), 'parity.json');
 writeFileSync(file, JSON.stringify({ summary, rows: ordered }, null, 1) + '\n');
 process.stderr.write(`stand-down: ${JSON.stringify(summary)}\nstand-down: report ${file}\n`);
 expect(rows).toHaveLength(selected.length);
 if (!ONLY) {
  expect(summary.nativeCuts).toBeGreaterThan(0);
  expect(summary.summaryRequests).toBeGreaterThan(0);
  expect(summary.providerRefusals).toBeGreaterThan(0);
 }
});
