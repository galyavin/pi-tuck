import { expect, test } from 'vitest';
import type { Context } from '@earendil-works/pi-ai';
import { harness, HOST, ROOM } from './budget-fixture';

// Choice 5: a run that stops at the model's whole allowance still saves its cut, and the next prompt is cut before its first request.
test('after a full-allowance stop the cut is saved and the next prompt is cut in time', async () => {
 const h = await harness({ at: 'prompt', complete: ROOM + 3000, host: HOST, piRequestPath: true, thinkingOnlyLength: n => n === 1 });
 try {
  const first = await h.run();
  expect(first.faults).toEqual([]);
  const last = h.state.answers[0]!;
  expect([last.stopReason, last.usage.output]).toEqual(['length', h.session.model!.maxTokens]);
  expect(h.state.answers).toHaveLength(1);
  const cuts = () => h.manager.getBranch().filter(entry => entry.type === 'compaction').length;
  expect(cuts()).toBe(1);
  h.cycle(4_000); h.cycle(4_000); h.cycle(4_000);
  const uncut = Math.ceil(JSON.stringify(h.manager.buildSessionProjection().messages).length / 4) + 6_000;
  const before = h.state.requests;
  let sent: Context | undefined;
  const stream = h.session.agent.streamFunction;
  h.session.agent.streamFunction = ((...args: Parameters<typeof stream>) => { sent ??= structuredClone(args[1]); return stream(...args); }) as typeof stream;
  await h.session.prompt('Continue with a new task ' + h.text(6_000));
  expect(h.faults).toEqual([]);
  expect(h.state.requests).toBeGreaterThan(before);
  // The first request already carries the new cut (Pi saves it at the next boundary): what it sends fits below the room,
  // although the branch the old cut leaves does not.
  const size = (value: unknown) => Math.ceil(JSON.stringify(value).length / 4);
  expect(uncut).toBeGreaterThan(ROOM);
  expect(size(sent!.messages)).toBeLessThan(ROOM);
  expect(cuts()).toBe(2);
  expect(h.state.answers.at(-1)!.stopReason).toBe('stop');
 } finally { await h.cleanup(); }
});
