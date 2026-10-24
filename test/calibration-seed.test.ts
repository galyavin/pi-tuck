import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { CALIBRATION_CEILING, CALIBRATION_WINDOW, seedWindow } from '../src/compaction';
import { BAND_EXACT, EXACT_RESERVE, HOST, OVERFLOW_TEXT, ROOM_EXACT, WINDOW, harness, receiptOf } from './budget-fixture';
import { CAPACITY, KEY, MODEL, SUMMARY, drive, edge, expectFactor, receipted, reporting, sessionWith, stamp, stampWindow } from './calibration-fixture';

// The calibration factor (I12) is the ratio of the provider's input count to the compactor's estimate. It is kept in memory and learned from replies, so
// a Stop and Resume lost it. A session now starts under an accounting identity with the window the newest receipt on its branch recorded for that
// identity (entries clamped to [0, CALIBRATION_CEILING]). A missing or malformed window falls back to that receipt's single factor, and a receipt that fails
// every check gives 1 (never an older receipt).
// The factor is read through the guard (calibration-fixture.ts); exact values are also read off the receipts of real cuts.
const OTHER = { ...MODEL, id: 'another-model' };
const sessionOf = (details: unknown[]) => sessionWith(details).manager;

test('a Resume starts at the newest receipt: 1.19 over an earlier 1.05, and 1.05 over an earlier 1.19 (the newest, not the largest)', async () => {
 await expectFactor(1.19, sessionOf([stamp(1.05), stamp(1.19)]), 'newest 1.19');
 await expectFactor(1.05, sessionOf([stamp(1.19), stamp(1.05)]), 'newest 1.05');
 await expectFactor(1, sessionOf([]), 'no compaction');
 await expectFactor(1, sessionOf([stamp(1)]), 'a receipt that recorded 1');
});

test('only the newest receipt counts: when it fails, the seed is 1 and an older valid receipt is not consulted', async () => {
 const valid = stamp(1.19);
 const failing: [string, unknown][] = [
  ['another model', stamp(1.3, JSON.stringify([MODEL.provider, MODEL.api, 'another-model']))],
  ['another provider', stamp(1.3, JSON.stringify(['other', MODEL.api, MODEL.id]))],
  ['another api', stamp(1.3, JSON.stringify([MODEL.provider, 'other-api', MODEL.id]))],
  ['an identity in another format', stamp(1.3, [MODEL.provider, MODEL.api, MODEL.id].join('|'))],
  ['an identity that is not a string', stamp(1.3, [MODEL.provider, MODEL.api, MODEL.id])],
  ['an identity that is a one-element array holding the key', stamp(1.3, [KEY])],
  ['no identity field (a receipt written before T10)', receipted({ calibrationFactor: 1.3 })],
  ['an identity field that is null', stamp(1.3, null)],
 ];
 for (const [name, details] of failing) {
  await expectFactor(1, sessionOf([valid, details]), name + ' over a valid older receipt');
  await expectFactor(1, sessionOf([details]), name + ' alone');
 }
 // The reverse: a failing older receipt does not hide a valid newer one.
 for (const [name, details] of failing) await expectFactor(1.19, sessionOf([details, valid]), name + ' under a valid newer receipt');
});

test('a value that is not a finite number gives 1, wherever it sits', async () => {
 const forged: [string, unknown][] = [['NaN', Number.NaN], ['Infinity', Number.POSITIVE_INFINITY], ['-Infinity', Number.NEGATIVE_INFINITY], ['a string', '1.2'], ['null', null], ['missing', undefined],
  ['an object', {}], ['an array', [1.2]], ['a boolean', true], ['a big integer', 12n]];
 for (const [name, value] of forged) {
  await expectFactor(1, sessionOf([stamp(1.19), stamp(value)]), name + ' over a valid older receipt');
  expect(seedWindow(sessionWith([stamp(value)]).manager.getBranch(), KEY), name).toEqual([1]);
 }
});

test('the seed is clamped to [1, 1.5]: below 1 gives 1, a recorded 9 gives 1.5, and 1.5 itself stays', async () => {
 for (const [recorded, seeded] of [[0.9, 1], [0, 1], [-3, 1], [1, 1], [1.4, 1.4], [1.5, 1.5], [1.5000001, 1.5], [2, 1.5], [9, 1.5], [Number.MAX_VALUE, 1.5]] as const) {
  expect(seedWindow(sessionWith([stamp(recorded)]).manager.getBranch(), KEY), String(recorded)).toEqual([seeded]);
  await expectFactor(seeded, sessionOf([stamp(recorded)]), 'recorded ' + recorded);
 }
});

