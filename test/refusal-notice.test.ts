import { test, expect } from 'vitest';
import { overflowNotice, refusalNotice } from '../src/compaction';
import { EXACT_RESERVE, HOST, harness } from './budget-fixture';

const ADVICE = "; shorten the input, use a model with a larger window, or lower Pi's compaction.reserveTokens, then retry.";

test('a refusal at an ordinary calibration is unchanged', () => {
	for (const factor of [1, 1.19, 1.49]) expect(refusalNotice('Budget exceeded', factor)).toBe('Budget exceeded' + ADVICE);
});

test('a refusal at a high planning factor shows the adjustment', () => {
	const notice = refusalNotice('Budget exceeded', 2.4252);
	expect(notice.startsWith('Budget exceeded' + ADVICE)).toBe(true);
	expect(notice).toContain('planning with 2.4x its base input estimate');
	expect(notice).toContain('a different upstream may count less');
});

// A provider that refuses pi-tuck's request for exceeding its window ends the turn with its own error. That is still a refusal the operator must
// hear about: pi-tuck's estimate is what admitted the request, and a turn that stopped with no word from the package read as a hang.
test('a provider overflow labels the factor as an estimate from the configured window', () => {
	const at = overflowNotice(32_768, 25_143 / 22_136, true);
	expect(at).toContain('Using the configured 32768-token window as the input limit');
	expect(at).toContain('planning factor of 1.14x');
	expect(at).toContain('added this estimate to its calibration');
	// A bound past the ceiling is not learned, and the notice must not claim it was.
	const far = overflowNotice(32_768, 2.4, false);
	expect(far).toContain('planning factor of 2.40x');
	expect(far).toContain('the factor is unchanged');
	expect(far).not.toContain('added this estimate to its calibration');
});

test('the overflow notice reaches the operator on the turn the provider refused', async () => {
	const h = await harness({ at: 'prompt', complete: 60_000, host: HOST, reserveTokens: 0, compaction: EXACT_RESERVE, replies: ['overflow', 'overflow'] });
	try {
		const r = await h.run();
		// Pi recovers once and retries; the second refusal is the end of the turn, and pi-tuck has said its piece at each.
		expect(r.last).toMatchObject({ stopReason: 'error' });
		expect(h.notices.filter(n => n.includes('the provider refused this request for context overflow'))).toHaveLength(2);
	} finally { await h.cleanup(); }
});
