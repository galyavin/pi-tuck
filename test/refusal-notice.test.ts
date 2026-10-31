import { test, expect } from 'vitest';
import { refusalNotice } from '../src/compaction';

// A capacity refusal keeps its advice; when the provider has counted far more input than pi-tuck estimates, it also names that counting,
// which is the likely cause (an upstream behind a router can spend much more context on tool schemas than others).
const ADVICE = "; shorten the input, use a model with a larger window, or lower Pi's compaction.reserveTokens, then retry.";

test('a refusal at an ordinary calibration is unchanged', () => {
	for (const factor of [1, 1.19, 1.49]) expect(refusalNotice('Budget exceeded', factor)).toBe('Budget exceeded' + ADVICE);
});

test('a refusal where the provider over-counts says so, with the factor', () => {
	const notice = refusalNotice('Budget exceeded', 2.4252);
	expect(notice.startsWith('Budget exceeded' + ADVICE)).toBe(true);
	expect(notice).toContain('counted up to 2.4x the input pi-tuck estimates');
	expect(notice).toContain('a different upstream may count less');
});