test('a receipt that is present but malformed gives 1 without throwing, and no older receipt takes its place', async () => {
 const malformed: [string, unknown][] = [['null', null], ['a string', 'receipt'], ['a number', 5], ['a boolean', true], ['an array', []], ['an empty object', {}],
  ['null settings', { id: 'r', settings: null }], ['string settings', { id: 'r', settings: 'x' }], ['array settings', { id: 'r', settings: [1.2] }],
  ['settings with an identity and no factor', { id: 'r', settings: { calibrationIdentity: KEY } }]];
 for (const [name, diagnosticReceipt] of malformed) {
  const branch = sessionOf([stamp(1.19), { compactor: 'pi-tuck', version: 2, diagnosticReceipt }]);
  await expectFactor(1, branch, name);
  expect(seedWindow(branch.getBranch(), KEY), name).toEqual([1]);
 }
});

test('a compaction entry without a receipt is foreign and passed over: the newest package receipt below it decides', async () => {
 const foreign: [string, unknown][] = [['Pi\'s own details', null], ['no details', undefined], ['details that are a string', 'text'], ['details that are a number', 7], ['details that are an array', []], ['empty details', {}]];
 for (const [name, details] of foreign) {
  await expectFactor(1.19, sessionOf([stamp(1.05), stamp(1.19), details]), name + ' above the receipt');
  await expectFactor(1, sessionOf([details]), name + ' alone');
 }
});

test('only a compaction entry is read: a newer entry of another type that holds a receipt does not seed', async () => {
 const { manager } = sessionWith([stamp(1.05)]);
 manager.appendCustomMessageEntry('note', 'Not a compaction', false, stamp(1.4));
 await expectFactor(1.05, manager, 'a newer custom message');
});

test('a receipt on a sibling branch is ignored: only the active branch is read', async () => {
 const { manager, first } = sessionWith([]);
 const kept = manager.appendCompaction(SUMMARY, first, 1000, stamp(1.05), true);
 manager.appendCompaction(SUMMARY, first, 1000, stamp(1.4), true);
 manager.branch(kept);
 manager.appendMessage({ role: 'user', content: 'Continue', timestamp: 0 });
 expect(manager.getEntries().some(e => e.type === 'compaction' && (e.details as { diagnosticReceipt: { settings: { calibrationFactor: number } } }).diagnosticReceipt.settings.calibrationFactor === 1.4)).toBe(true);
 await expectFactor(1.05, manager, 'the active branch holds 1.05, the abandoned one 1.4');
 // Nothing on the active branch: the abandoned branch's receipt does not seed.
 const empty = sessionWith([]);
 empty.manager.appendCompaction(SUMMARY, empty.first, 1000, stamp(1.4), true);
 empty.manager.branch(empty.first);
 empty.manager.appendMessage({ role: 'user', content: 'Continue', timestamp: 0 });
 await expectFactor(1, empty.manager, 'the active branch holds none');
 // The branch is read where it stands at the first request, not where it stood at session start.
 const late = sessionWith([]);
 await expectFactor(1.19, late.manager, 'a receipt appended after the session started', async d => { late.manager.appendCompaction(SUMMARY, late.first, 1000, stamp(1.19), true); await d.offer(50000); });
});

test('a model switch binds a new identity: it starts at that identity\'s receipt (else 1), and switching back finds the first one again', async () => {
 const branch = sessionOf([stamp(1.19), stamp(1.3, JSON.stringify([OTHER.provider, OTHER.api, OTHER.id]))]);
 // Under the other model the newest receipt is its own.
 await expectFactor(1.3, branch, 'the other model', async d => { d.ctx.model = OTHER; });
 // Under this model the newest receipt is the other's: 1, and an older valid receipt of this model is not consulted.
 await expectFactor(1, branch, 'this model under a newer foreign-model receipt');
 // A switch re-binds from the branch, not from the previous factor: back and forth.
 const mine = sessionOf([stamp(1.19)]);
 await expectFactor(1, mine, 'switched to a model with no receipt', async d => { await d.offer(50000); d.ctx.model = OTHER; await d.offer(50000); });
 await expectFactor(1.19, mine, 'switched away and back', async d => { await d.offer(50000); d.ctx.model = OTHER; await d.offer(50000); d.ctx.model = MODEL; await d.offer(50000); });
});

