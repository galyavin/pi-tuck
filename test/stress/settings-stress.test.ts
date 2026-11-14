import { expect, test } from 'vitest';
import { thinkingLengthCell, thinkingLengthCells } from '../length-retry-fixture';
import { runSettingsStress, sample, namedCells, calibrationCells } from './settings-grid';
import { compactionState } from '../../src/compaction';
import { scriptedModelRuntime } from '../model-fixture';
const RUN = /^(1|true|yes)$/i.test(process.env.STRESS ?? '');
const CELLS = Math.max(1, Number(process.env.STRESS_CELLS) || 200);
const ONLY = process.env.STRESS_ONLY;
const report = (line: string) => process.stderr.write(`${line}\n`);
test('standing down never triggers in the whole standard stress grid', async () => {
 const runtime = await scriptedModelRuntime();
 const cells = [...Array.from({ length: 200 }, (_, i) => sample(i)), ...namedCells(), ...calibrationCells.map(build => build(25500))];
 for (const cell of cells) {
  const selected = cell.extra?.model ?? { provider: 'openai-codex', id: 'gpt-6.1-sol' };
  const model = runtime.getModel(selected.provider, selected.id)!;
  expect(compactionState({ ...model, contextWindow: cell.window }, cell.extra?.compactionEnabled ?? true), cell.name).toEqual({ kind: 'active' });
 }
});
test(`settings stress: ${CELLS} sampled cells and the named edge cases`, { timeout: 0 }, runSettingsStress);

// ---- Thinking-only length recovery (part 2): carry this block and the length-retry-fixture import together. ----
// Separate from runCell's refusal oracle: the third cell deliberately ends at length after its one permitted retry.
for (const cell of thinkingLengthCells) {
 test.skipIf(!RUN || Boolean(ONLY && !`thinking-only length: ${cell.name}`.includes(ONLY)))(`thinking-only length: ${cell.name}`, async () => {
  const r = await thinkingLengthCell(cell);
  report(`stress: thinking-only length ${JSON.stringify({ cell: cell.name, requests: r.requests, caps: r.caps, outputs: r.outputs, stops: r.stops, retries: r.retries, floor: r.replyFloor })}`);
  expect(r.requests).toBe(2);
  expect(r.retries).toBe(1);
  expect(r.stops).toEqual(['length', cell.twice ? 'length' : 'stop']);
  expect(r.caps[1]).toBeGreaterThanOrEqual(r.outputs[0]!);
  if (cell.above) expect(r.caps[1]).toBeGreaterThan(r.outputs[0]!);
  expect(r.replyFloor).toBe(Math.max(3_584, ...r.outputs));
  expect(r.omitted && r.preserved && r.wholePrompt).toBe(true);
  // The deepest cut only where it buys reply room (above the room); below it Pi's cap is already the model's whole reply cap.
  expect(r.deepest && r.noOptionalHistory).toBe(cell.above);
  expect(r.faults).toEqual([]);
  // A retried reply that stops again leaves the one length-stop notice (K10); a retry that finishes leaves none.
  expect(r.notices.length).toBe(cell.twice ? 1 : 0);
 }, 300_000);
}
// ---- End thinking-only length recovery cells. ----
