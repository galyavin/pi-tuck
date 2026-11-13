import { expect, test, vi } from 'vitest';
import { HOST, ROOM, scenario } from './budget-fixture';
import { createSemanticRecall } from '../src/semantic-recall';

// C2b indexes what a cut moves out of view. Pi announces only its own compactions (session_compact); a cut pi-tuck saves at a turn boundary
// lands with no such event, and in live agent loops nearly every cut is one (a 2026-11-12 live check: 5 of 5 tool-loop cuts, no worker ever
// started). Every boundary that saves a cut must therefore start the indexing itself, at a tool boundary as at a prompt boundary.
for (const at of ['tool', 'prompt'] as const)
 test(`a cut saved at a ${at} boundary starts indexing what left the view`, async () => {
  const semantic = createSemanticRecall(), indexAtCut = vi.spyOn(semantic, 'indexAtCut');
  const r = await scenario({ at, complete: ROOM + 10, host: HOST, compaction: { semanticRecall: semantic } });
  expect(r.faults, r.probe).toEqual([]);
  expect(r.cuts, r.probe).toBe(1);
  await new Promise(resolve => setImmediate(resolve));
  expect(indexAtCut, r.probe).toHaveBeenCalled();
 });
