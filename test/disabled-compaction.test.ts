import { expect, test } from 'vitest';
import { harness } from './budget-fixture';

test.each(['prompt', 'tool'] as const)('D6: with auto-compaction disabled native sends above the hard line at %s, and pi-tuck sends the identical request', async at => {
 const run = async (plainPi: boolean) => {
  const h = await harness({ at, complete: 20000, fresh: at === 'tool' ? 30000 : undefined, limits: { contextWindow: 16384, maxTokens: 2048 }, providerWindow: 16384, host: 0, reserveTokens: 0,
   compactionEnabled: false, plainPi, stableHost: true, fingerprintWire: true });
  try {
   await h.run();
   return { requests: h.state.requests, wire: h.state.requestFingerprints, cuts: h.compactions().length, faults: [...h.faults], clips: h.state.clips, notices: h.notices };
  } finally { await h.cleanup(); }
 };
 const native = await run(true);
 expect(native.requests).toBe(at === 'prompt' ? 1 : 2);
 expect(native.cuts).toBe(0);
 expect(native.faults).toEqual([]);
 expect(await run(false)).toEqual(native);
});