test('after seeding, the factor still rises and stays at or above the seed while the seed is in the window; the live rise is not bounded by the ceiling', async () => {
 const seeded = sessionOf([stamp(1.19)]);
 const T = 100000;
 // A reply for the request just offered, reporting a ratio r of the request's estimate.
 const learn = (ratio: number) => async (d: Awaited<ReturnType<typeof drive>>) => { await d.offer(T); await d.reply(reporting(Math.round(T * ratio))); };
 await expectFactor(1.3, seeded, 'a higher ratio raises it', learn(1.3));
 await expectFactor(1.19, seeded, 'a lower ratio leaves it at the seed', learn(1.05));
 await expectFactor(1.19, seeded, 'a ratio below 1 leaves it at the seed', learn(0.5));
 await expectFactor(1.8, sessionOf([stamp(9)]), 'a seed at the ceiling is raised above it by a reply', learn(1.8));
 await expectFactor(1.3, sessionOf([]), 'with no seed it rises from 1', learn(1.3));
 // Seeding happens once per identity: later requests do not reset what the replies taught.
 await expectFactor(1.3, seeded, 'later requests keep it', async d => { await learn(1.3)(d); await d.offer(T); await d.offer(T); });
});

// -- The windowed factor -------------------------------------------------------------------------------------------------------------------------
// The factor is max(1, the last K entries of a window), K = 32: each paired ratio, each accepted overflow bound, and the seed as the window's first entry.
// A reply that is not paired (no request offered, or already answered) and a reply that reports no usage add no entry. One mutant per rule.
const K = 32, T = 100000;
type Rig = Awaited<ReturnType<typeof drive>>;
const ratio = (r: number) => async (d: Rig) => { await d.offer(T); await d.reply(reporting(Math.round(T * r))); };
const refusing = async (d: Rig, E: number) => { await d.offer(E); await d.reply({ stopReason: 'error', errorMessage: OVERFLOW_TEXT, content: [] }); };
const times = (n: number, step: (d: Rig) => Promise<void>) => async (d: Rig) => { for (let i = 0; i < n; i++) await step(d); };
const then = (...steps: ((d: Rig) => Promise<void>)[]) => async (d: Rig) => { for (const step of steps) await step(d); };
const bound = (E: number) => (WINDOW + 1) / E;
const noSeed = () => sessionOf([]);

test('the window is 32 paired replies', () => { expect(CALIBRATION_WINDOW).toBe(K); });

test('after K lower ratios the factor falls to max(1, the recent maximum): a high ratio does not stay for the session', async () => {
 await expectFactor(1.4, noSeed(), 'the high ratio is still in the window after K-1 lower ones', then(ratio(1.4), times(K - 1, ratio(1.05))));
 await expectFactor(1.05, noSeed(), 'K lower ratios push it out: the recent maximum', then(ratio(1.4), times(K, ratio(1.05))));
 await expectFactor(1.2, noSeed(), 'the maximum is of the window, not of the last reply', then(ratio(1.4), ratio(1.2), times(K - 1, ratio(1.05))));
 await expectFactor(1, noSeed(), 'ratios below 1 give the floor, never less', then(ratio(1.4), times(K, ratio(0.8))));
 await expectFactor(1, noSeed(), 'a fresh session whose ratios are all below 1 stays at 1', times(K + 3, ratio(0.8)));
});

test('a higher ratio raises the factor on that very reply, whatever the window holds', async () => {
 await expectFactor(1.3, noSeed(), 'from 1', ratio(1.3));
 await expectFactor(1.35, noSeed(), 'over a lower ratio in the window', then(ratio(1.1), ratio(1.35)));
 await expectFactor(1.3, noSeed(), 'a lower ratio after it changes nothing', then(ratio(1.3), ratio(1.1)));
 await expectFactor(1.8, noSeed(), 'a reply may rise past the ceiling', ratio(1.8));
});

