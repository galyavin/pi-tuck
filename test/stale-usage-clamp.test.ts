import { expect, test } from 'vitest';
import { estimateContextTokens } from '@earendil-works/pi-ai/utils/estimate';
import { clampMaxTokensToContext } from '@earendil-works/pi-ai/api/simple-options';
import { harness, receiptOf } from './budget-fixture';

// Real clock (no providerWindow, so no fake Date): after a mid-run cut, the kept replies carry pre-cut usage. Pi's own clamp on the next
// request must ignore it, because live replies are stamped at stream start and the cut is saved later.
test('a mid-run cut makes Pi clamp the next request without the pre-cut usage', async () => {
 const h = await harness({ at: 'tool', complete: 28_000, systemTokens: 18_000, history: 1_000, fresh: 7_000, host: 200,
  limits: { contextWindow: 32_768, maxTokens: 8_192 }, archivedReplyOutput: 3_584, reserveTokens: 16_384, usageRatio: 0.873, piRequestPath: true, compaction: { requestReserve: undefined } });
 const stream = h.session.agent.streamFunction;
 const sent: Parameters<typeof stream>[1][] = [];
 h.session.agent.streamFunction = ((...args: Parameters<typeof stream>) => { sent.push(structuredClone(args[1])); return stream(...args); }) as typeof stream;
 try {
  const r = await h.run();
  expect(r.faults, r.probe).toEqual([]);
  expect(r.entries.map(entry => receiptOf(entry).reason), r.probe).toEqual(['tool-loop']);
  const after = sent.at(-1)!;
  const kept = after.messages.filter(m => m.role === 'assistant' && (m.usage?.input ?? 0) > 0);
  expect(kept.length, r.probe).toBeGreaterThan(0);
  const estimate = estimateContextTokens(after);
  expect(estimate.lastUsageIndex).toBeNull();
  const model = h.session.model!;
  expect(clampMaxTokensToContext(model, after, model.maxTokens))
   .toBe(Math.min(model.maxTokens, Math.max(1, model.contextWindow - estimate.trailingTokens - 4_096)));
 } finally { await h.cleanup(); }
});
