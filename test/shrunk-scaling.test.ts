import { test, expect } from 'vitest';
import { run } from './synthetic-sessions';

// A shrunk draft's cost grows with the history it shrinks, not with its square. The ratio of two drafts, one over four times the entries
// of the other, is checked, never a wall-clock time: linear growth is about 4x, and a ladder that rendered every candidate whole would
// be about 16x. Each size takes the fastest of three drafts, to keep scheduling noise out of the ratio.
const draft = (turns: number) => {
	let fastest = Infinity, entries = 0;
	for (let attempt = 0; attempt < 3; attempt++) {
		const [cut] = run('low-prose', { window: 128000, reserve: 16384, turns, cutAt: turns });
		expect(cut?.mode).toBe('shrunk');
		fastest = Math.min(fastest, cut!.ms); entries = cut!.entries;
	}
	return { ms: fastest, entries };
};

test('a shrunk draft over four times the entries takes less than eight times as long', () => {
	const small = draft(300), large = draft(1200);
	expect(large.entries / small.entries).toBeGreaterThanOrEqual(4);
	expect(large.ms / small.ms, JSON.stringify({ small, large })).toBeLessThan(8);
}, 600_000);
