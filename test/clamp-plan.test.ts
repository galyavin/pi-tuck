import { expect, test } from 'vitest';
import { harness, receiptOf, type Options } from './budget-fixture';

// A provider density below 1 leaves Pi's chars/3.5 estimate above the corrected chars/4 count (calibration itself is floored at 1).
// Each case used to pass the corrected hard line, then refuse at the complete-context clamp. The recorded options run Pi's real
// clamp and payload builders, so a guard-only acceptance cannot make these pass.
const cases: { point: string; reason: string; requests: number; options: Omit<Options, 'host'> }[] = [
 { point: 'preflight', reason: 'prompt', requests: 1,
  options: { at: 'prompt', complete: 24_500, systemTokens: 18_000, history: 5_000, incoming: 19_500 } },
 { point: 'tool boundary', reason: 'tool-loop', requests: 2,
  options: { at: 'tool', complete: 28_000, systemTokens: 18_000, history: 1_000, fresh: 7_000 } },
 { point: "Pi's threshold", reason: 'threshold', requests: 2,
  options: { at: 'tool', complete: 30_000, systemTokens: 6_000, history: 8_500, fresh: 14_000, cycleSize: 1_000,
   // An earlier extension owns this boundary; Pi's subsequent threshold ask must decide the cut.
   onBoundary: event => { event.entries.push({ type: 'custom', customType: 'prior-boundary', data: {} }); } } },
];

test.each(cases)('$point replans above the room until Pi leaves the reply floor', async ({ options, reason, requests }) => {
 const h = await harness({ ...options, host: 200, limits: { contextWindow: 32_768, maxTokens: 8_192 },
  reserveTokens: 16_384, usageRatio: 0.873, piRequestPath: true, compaction: { requestReserve: undefined } });
 try {
  const r = await h.run();
  expect(r.requests, r.probe).toBe(requests);
  expect(r.faults, r.probe).toEqual([]);
  expect(h.notices, r.probe).toEqual([]);
  expect(r.entries.map(entry => receiptOf(entry).reason), r.probe).toEqual([reason]);
  expect(r.guard.at(-1), r.probe).toBeGreaterThan(16_384);
  expect(h.state.counts[0]!.count).toBeLessThan(r.guard[0]!);
  expect(h.state.requestOptions).toHaveLength(requests);
  for (const request of h.state.requestOptions) {
   expect(request.baseMaxTokens, r.probe).toBeGreaterThanOrEqual(3_584);
   expect(request.maxTokens, r.probe).toBeGreaterThanOrEqual(3_584);
  }
  expect(h.state.clampStops).toBe(0);
  expect(h.state.stops.at(-1)).toBe('stop');
 } finally { await h.cleanup(); }
});