test('an overflow bound is in the window: it protects the next cuts and ages out after K replies', async () => {
 const E = 230000, c = bound(E);
 expect(c).toBeGreaterThan(1.18);
 await expectFactor(c, noSeed(), 'right after the overflow', d => refusing(d, E));
 await expectFactor(c, noSeed(), 'a lower reply does not drop it', then(d => refusing(d, E), ratio(1.05)));
 await expectFactor(c, noSeed(), 'still there after K-1 lower replies', then(d => refusing(d, E), times(K - 1, ratio(1.05))));
 await expectFactor(1.05, noSeed(), 'gone after K lower replies', then(d => refusing(d, E), times(K, ratio(1.05))));
 await expectFactor(1.3, noSeed(), 'a higher reply still takes over', then(d => refusing(d, E), ratio(1.3)));
 // A bound above the ceiling is not learned, so it is not in the window either.
 const above = Math.ceil(bound(CALIBRATION_CEILING)) - 1;
 expect(bound(above)).toBeGreaterThan(CALIBRATION_CEILING);
 await expectFactor(1.05, noSeed(), 'a bound above the ceiling', then(d => refusing(d, above), ratio(1.05)));
});

test('the seed is the first entry of the window: it holds for K-1 lower replies and ages out after K', async () => {
 const seeded = () => sessionOf([stamp(1.19)]);
 await expectFactor(1.19, seeded(), 'before any reply', async () => {});
 await expectFactor(1.19, seeded(), 'after K-1 lower replies', times(K - 1, ratio(1.05)));
 await expectFactor(1.05, seeded(), 'after K lower replies the recent maximum rules', times(K, ratio(1.05)));
 await expectFactor(1, seeded(), 'after K replies below 1 the floor rules', times(K, ratio(0.8)));
 await expectFactor(1.3, seeded(), 'a higher reply raises it at once', ratio(1.3));
 // A model switch re-seeds from the branch and starts a fresh window.
 const other = { ...MODEL, id: 'another-model' };
 const m = sessionOf([stamp(1.19), stamp(1.3, JSON.stringify([other.provider, other.api, other.id]))]);
 await expectFactor(1.3, m, 'the other identity starts at its own seed', async d => { d.ctx.model = other; await d.offer(50000); });
});

test('a retry adds no ratio: a request is paired once, so a repeated or unpaired reply neither raises the factor nor delays an entry\'s aging', async () => {
 const reply = (r: number) => async (d: Rig) => { await d.reply(reporting(Math.round(T * r))); };
 await expectFactor(1.1, noSeed(), 'the second reply to one request is not paired', then(ratio(1.1), reply(1.6)));
 await expectFactor(1, noSeed(), 'a reply with no request offered', reply(1.6));
 // Unpaired replies are not window entries: one paired 1.4 followed by many unpaired ones and K-1 paired lower ones is still in the window ...
 await expectFactor(1.4, noSeed(), 'unpaired replies do not age an entry', then(ratio(1.4), times(3 * K, reply(1.05)), times(K - 1, ratio(1.05))));
 // ... and a reply that reports no usage adds none either.
 await expectFactor(1.4, noSeed(), 'a reply without usage is no entry', then(ratio(1.4), times(2 * K, async d => { await d.offer(T); await d.reply({}); }), times(K - 1, ratio(1.05))));
 await expectFactor(1.05, noSeed(), 'the K-th paired reply ages it out', then(ratio(1.4), times(3 * K, reply(1.05)), times(K, ratio(1.05))));
});

