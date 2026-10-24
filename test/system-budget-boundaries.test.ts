import { expect, test } from 'vitest';
import { BAND, BAND_EXACT, EXACT_RESERVE, HOST, ROOM, ROOM_EXACT, scenario } from './budget-fixture';

test('combined sizing keeps exact-reserve admission strict at equality', async () => {
 for (const d of [-1, 0, 1]) {
  const r = await scenario({ at: 'prompt', complete: ROOM_EXACT + d, host: HOST, compactionEnabled: false, compaction: EXACT_RESERVE });
  expect(r.measured!.complete, r.probe).toBe(ROOM_EXACT + d);
  expect(r.guard[0], r.probe).toBe(ROOM_EXACT + d);
  expect(r.requests, r.probe).toBe(d < 0 ? 1 : 0);
  if (d < 0) expect(r.faults, r.probe).toEqual([]);
  else expect(r.faults.join(' '), r.probe).toContain('Complete Pi context and response reserve exceed the estimated request budget');
 }
 for (const d of [-1, 0, 1]) {
  const r = await scenario({ at: 'prompt', complete: BAND_EXACT + d, host: HOST, compaction: EXACT_RESERVE });
  expect(r.cuts, r.probe).toBe(d < 0 ? 0 : 1);
  expect(r.faults, r.probe).toEqual([]);
 }
});

test('calibrated room equality is actually reached and rejected, not skipped by rounding', async () => {
 const seen: number[] = [];
 for (let d = -3; d <= 3; d++) {
  const r = await scenario({ at: 'tool', complete: Math.floor(ROOM / 1.1) + d, host: HOST, usageRatio: 1.1, compactionEnabled: false });
  const raw = r.measured!.complete;
  expect(r.guard[1], r.probe).toBe(raw);
  const corrected = Math.ceil(raw * (Math.ceil(r.guard[0]! * 1.1) / r.guard[0]!));
  seen.push(corrected);
  expect(r.requests, r.probe).toBe(corrected < ROOM ? 2 : 1);
  if (corrected >= ROOM) expect(r.faults.join(' '), r.probe).toContain('Complete Pi context and response reserve exceed the estimated request budget');
 }
 expect(seen).toContain(ROOM);
 expect(seen.some(n => n < ROOM)).toBe(true);
 expect(seen.some(n => n > ROOM)).toBe(true);
});

test('omitted-summary request crosses the band at equality, not one token early', async () => {
 const base = { at: 'tool' as const, host: HOST, summary: true, omitted: 40000 };
 const first = await scenario({ ...base, complete: BAND, compactionEnabled: false });
 const shift = BAND - first.guard[1]!;
 expect(shift).toBeGreaterThan(5000);
 for (const d of [-1, 0, 1]) {
  const complete = BAND + shift + d;
  const off = await scenario({ ...base, complete, compactionEnabled: false });
  expect(off.guard[1], off.probe).toBe(BAND + d);
  const on = await scenario({ ...base, complete });
  expect(on.cuts, on.probe).toBe(d < 0 ? 0 : 1);
  expect(on.faults, on.probe).toEqual([]);
 }
});
