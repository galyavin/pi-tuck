import { test, expect } from 'vitest';
import { SessionManager, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { bandOf, decideCut, measurableConversationTokens, planningReserve, type Plan, type Target } from '../src/budget';
import { tuck, tuckObservedDraft } from '../src/tuck';
// The tool-loop trigger's decision (compaction.ts turn_end) on a growing session: real decideCut, planningReserve and draft, factor 1.
// `mandatory` stands for the system prompt and tools. A native tail that may fill the whole room left a 32k session just under the band
// after each cut, so the next tool round cut again: 174 cuts in 300 rounds, 155 of them freeing under a tenth of the room.
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
function drive(window: number, response: number, mandatory: number, turns: number, shape: 'low-prose' | 'prose', resultWords = 500, cutAt = 1) {
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const V = 'parser cache index token budget summary recall branch module schema router worker queue retry timeout config build test lint deploy migrate session window ledger anchor cursor shard vector'.split(' ');
  const words = (n: number) => Array.from({ length: n }, () => V[Math.floor(rnd() * V.length)]).join(' ');
  let clock = 1_700_000_000_000; const stamp = () => (clock += 1000);
  const manager = SessionManager.inMemory('/tmp/p');
  const ctx = { sessionManager: manager, cwd: '/tmp/p', model: { contextWindow: window, maxTokens: response, provider: 'p', id: 'p', api: 'openai-completions' } } as unknown as ExtensionContext;
  const measure = (m: never[]) => measurableConversationTokens(m, ctx);
  const room = window - response, band = bandOf(room, cutAt), fits = (t: number, l: number) => t < l;
  const cuts: { turn: number; before: number; after: number; mode: string; target: Target }[] = []; const faults: string[] = [];
  let c = 0;
  for (let turn = 1; turn <= turns; turn++) {
    if (shape === 'prose' || turn % 60 === 1) manager.appendMessage({ role: 'user', content: `Task ${turn}: please ${words(40)}`, timestamp: stamp() });
    const id = `c${++c}`;
    manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: shape === 'prose' ? `I will look. ${words(80)}` : `Checking. ${words(12)}` }, { type: 'toolCall', id, name: 'read', arguments: { path: `src/f${turn % 97}.ts` } }], api: 'openai-completions', provider: 'p', model: 'p', usage, stopReason: 'toolUse', timestamp: stamp() } as never);
    manager.appendMessage({ role: 'toolResult', toolCallId: id, toolName: 'read', content: [{ type: 'text', text: words(resultWords) }], isError: false, timestamp: stamp() });
    const saved = manager.buildSessionProjection().messages as never[];
    const before = measure(saved);
    const decision = decideCut({ total: before + mandatory, mandatory, before, room, band, fits, unreduced: 'unreduced',
      plan: (target): Plan<{ compaction: any }> => {
        const reserve = planningReserve(window, target === 'band' ? band : room, 1, mandatory);
        const d = tuckObservedDraft(tuck, { branchEntries: manager.getBranch(), tokensBefore: before }, ctx, reserve, measure as never, {}, true);
        if (!d.compaction) return { draft: false, capacityRejected: Boolean(d.capacityRejected), reason: d.unavailable! };
        const preview = SessionManager.inMemory('/tmp/p', undefined, [manager.getHeader()!, ...manager.getBranch()]);
        preview.appendCompaction(d.compaction.summary, d.compaction.firstKeptEntryId, before, d.compaction.details, true);
        return { draft: true, after: measure(preview.buildSessionProjection().messages as never[]), mode: d.mode, compaction: d.compaction };
      } });
    if (decision.kind === 'fault') { faults.push(`${turn}: ${decision.message}`); break; }
    if (decision.kind !== 'cut') continue;
    const d = decision.plan.compaction;
    manager.appendCompaction(d.summary, d.firstKeptEntryId, before, d.details, true);
    cuts.push({ turn, before, after: decision.plan.after, mode: decision.plan.mode, target: decision.target });
  }
  return { room, band, cuts, faults };
}
test('a cut on a small window frees at least a tenth of the room, so the next round does not cut again', () => {
  for (const response of [16384, 8192]) {
    const r = drive(32768, response, 3000, 150, 'low-prose');
    expect(r.faults).toEqual([]);
    expect(r.cuts.length).toBeGreaterThan(3);
    for (const cut of r.cuts) expect(cut.before - cut.after, JSON.stringify(cut)).toBeGreaterThanOrEqual(r.room / 10);
  }
}, 600_000);
// The same session at a lean cut point (0.6): every cut still lands below the band, or below the room when it was due, and frees at least a tenth
// of the room, and nothing faults. Only on windows where that holds: on a 32k window the room plan (a native tail of up to half the room, the
// dialogue summary and the mandatory input) lands just under a band at 0.6 of the room, so it is taken as it is and the next rounds cut
// again (68 cuts in 150 turns against 10 at the default, some freeing under 1,000 tokens). The yield property is therefore held at F = 1 there.
test('a lean cut point (0.6) on a large window: cuts land below the band, free at least a tenth of the room, and are more frequent than at the default', () => {
  for (const [window, response, mandatory, turns] of [[272000, 128000, 18000, 400], [128000, 16384, 12000, 300]] as const)
    for (const shape of ['low-prose', 'prose'] as const) {
      const lean = drive(window, response, mandatory, turns, shape, 500, 0.6), standard = drive(window, response, mandatory, turns, shape);
      const why = JSON.stringify({ window, response, shape });
      expect(lean.band, why).toBe(bandOf(window - response, 0.6));
      expect(lean.faults, why).toEqual([]);
      expect(lean.cuts.length, why).toBeGreaterThan(standard.cuts.length);
      for (const cut of lean.cuts) {
        expect(cut.before - cut.after, JSON.stringify(cut)).toBeGreaterThanOrEqual(lean.room / 10);
        // Cut at the band (an opportunistic cut lands below it), or from the room up (a due cut lands below the room).
        expect(cut.after + mandatory, JSON.stringify(cut)).toBeLessThan(cut.before + mandatory < lean.room ? lean.band : lean.room);
      }
    }
}, 600_000);
