import { expect, test } from 'vitest';
import { expectThinkingLengthOutcome, thinkingLengthCell, thinkingLengthCells } from '../length-retry-fixture';
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

// These cases exercise stop and retry policy independently of the grid's refusal oracle.
for (const cell of thinkingLengthCells) {
 test.skipIf(!RUN || Boolean(ONLY && !`thinking-only length: ${cell.name}`.includes(ONLY)))(`thinking-only length: ${cell.name}`, async () => {
  const r = await thinkingLengthCell(cell);
  report(`stress: thinking-only length ${JSON.stringify({ cell: cell.name, requests: r.requests, caps: r.caps, outputs: r.outputs, stops: r.stops, retries: r.retries, floor: r.replyFloor })}`);
  expectThinkingLengthOutcome(cell, r);
 }, 300_000);
}
