import { expect, test, vi } from 'vitest';
import { createRun, type RunPhase } from '../src/run';

const allowed: Record<RunPhase, RunPhase[]> = {
  decided: ['claimed', 'expired', 'starting', 'failed', 'commit-failed'],
  claimed: ['claimed', 'starting', 'failed', 'commit-failed'],
  expired: ['starting', 'failed', 'commit-failed'],
  starting: ['admitted', 'failed', 'commit-failed'],
  admitted: ['admitted', 'failed', 'commit-failed'],
  failed: ['failed', 'commit-failed'],
  'commit-failed': ['commit-failed'],
};
for (const from of Object.keys(allowed) as RunPhase[]) for (const to of Object.keys(allowed) as RunPhase[])
test(`run transition ${from} -> ${to}`, () => {
  const error = new Error('failed attempt');
  const run = createRun('decided');
  if (from === 'admitted') { run.transition('starting'); run.transition(from); }
  else if (from !== 'decided') run.transition(from, undefined, error);
  if (allowed[from].includes(to)) {
    expect(run.transition(to, undefined, error)).toBe(true);
    expect(run.phase).toBe(to);
    expect(run.error).toBe(to === 'failed' || to === 'commit-failed' ? error : undefined);
  } else {
    expect(() => run.transition(to, undefined, error)).toThrow(`invalid run transition ${from} -> ${to}`);
    expect(run.phase).toBe(from);
  }
});

test('failed phases require error data', () => {
  const run = createRun('starting');
  expect(() => run.transition('failed')).toThrow('invalid run transition');
  expect(run.phase).toBe('starting');
});

test('expired input-plan provenance survives admission until the attempt data is cleared', () => {
  const run = createRun('decided');
  run.transition('expired'); run.transition('starting'); run.transition('admitted');
  expect(run.phase).toBe('admitted');
  expect(run.expired).toBe(true);
  run.clear();
  expect(run.expired).toBe(false);
});

test('production ignores invalid transitions and warns once without a UI', () => {
  const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  vi.stubEnv('NODE_ENV', 'production');
  try {
    const run = createRun('starting'); run.transition('failed', undefined, new Error('failed attempt'));
    expect(run.transition('admitted', { hasUI: true })).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(run.transition('starting', { hasUI: false })).toBe(false);
    expect(run.transition('admitted', { hasUI: false })).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toContain('invalid run transition failed -> starting');
    expect(run.phase).toBe('failed');
  } finally { vi.unstubAllEnvs(); write.mockRestore(); }
});