// The stale-factor property (CEO criterion 4). After any sequence of paired replies, replies with no usage, unpaired replies, accepted and ignored
// overflow bounds, the factor is max(1, the last K accepted entries): the ratios and overflow bounds, with the seed as the first entry. It is never above that.
test('property: after any sequence the factor is max(1, the last K accepted ratios and overflow bounds, the seed while it is in the window)', async () => {
 let state = 20261018;
 const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32;
 for (let n = 0; n < 6; n++) {
  const seeded = n % 2 === 0, seed = seeded ? 1 + next() * (CALIBRATION_CEILING - 1) : 1, session = () => sessionOf(seeded ? [stamp(seed)] : []);
  // Ops are drawn up front; the model needs the factor to pick an overflow request the guard admits, so it runs the same entries as the code.
  const ops: { kind: 'ratio' | 'bound' | 'none' | 'unpaired'; r?: number; E?: number }[] = [], entries: number[] = [seed], held = [1]; // held[c]: how many entries the first c ops have added
  const level = () => Math.max(1, ...entries.slice(-K));
  const length = 3 * K + Math.floor(next() * 2 * K);
  for (let i = 0; i < length; i++) {
   const roll = next(), phase = Math.floor(i / 20) % 2 === 0 ? 1.3 : 1.0; // dense phases, then quiet ones
   if (roll < 0.6) { const r = Math.round(T * (0.6 + next() * (phase - 0.6) + (next() < 0.05 ? 0.15 : 0))) / T; ops.push({ kind: 'ratio', r }); entries.push(r); }
   else if (roll < 0.7) { const E = Math.min(edge(level()), Math.max(181000, edge(level()) - Math.floor(next() * 20000))); ops.push({ kind: 'bound', E }); if (bound(E) <= CALIBRATION_CEILING) entries.push(bound(E)); }
   else if (roll < 0.85) ops.push({ kind: 'none' });
   else ops.push({ kind: 'unpaired', r: 0.6 + next() * 0.8 });
   held.push(entries.length);
  }
  const run = (count: number) => async (d: Rig) => {
   for (const op of ops.slice(0, count)) {
    if (op.kind === 'ratio') await ratio(op.r!)(d);
    else if (op.kind === 'bound') await refusing(d, op.E!);
    else if (op.kind === 'none') { await d.offer(T); await d.reply({}); }
    else await d.reply(reporting(Math.round(T * op.r!)));
   }
  };
  for (const count of [K - 1, length - 1, length]) await expectFactor(Math.max(1, ...entries.slice(0, held[count]).slice(-K)), session(), `sequence ${n}, after ${count} of ${length} ops`, run(count));
 }
});

// -- The window is carried in the receipt --------------------------------------------------------------------------------------------------------
// AB1 builds a new compactor for every node attempt, so a scalar seed would restart a stale entry's life at every attempt. Each receipt now records the
// window (oldest first, at most K entries) and a new compactor seeds its window from it; a receipt without a valid window seeds [calibrationFactor].
const lowerAfter = (n: number) => times(n, ratio(1.05));

test('a stored window carries over exactly and ages on entry by entry, oldest first, from the last cut', async () => {
 const stored = () => sessionOf([stampWindow([1.3, 1.2, 1.1])]);
 await expectFactor(1.3, stored(), 'before any reply');
 await expectFactor(1.3, stored(), 'three stored entries and 29 new ones fill the window', lowerAfter(K - 3));
 await expectFactor(1.2, stored(), 'the oldest (1.3) leaves first', lowerAfter(K - 2));
 await expectFactor(1.1, stored(), 'then 1.2', lowerAfter(K - 1));
 await expectFactor(1.05, stored(), 'then 1.1', lowerAfter(K));
 await expectFactor(1.4, stored(), 'a higher reply raises it at once', ratio(1.4));
 // A full stored window: the first entry leaves on the first new reply.
 const full = [1.4, ...Array<number>(K - 1).fill(1.05)];
 await expectFactor(1.4, sessionOf([stampWindow(full)]), 'a full window before any reply');
 await expectFactor(1.05, sessionOf([stampWindow(full)]), 'a full window after one reply', lowerAfter(1));
 // Entries below 1 are kept (a ratio is an entry) but the factor never falls below 1.
 await expectFactor(1, sessionOf([stampWindow([0.8, 0.9])]), 'entries below 1');
 // The window rules over a scalar that disagrees with it.
 await expectFactor(1.2, sessionOf([stampWindow([1.2, 1.1], KEY, 1.45)]), 'a stale scalar beside the window');
});

test('a receipt without a window seeds as before: its factor as the first entry, clamped to [1, 1.5]', () => {
 for (const [recorded, window] of [[1.19, [1.19]], [1.7, [1.5]], [0.6, [1]]] as const) expect(seedWindow(sessionWith([stamp(recorded)]).manager.getBranch(), KEY), String(recorded)).toEqual(window);
 expect(seedWindow(sessionWith([]).manager.getBranch(), KEY)).toEqual([1]);
 // The newest receipt decides: a newer receipt with no window hides an older one that has a window.
 expect(seedWindow(sessionWith([stampWindow([1.4, 1.3]), stamp(1.1)]).manager.getBranch(), KEY)).toEqual([1.1]);
 expect(seedWindow(sessionWith([stamp(1.1), stampWindow([1.4, 1.3])]).manager.getBranch(), KEY)).toEqual([1.4, 1.3]);
});

