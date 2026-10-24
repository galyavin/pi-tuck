import { expect, test } from 'vitest';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { CALIBRATION_CEILING } from '../src/compaction';
import { OVERFLOW_TEXT, WINDOW } from './budget-fixture';
import { MODEL, expectFactor, reporting, sessionWith, stamp, type Drive } from './calibration-fixture';

// Change 2 of T10, kept apart from the seed (calibration-seed.test.ts) so that it can be judged, or dropped, alone: it widens the update rule of the
// calibration factor by one bounded learning source. A provider that refuses a request for exceeding the window proves the request's true count was at
// least window + 1; against the estimate E the guard counted, that is a lower bound (window + 1) / E on the ratio. It is learned only when it is at
// most CALIBRATION_CEILING, and only for a request that was paired exactly as a completed reply must be. Every other errored reply teaches nothing.
// Through Pi's real recovery path (the cut planned at the learned factor, its receipt) the same change is proved in native-recovery.test.ts.
const noSeed = sessionWith([]).manager;
const refused: Partial<AssistantMessage> = { stopReason: 'error', errorMessage: OVERFLOW_TEXT, content: [] };
/** A request of E estimated tokens is offered and the provider's reply to it is `reply`. */
const answered = (E: number, reply: Parameters<Drive['reply']>[0]) => async (d: Drive) => { await d.offer(E); await d.reply(reply); };
const E = 230000; // A request just below the band of the room: about as large as the guard lets a request be.

test('an overflow on a paired request raises the factor to (window + 1) over its estimate', async () => {
 const f = (WINDOW + 1) / E;
 expect(f).toBeGreaterThan(1.18);
 expect(f).toBeLessThan(CALIBRATION_CEILING);
 await expectFactor(f, noSeed, 'overflow', answered(E, refused));
 // Control: the same request answered normally teaches nothing (usage 0), so the rise is the overflow's.
 await expectFactor(1, noSeed, 'a completed reply with no usage', answered(E, {}));
});

test('the raise is bounded by the ceiling: an estimate whose bound is above it is not learned, and the bound itself is', async () => {
 // (window + 1) / 181,334 is exactly 1.5: learned. One token fewer puts the bound just above 1.5: ignored.
 const edge15 = (WINDOW + 1) / CALIBRATION_CEILING;
 expect(Number.isInteger(edge15)).toBe(true);
 expect((WINDOW + 1) / edge15).toBe(CALIBRATION_CEILING);
 await expectFactor(CALIBRATION_CEILING, noSeed, 'bound exactly at the ceiling', answered(edge15, refused));
 await expectFactor(1, noSeed, 'bound just above the ceiling', answered(edge15 - 1, refused));
 // A tiny estimate is an estimator that is wildly wrong, or an overflow that is not about this request: not learned.
 for (const tiny of [100, 1000, 60000]) await expectFactor(1, noSeed, `an estimate of ${tiny}`, answered(tiny, refused));
});

test('an overflow raises the factor above a seed, and the ceiling does not cap the live ratchet that follows', async () => {
 // Admitted at a seed of 1.1, a request is at most 217,000 tokens; its bound (window + 1) / 200,000 is above the seed.
 const seeded = (f: number) => sessionWith([stamp(f)]).manager;
 await expectFactor((WINDOW + 1) / 200000, seeded(1.1), 'from a seed of 1.1', answered(200000, refused));
 // A completed reply may still ratchet past the ceiling.
 await expectFactor(1.8, seeded(1.1), 'a reply at 1.8 after an overflow', async d => { await d.offer(200000); await d.reply(refused); await d.offer(100000); await d.reply(reporting(180000)); });
});

test('errors that are not a context overflow teach nothing', async () => {
 const others: [string, Parameters<Drive['reply']>[0]][] = [
  ['a rate limit', { stopReason: 'error', errorMessage: '429 Rate limit exceeded: too many requests, retry later' }],
  ['a throttling error that mentions tokens', { stopReason: 'error', errorMessage: 'Throttling error: Too many tokens, please wait before trying again.' }],
  ['a refusal', { stopReason: 'error', errorMessage: 'The model refused to answer this request.' }],
  ['a rejected key', { stopReason: 'error', errorMessage: '401 Invalid API key provided.' }],
  ['a server error', { stopReason: 'error', errorMessage: '500 Internal server error' }],
  ['an error with no message', { stopReason: 'error' }],
  ['the overflow text on an aborted reply', { stopReason: 'aborted', errorMessage: OVERFLOW_TEXT }],
  ['the overflow text on a completed reply that reports usage', { stopReason: 'stop', errorMessage: OVERFLOW_TEXT, ...reporting(Math.round(1.3 * E)) }],
 ];
 for (const [name, reply] of others) await expectFactor(1, noSeed, name, answered(E, { content: [], ...reply }));
});

test('an overflow teaches only when the request was paired exactly as a completed reply must be', async () => {
 const f = (WINDOW + 1) / E;
 // No request was offered, or it was already answered once.
 await expectFactor(1, noSeed, 'unpaired', async d => { await d.reply(refused); });
 await expectFactor(1, noSeed, 'the pairing is used up by the first reply', async d => { await d.offer(E); await d.reply({}); await d.reply(refused); });
 // The request changed after the guard counted it.
 await expectFactor(1, noSeed, 'snapshot mismatch', async d => { const messages = await d.offer(E); messages[0]!.content += 'changed'; await d.reply(refused); });
 // The reply is not from the model the request went to.
 for (const [name, over] of [['provider', { provider: 'other' }], ['model', { model: 'other' }], ['api', { api: 'other' }]] as const)
  await expectFactor(1, noSeed, 'another ' + name, answered(E, { ...refused, ...over }));
 // The run was aborted.
 await expectFactor(1, noSeed, 'aborted run', async d => { await d.offer(E); Object.assign(d.ctx, { signal: AbortSignal.abort() }); await d.reply(refused); });
 // The host stopped being active between the request and its reply.
 let on = true;
 await expectFactor(1, noSeed, 'inactive host', async d => { await d.offer(E); on = false; await d.reply(refused); on = true; }, { active: () => on });
 // The model was switched between the request and its reply: the reply is the new identity's, and the request was not.
 const other = { ...MODEL, id: 'another-model' };
 await expectFactor(1, noSeed, 'identity changed', async d => { await d.offer(E); d.ctx.model = other; await d.reply({ ...refused, model: other.id }); });
 // Control: the same request, unchanged, teaches.
 await expectFactor(f, noSeed, 'paired', answered(E, refused));
});
