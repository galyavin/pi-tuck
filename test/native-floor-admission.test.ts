import { expect, test } from 'vitest';
import { harness } from './budget-fixture';

test.each([
 { thinking: 60_000, admitted: true, promptTokens: 0 },
 { thinking: 120_000, admitted: false, promptTokens: 0 },
 { thinking: 120_000, admitted: false, promptTokens: 18_000 },
])('a fresh round with $thinking thinking characters and a $promptTokens-token prompt uses native window admission ($admitted)', async ({ thinking, admitted, promptTokens }) => {
 const h = await harness({ at: 'prompt', complete: 0, noHistory: true, noOpening: true,
  host: 200, systemTokens: 3_000, limits: { contextWindow: 32_768, maxTokens: 16_384 }, reserveTokens: 16_384,
  compaction: { requestReserve: undefined }, piRequestPath: true,
  toolCalls: n => n === 1, toolResultTokens: () => 100,
  thinkingChars: n => n === 1 ? thinking : 0, outputTokens: 1,
  usageAt: n => n === 1 ? { output: 12_000, totalTokens: 12_000 } : {},
 });
 try {
  await h.session.prompt(promptTokens ? h.sized(promptTokens) : 'Read the file, then answer.');
  const receipts = h.manager.getBranch().filter(e => e.type === 'custom' && e.customType === 'pi-tuck-capacity');
  if (admitted) {
   expect(h.faults).toEqual([]);
   expect(h.state.requests).toBe(2);
   const entry = receipts.find(e => e.type === 'custom' && (e.data as { kind: string }).kind === 'native-floor');
   expect(entry).toMatchObject({ data: { kind: 'native-floor', room: 16_384, hardLine: 16_672 } });
   if (entry?.type !== 'custom') throw new Error('Missing native admission receipt');
   const data = entry.data as { estimatedTokens: number; hardLine: number; piCap: number; piEstimateTokens: number };
   expect(data.estimatedTokens).toBeGreaterThan(data.hardLine);
   expect(data.piCap).toBe(h.state.requestOptions[1]!.baseMaxTokens);
   expect(data.piCap).toBeLessThan(12_000);
   expect(data.piCap).toBeGreaterThanOrEqual(1);
   expect(data.piEstimateTokens + data.piCap + 4_096).toBeLessThanOrEqual(32_768);
  } else {
   expect(h.state.requests).toBe(1);
   if (promptTokens) expect(h.faults.join(' ')).toContain('whole starting prompt cannot fit');
   else {
    expect(h.faults.join(' ')).toContain('fresh tool round and required context');
    expect(h.faults.join(' ')).not.toContain('starting prompt');
   }
   expect(receipts).toContainEqual(expect.objectContaining({ data: expect.objectContaining({ kind: 'refusal' }) }));
   expect(receipts).not.toContainEqual(expect.objectContaining({ data: expect.objectContaining({ kind: 'native-floor' }) }));
  }
  expect(h.state.clampStops).toBe(0);
 } finally { await h.cleanup(); }
});