test('a malformed window falls back to the factor, an out-of-range entry is clamped, and nothing throws', async () => {
 const fallsBack: [string, unknown][] = [['a string', '1.3,1.2'], ['a number', 1.3], ['an object', { 0: 1.3 }], ['null', null], ['an empty array', []],
  ['one entry too many', Array<number>(K + 1).fill(1.3)], ['a NaN entry', [1.3, Number.NaN]], ['an Infinity entry', [1.3, Number.POSITIVE_INFINITY]], ['a string entry', [1.3, '1.2']],
  ['a null entry', [1.3, null]], ['an undefined entry', [1.3, undefined]], ['a nested array', [[1.3]]], ['a big integer entry', [1.3, 2n]]];
 for (const [name, window] of fallsBack) {
  const branch = sessionWith([stampWindow(window, KEY, 1.19)]).manager;
  expect(seedWindow(branch.getBranch(), KEY), name).toEqual([1.19]);
  await expectFactor(1.19, branch, name);
 }
 // Exactly K entries and exactly one entry are valid.
 expect(seedWindow(sessionWith([stampWindow(Array<number>(K).fill(1.3), KEY, 1.19)]).manager.getBranch(), KEY)).toEqual(Array<number>(K).fill(1.3));
 expect(seedWindow(sessionWith([stampWindow([1.3], KEY, 1.19)]).manager.getBranch(), KEY)).toEqual([1.3]);
 // Entries are clamped to [0, ceiling]; the factor is still at least 1.
 expect(seedWindow(sessionWith([stampWindow([9, -2, 1.2, 1.5, Number.MAX_VALUE])]).manager.getBranch(), KEY)).toEqual([1.5, 0, 1.2, 1.5, 1.5]);
 await expectFactor(1.5, sessionOf([stampWindow([9, 1.1])]), 'an entry over the ceiling');
 await expectFactor(1, sessionOf([stampWindow([-2, 0.5])]), 'entries below zero or one');
 // A malformed window beside a malformed factor gives 1; the window of another identity is never read.
 expect(seedWindow(sessionWith([stampWindow('bad', KEY, 'bad')]).manager.getBranch(), KEY)).toEqual([1]);
 expect(seedWindow(sessionWith([stampWindow([1.4, 1.3], JSON.stringify(['x', 'y', 'z']))]).manager.getBranch(), KEY)).toEqual([1]);
 expect(seedWindow(sessionWith([stampWindow([1.4, 1.3], null)]).manager.getBranch(), KEY)).toEqual([1]);
});

test('a model switch does not leak one identity\'s window into another\'s', async () => {
 const other = { ...MODEL, id: 'another-model' }, otherKey = JSON.stringify([other.provider, other.api, other.id]);
 const branch = () => sessionOf([stampWindow([1.1, 1.1], otherKey)]);
 // Under this model a 1.4 is learned; switching to the other identity seeds from the other's receipt and starts a fresh window.
 const switched = async (d: Rig) => { await ratio(1.4)(d); d.ctx.model = other; };
 await expectFactor(1.1, branch(), 'the other identity starts at its own window', switched);
 await expectFactor(1.1, branch(), 'and ages on its own window, not this model\'s 1.4', then(switched, lowerAfter(K - 2)));
 await expectFactor(1.05, branch(), 'its two 1.1 entries leave after K new ones', then(switched, lowerAfter(K)));
 // Switching back re-seeds from the branch again: the newest receipt is the other's, so this model starts at 1, not at its earlier 1.4.
 await expectFactor(1, branch(), 'switched away and back', async d => { await switched(d); await d.offer(50000); d.ctx.model = MODEL; await d.offer(50000); });
});

