import { afterAll, expect, test } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { RULES } from './checks';
import { shapes, WINDOWS } from './generator';
import { runShape, type Row } from './runner';

const enabled = /^(1|true|yes)$/i.test(process.env.SHAPES ?? '');
const strict = /^(1|true|yes)$/i.test(process.env.SHAPES_STRICT ?? '');
const recording = /^(1|true|yes)$/i.test(process.env.SHAPES_RECORD_BASELINE ?? '');
const rows: Row[] = [];
const baselinePath = new URL('./v1.0.16.json', import.meta.url);
interface Baseline { rows: { shape: string; window: number; allowedFailures: Partial<Record<typeof RULES[number], string[]>> }[] }
const baseline: Baseline | undefined = enabled && !recording ? JSON.parse(readFileSync(baselinePath, 'utf8')) : undefined;

for (const shape of WINDOWS.flatMap(shapes).filter(shape => !process.env.SHAPES_ONLY || `${shape.name}/${shape.window}`.includes(process.env.SHAPES_ONLY))) {
  test.skipIf(!enabled)(`${shape.name} / ${shape.window}`, async () => {
    const row = await runShape(shape);
    rows.push(row);
    const failed = RULES.filter(rule => row.failures.some(failure => failure.rule === rule));
    process.stderr.write(`shapes ${row.shape} | ${row.window} | ${row.cuts} cuts | ${row.requests} requests | ${row.milliseconds}ms | ${failed.join(', ') || 'PASS'}\n`);
    // Harness errors and hollow cells always fail. Findings report by default, like STRESS.
    expect(row.errors).toEqual([]);
    if (strict) expect(row.failures).toEqual([]);
    // Preserve every v1.0.16 pass at the same logical prompt/request or saved-cut boundary.
    const previous = baseline?.rows.find(candidate => candidate.shape === row.shape && candidate.window === row.window);
    if (baseline) expect(previous, 'cell is missing from the v1.0.16 baseline').toBeDefined();
    if (previous) {
      const allowed = new Set(Object.entries(previous.allowedFailures).flatMap(([rule, observations]) => observations.map(at => `${at}:${rule}`)));
      expect(row.failures.filter(failure => !allowed.has(`${failure.at}:${failure.rule}`)), 'regressed from v1.0.16').toEqual([]);
    }
  }, 300_000);
}

afterAll(() => {
  if (!enabled) return;
  const report = { build: process.env.SHAPES_BUILD ?? 'working-tree', reserve: 16_384, keepRecent: 20_000, rows };
  if (process.env.SHAPES_REPORT) {
    const path = resolve(process.env.SHAPES_REPORT);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
  }
});
