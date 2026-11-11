import { expect, test, vi } from 'vitest';
import { harness, HOST, ROOM } from './budget-fixture';

const fault = vi.hoisted(() => ({ once: false }));
vi.mock('../src/tuck', async original => {
  const real = await original<typeof import('../src/tuck')>();
  return { ...real, tuckObservedDraft: (...args: Parameters<typeof real.tuckObservedDraft>) => {
    if (fault.once) { fault.once = false; throw new Error('one-off input planning failure'); }
    return real.tuckObservedDraft(...args);
  } };
});

test('a one-off input failure stays blocked when Pi starts its fresh abort controller', async () => {
  const h = await harness({ at: 'prompt', complete: ROOM + 3000, host: HOST });
  try {
    fault.once = true;
    const first = await h.run();
    expect(first.faults.join(' ')).toContain('one-off input planning failure');
    expect(first.requests).toBe(0);
    // Settlement ends the failure: a new attempt can use the now-working planner.
    const requests = h.state.requests;
    await h.session.prompt('Try the task again');
    expect(h.state.requests).toBeGreaterThan(requests);
  } finally { fault.once = false; await h.cleanup(); }
});
