import { test, expect } from 'vitest';
import { run } from './synthetic-sessions';

// A ranked draft's cost grows with the history it ranks, not with its square. The ratio of two drafts, one over four times the entries of
// the other, is checked, never a wall-clock time: linear growth is about 4x, and the admission loop that planned and rendered every
// candidate whole was about 16x. Each size takes the fastest of three drafts, to keep scheduling noise out of the ratio.
const draft = (turns: number) => {
	let fastest = Infinity, entries = 0;
	for (let attempt = 0; attempt < 3; attempt++) {
		const [cut] = run('low-prose', { window: 128000, reserve: 16384, turns, cutAt: turns });
		expect(cut?.mode).toBe('ranked');
		fastest = Math.min(fastest, cut!.ms); entries = cut!.entries;
	}
	return { ms: fastest, entries };
};

test('a ranked draft over four times the entries takes less than eight times as long', () => {
	const small = draft(300), large = draft(1200);
	expect(large.entries / small.entries).toBeGreaterThanOrEqual(4);
	expect(large.ms / small.ms, JSON.stringify({ small, large })).toBeLessThan(8);
}, 600_000);