// The point of carrying the window. A node attempt is a new compactor (AB1 builds one per attempt) that seeds from the branch's newest receipt, and a
// cut inside the attempt writes its window into the next receipt. Each attempt here is shorter than K replies with a cut at its end. The test
// models the cut's receipt as the writer records it (the current window, oldest first); the writer itself is checked on real cuts in the equivalence
// test. A scalar seed gives every attempt a new full life to the stale entry, so the factor would stay at the high ratio for ever.
test('short attempts, each shorter than K replies and ending in a cut, let a stale high ratio age out', async () => {
 const { manager, first } = sessionWith([]);
 let entries = [1]; // the seed of an identity with no receipt
 const attempts = [[1.4, ...Array<number>(14).fill(1.05)], Array<number>(15).fill(1.05), Array<number>(15).fill(1.05), Array<number>(15).fill(1.05)];
 const seen: number[] = [];
 for (const [i, ratios] of attempts.entries()) {
  const seeded = Math.max(1, ...entries.slice(-K));
  const attempt = async (d: Rig) => { for (const r of ratios) await ratio(r)(d); };
  await expectFactor(seeded, manager, `attempt ${i} starts at the carried window`);
  entries = [...entries.slice(-K), ...ratios].slice(-K);
  expect(ratios.length).toBeLessThan(K);
  const ended = Math.max(1, ...entries);
  await expectFactor(ended, manager, `attempt ${i} ends`, attempt);
  seen.push(ended);
  manager.appendCompaction(SUMMARY, first, 1000, stampWindow(entries), true);
 }
 // 1.4 entered in attempt 0 and left in attempt 2 (1 + 15 + 15 + 15 entries put it more than K back): the factor fell without any single attempt reaching K replies.
 expect(seen).toEqual([1.4, 1.4, 1.05, 1.05]);
});

test('the seed writes nothing: the session file is byte-identical across session_start and the first requests that seed (the compactor is given the real session manager), and no file appears', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'pi-seed-'));
 try {
  const manager = SessionManager.create('/x', dir), first = manager.appendMessage({ role: 'user', content: 'Opening task', timestamp: 0 });
  manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Observed' }], provider: MODEL.provider, api: MODEL.api, model: MODEL.id, stopReason: 'stop', timestamp: 0,
   usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  manager.appendCompaction(SUMMARY, first, 1000, stamp(1.19), true);
  const file = manager.getSessionFile()!, bytes = readFileSync(file), names = readdirSync(dir).sort();
  expect(names).toHaveLength(1);
  // The session as a Resume opens it.
  const resumed = SessionManager.open(file, dir);
  const d = await drive(resumed);
  try { await d.start(); await d.offer(50000); await d.reply(reporting(60000)); await d.offer(50000); } finally { await d.close(); }
  expect(d.errors).toEqual([]);
  await expectFactor(1.19, resumed, 'read from the file');
  expect(readFileSync(file).equals(bytes)).toBe(true);
  expect(readdirSync(dir).sort()).toEqual(names);
 } finally { rmSync(dir, { recursive: true, force: true }); }
});

// -- Real Pi sessions ---------------------------------------------------------------------------------------------------------------------------

test('every receipt records the accounting identity it was written under', async () => {
 const h = await harness({ at: 'prompt', complete: BAND_EXACT + 1500, host: HOST, reserveTokens: 0, compaction: EXACT_RESERVE });
 try {
  const r = await h.run();
  expect(r.faults, r.probe).toEqual([]);
  expect(r.entries, r.probe).toHaveLength(1);
  expect(receiptOf(r.entries[0]!).calibrationIdentity, r.probe).toBe(KEY);
 } finally { await h.cleanup(); }
});

test('a reopened session counts, triggers and plans its first cut at the newest receipt\'s factor, and the cut\'s own receipt records it', async () => {
 // Raw, the request is below the band and nothing would be cut; at 1.19 it is inside the band, so a cut happens only if the factor was seeded.
 const complete = Math.ceil(BAND_EXACT / 1.19) + 500;
 const h = await harness({ at: 'prompt', complete, host: HOST, reserveTokens: 0, compaction: EXACT_RESERVE });
 try {
  const first = h.manager.getBranch()[0]!.id;
  for (const f of [1.05, 1.19]) h.manager.appendCompaction(SUMMARY, first, 1000, stamp(f), true);
  // Pi has nothing to compact when a compaction is the last saved entry.
  h.manager.appendMessage(h.answer([{ type: 'text', text: 'Observed prior result' }]));
  const injected = h.compactions().length;
  const r = await h.run();
  const probe = r.probe;
  expect(r.faults, probe).toEqual([]);
  expect(r.entries, probe).toHaveLength(injected + 1);
  const entry = receiptOf(r.entries.at(-1)!);
  expect(entry.calibrationFactor, probe).toBe(1.19);
  expect(entry.calibrationIdentity, probe).toBe(KEY);
  expect(entry.draftReservedTokens, probe).toBe(WINDOW - Math.floor((entry.target === 'band' ? BAND_EXACT : ROOM_EXACT) / 1.19) + entry.mandatoryInputTokens!);
 } finally { await h.cleanup(); }
});

