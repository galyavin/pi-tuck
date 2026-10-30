import { test, expect } from 'vitest';
import { compileBrief } from '../src/tuck/core/brief';
import { IndexSet } from '../src/tuck/core/brief-meter';
import { selectRankedBriefBlocks } from '../src/tuck/core/rank';
import { selectRankedBriefBlocksByFullRender } from './ranked-reference';
import { generator, session } from './random-sessions';

// The incremental admission loop must choose what the full render chooses. DIFFERENTIAL_SESSIONS widens the search.
const SESSIONS = Number(process.env.DIFFERENTIAL_SESSIONS ?? 60);

test('the incremental selection chooses what the full render chooses', () => {
	let compared = 0, selected = 0;
	for (let seed = 1; seed <= SESSIONS; seed++) {
		const { blocks, options } = session(seed);
		for (let run = 0; run < 3; run++) {
			const settings = options();
			const expected = selectRankedBriefBlocksByFullRender(blocks, settings);
			const actual = selectRankedBriefBlocks(blocks, settings);
			const where = `session ${seed}, run ${run}, ${JSON.stringify({ ...settings, mandatorySourceIndices: undefined, fileOps: undefined })}`;
			expect(actual.map(block => blocks.indexOf(block)), where).toEqual(expected.map(block => blocks.indexOf(block)));
			expect(compileBrief(actual), where).toBe(compileBrief(expected));
			compared++; selected += actual.length;
		}
	}
	expect(compared).toBe(SESSIONS * 3);
	expect(selected).toBeGreaterThan(SESSIONS);
}, 600_000);

test('an index set answers neighbour queries as a sorted list does', () => {
	for (const size of [1, 31, 32, 33, 1024, 1025, 5000, 40000]) {
		const { int } = generator(size);
		const set = new IndexSet(size), members = new Set<number>();
		for (let step = 0; step < 3000; step++) {
			const i = int(size);
			if (int(3)) { set.add(i); members.add(i); } else { set.remove(i); members.delete(i); }
			const query = int(size), sorted = [...members].sort((a, b) => a - b);
			expect(set.has(query)).toBe(members.has(query));
			expect(set.next(query)).toBe(sorted.find(m => m > query) ?? -1);
			expect(set.prev(query)).toBe(sorted.findLast(m => m < query) ?? -1);
		}
	}
});
