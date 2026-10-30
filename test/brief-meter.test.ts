import { test, expect } from 'vitest';
import { compileBrief, planBrief, type ExcerptCache } from '../src/tuck/core/brief';
import { createBriefMeter } from '../src/tuck/core/brief-meter';
import { TRANSCRIPT_HEADER, transcriptUnits } from '../src/tuck/core/transcript';
import type { NormalizedBlock } from '../src/tuck/types';
import { generator, session } from './random-sessions';

// After every step of a random walk over selections, the meter's size is the size of the full render, exactly: both with the omission
// notices and without them, for the selection as it would be if the blocks about to be admitted were. The walk follows the admission
// protocol: select, promote, measure, then commit or take both back.
const SESSIONS = Number(process.env.DIFFERENTIAL_SESSIONS ?? 60);

test('the meter measures what the full render measures', () => {
	let steps = 0, committed = 0;
	for (let seed = 1; seed <= SESSIONS; seed++) {
		const { blocks, mandatory } = session(seed);
		if (!blocks.length) continue;
		const { int, random } = generator(seed + 1000);
		const selected = new Set<number>(), full = new Set<NormalizedBlock>();
		const measure = (chosen: Set<number>, whole: Set<NormalizedBlock>, notices: boolean, base: ReadonlySet<number> | undefined) => {
			const candidate = [...chosen].sort((a, b) => a - b).map(i => blocks[i]!);
			planBrief(candidate, whole, blocks, base, notices);
			const rendered = TRANSCRIPT_HEADER + '\n' + compileBrief(candidate);
			return { chars: rendered.length, units: transcriptUnits(rendered) };
		};
		const base = random() < 0.7 ? mandatory : undefined;
		const checked = createBriefMeter(blocks, base, new WeakMap() as ExcerptCache);
		for (let step = 0; step < 60; step++) {
			const added = Array.from({ length: 1 + int(3) }, () => int(blocks.length)).filter((i, at, all) => !selected.has(i) && all.indexOf(i) === at);
			const promoted = [...new Set([...added, ...selected])].filter(i => ['user', 'assistant', 'bash'].includes(blocks[i]!.kind) && !full.has(blocks[i]!) && random() < 0.4);
			for (const i of added) checked.select(i);
			for (const i of promoted) checked.promote(i);
			const candidate = new Set([...selected, ...added]), whole = new Set([...full, ...promoted.map(i => blocks[i]!)]);
			const size = checked.size(added);
			const where = `session ${seed}, step ${step}, added ${added}, promoted ${promoted}`;
			expect(size.withNotices, where).toEqual(measure(candidate, whole, true, base));
			expect(size.withoutNotices, where).toEqual(measure(candidate, whole, false, base));
			steps++;
			if (random() < 0.55) {
				for (const i of added) selected.add(i);
				for (const i of promoted) full.add(blocks[i]!);
				checked.commit(added);
				committed++;
			} else {
				for (const i of promoted) checked.demote(i);
				for (const i of added) checked.unselect(i);
				// Taken back, the meter is where it was: the committed selection measures as the full render says. (A brief is never
				// measured with nothing selected, which the full render would leave without source times.)
				if (selected.size) {
					expect(checked.size([]).withoutNotices, where + ' (taken back)').toEqual(measure(selected, full, false, base));
					expect(checked.size([]).withNotices, where + ' (taken back)').toEqual(measure(selected, full, true, base));
				}
			}
		}
	}
	expect(steps).toBeGreaterThan(SESSIONS);
	expect(committed).toBeGreaterThan(SESSIONS / 2);
}, 600_000);