// Run A learns a factor in one process and cuts twice. Run B is the same history with a Stop and Resume between the cuts (the extension is torn
// down and installed afresh, Pi's reload), seeded from the first cut's receipt. The second cut is the same cut. Only the first reply reports
// usage, so the factor learned (75,000 over the estimate of the first request) is the same number in both runs.
async function twoCuts(resume: boolean) {
 const h = await harness({ at: 'prompt', complete: 60000, host: HOST, reserveTokens: 0, compaction: EXACT_RESERVE, usageFirst: 75000 });
 try {
  await h.run();
  await h.session.prompt('Second request ' + 'q'.repeat(4 * 140000));
  if (resume) await h.session.reload();
  await h.session.prompt('Third request ' + 'q'.repeat(4 * 140000));
  const cuts = h.compactions().map(entry => ({ receipt: receiptOf(entry), kept: h.manager.getBranch().findIndex(e => e.id === entry.firstKeptEntryId), tokensBefore: entry.tokensBefore }));
  return { cuts, faults: [...h.faults], estimate: h.guard[0]!, requests: h.state.requests };
 } finally { await h.cleanup(); }
}
test('equivalence: a seeded Resume plans its next cut exactly as the continuous run that learned the same factor', async () => {
 const a = await twoCuts(false), b = await twoCuts(true);
 const probe = JSON.stringify({ a, b });
 expect(a.faults, probe).toEqual([]);
 expect(b.faults, probe).toEqual([]);
 expect(a.cuts, probe).toHaveLength(2);
 expect(b.cuts, probe).toHaveLength(2);
 const learned = 75000 / a.estimate;
 expect(learned, probe).toBeGreaterThan(1.2);
 // Both cuts of the continuous run, and the cut before the Stop, planned at the learned factor ...
 for (const cut of [a.cuts[0]!, a.cuts[1]!, b.cuts[0]!]) expect(cut.receipt.calibrationFactor, probe).toBe(learned);
 // ... and the cut after the Resume is the continuous run's cut: the same factor, the same plan, the same boundary.
 expect(b.cuts[1], probe).toEqual(a.cuts[1]);
 // The receipt records the window beside the factor: the seed of 1 and the one learned ratio, and the Resume carries it unchanged.
 for (const cut of [a.cuts[0]!, a.cuts[1]!, b.cuts[0]!, b.cuts[1]!]) expect(cut.receipt.calibrationWindow, probe).toEqual([1, learned]);
});

test('a Resume after a latch caused by an anomalous in-process factor is executable again: the seed is capped at the ceiling and the room fits the mandatory input', async () => {
 // A reply reports nine times the estimate (the ordinary ratchet has no upper bound). The next cut is planned at 9 and records it. The host input then
 // grows to 25,000 tokens, about 42,000 mandatory with the system part (the order of AB1's own): at 9 they no longer fit the room, so the next request
 // is refused and the failure latches.
 const h = await harness({ at: 'prompt', complete: 24000, host: HOST, reserveTokens: 0, compaction: EXACT_RESERVE, usageFirst: 216000 });
 try {
  await h.run();
  await h.session.prompt('Second request ' + 'q'.repeat(4 * 5000));
  const [cut] = h.compactions();
  expect(cut, JSON.stringify(h.faults)).toBeDefined();
  expect(receiptOf(cut!).calibrationFactor).toBeGreaterThan(8);
  expect(h.faults).toEqual([]);
  h.setHost(25000);
  await h.session.prompt('Third request');
  expect(h.faults.join(' ')).toContain(CAPACITY);
  expect(h.state.aborts).toBe(1);
  const refused = h.state.requests;
  // The Resume: the factor is seeded from the receipt, which recorded 9, at the ceiling.
  await h.session.reload();
  const faults = h.faults.length;
  await h.session.prompt('Fourth request');
  expect(h.faults.slice(faults), JSON.stringify(h.faults)).toEqual([]);
  expect(h.state.requests).toBe(refused + 1);
  expect(h.session.messages.findLast(m => m.role === 'assistant')).toMatchObject({ stopReason: 'stop' });
 } finally { await h.cleanup(); }
});
