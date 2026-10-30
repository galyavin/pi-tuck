import { test, expect, afterAll } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { run, type Run, type Shape } from './synthetic-sessions';

// The ranked view must not change when its cost does. Each case grows a seeded session through successive cuts and pins the SHA-256 of
// every cut's summary (with the index of its first kept entry), as recorded from the code before the ranked admission loop was made
// incremental. The mode of each cut is pinned too: a different one means the case no longer exercises the view it was chosen for.
// GOLDEN_RECORD=<file> rewrites the pins instead of checking them.
const cases: { name: string; shape: Shape; options: Run }[] = [
	{ name: 'prose-32k', shape: 'prose', options: { window: 32000, reserve: 4096, turns: 60, stopAfterCuts: 3 } },
	{ name: 'low-prose-32k', shape: 'low-prose', options: { window: 32000, reserve: 4096, turns: 500, stopAfterRanked: 2 } },
	{ name: 'residual-32k', shape: 'residual', options: { window: 32000, reserve: 4096, turns: 600, stopAfterCuts: 6 } },
	{ name: 'prose-128k', shape: 'prose', options: { window: 128000, reserve: 16384, turns: 130, stopAfterCuts: 2 } },
	{ name: 'low-prose-128k', shape: 'low-prose', options: { window: 128000, reserve: 16384, turns: 700, stopAfterRanked: 1 } },
];

const pins = new URL('./ranked-golden.json', import.meta.url);
const recording = process.env.GOLDEN_RECORD !== undefined;
const recorded: Record<string, unknown> = {};
afterAll(() => { if (recording) writeFileSync(pins, JSON.stringify(recorded, null, '\t') + '\n'); });

for (const { name, shape, options } of cases)
	test(`${name}: summaries stay byte-identical`, () => {
		const cuts = run(shape, options).map(r => [r.mode, r.turn, r.sha256]);
		if (recording) { recorded[name] = cuts; return; }
		expect(cuts).toEqual(JSON.parse(readFileSync(pins, 'utf8'))[name]);
	}, 600_000);
