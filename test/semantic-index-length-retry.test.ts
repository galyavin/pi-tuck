import { expect, test, vi } from 'vitest';
import { harness } from './budget-fixture';
import { createSemanticRecall } from '../src/semantic-recall';

// Pi announces only its own compactions (session_compact). A cut pi-tuck saves itself gets no such event, so each path that saves one must
// start the indexing of what left the view. The length-retry path (a thinking-only length stop, retried once after the deepest cut) saves its
// cut from retryLength, apart from the tool and run-end boundaries: every saved pi-tuck cut must start indexing, this one included.
test('a cut saved by the length retry starts indexing what left the view', async () => {
 const semantic = createSemanticRecall(), indexAtCut = vi.spyOn(semantic, 'indexAtCut');
 const h = await harness({ at: 'prompt', complete: 21_500, host: 200, systemTokens: 16_648, history: 4_000, incoming: 17_500,
  limits: { contextWindow: 32_768, maxTokens: 16_384 }, reserveTokens: 16_384, keepRecent: 20_000,
  thinkingOnlyLength: n => n === 1, piRequestPath: true, compaction: { requestReserve: undefined, semanticRecall: semantic } });
 try {
  const r = await h.run();
  expect(r.faults, r.probe).toEqual([]);
  const cuts = h.compactions(), retryCut = cuts.find(entry => (entry.details as { deepest?: boolean })?.deepest);
  expect(retryCut, r.probe).toBeDefined();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  expect(indexAtCut.mock.calls.length, `${cuts.length} pi-tuck cuts saved`).toBeGreaterThanOrEqual(cuts.length);
 } finally { await h.cleanup(); }
});
