import { expect, test } from 'vitest';
import { MEASURED_CALIBRATION, seedWindow } from '../src/compaction';
import { MODEL, drive, expectFactor, reporting, sessionWith, stamp, stampWindow } from './calibration-fixture';

// The measured seed is retired: the 1.18 measured for openai/gpt-6.1-sol was the replayed reasoning that the estimate now counts. The
// table stays the place for a measured model; it is empty, so every model starts at 1 when its branch has no receipt of its own, and receipts still seed.
// The fixture's MODEL is openai-codex/gpt-6.1-sol; MEASURED is the same model under provider openai, the identity the seed was keyed to.
const MEASURED = { ...MODEL, provider: 'openai' };
const KEY_OF = (m: typeof MODEL) => JSON.stringify([m.provider, m.api, m.id]);
const T = 100000;
type Rig = Awaited<ReturnType<typeof drive>>;
const use = (m: typeof MODEL) => async (d: Rig) => { d.ctx.model = m; };
const ratio = (r: number) => async (d: Rig) => { await d.offer(T); await d.reply(reporting(Math.round(T * r))); };
const then = (...steps: ((d: Rig) => Promise<void>)[]) => async (d: Rig) => { for (const step of steps) await step(d); };
const fresh = () => sessionWith([]).manager;

test('the table is empty: every identity without a receipt starts its window at 1', () => {
 expect(MEASURED_CALIBRATION).toEqual({});
 for (const key of [KEY_OF(MEASURED), KEY_OF(MODEL), JSON.stringify(['openai', MODEL.api, 'another-model']), '']) expect(seedWindow(fresh().getBranch(), key)).toEqual([1]);
});

test('a fresh session of the formerly seeded model starts at 1, and a higher reply raises it at once', async () => {
 await expectFactor(1, fresh(), 'formerly seeded model, no receipt', use(MEASURED));
 await expectFactor(1, fresh(), 'another model, no receipt', use(MODEL));
 await expectFactor(1.3, fresh(), 'a higher reply raises it at once', then(use(MEASURED), ratio(1.3)));
});

test('a receipt of the identity\'s own still seeds; a newest foreign receipt, a malformed own one or a model switch gives 1', async () => {
 await expectFactor(1.05, sessionWith([stamp(1.05, KEY_OF(MEASURED))]).manager, 'own receipt factor 1.05', use(MEASURED));
 await expectFactor(1.1, sessionWith([stampWindow([1.02, 1.1], KEY_OF(MEASURED))]).manager, 'own receipt window', use(MEASURED));
 await expectFactor(1, sessionWith([stamp(1.05, KEY_OF(MEASURED)), stamp(1.3, KEY_OF(MODEL))]).manager, 'newest receipt is another identity\'s', use(MEASURED));
 await expectFactor(1, sessionWith([stamp('not a number', KEY_OF(MEASURED))]).manager, 'own receipt with neither a valid window nor a valid factor', use(MEASURED));
 await expectFactor(1, fresh(), 'switched from another model', then(use(MODEL), async d => { await d.offer(50000); }, use(MEASURED), async d => { await d.offer(50000); }));
});
