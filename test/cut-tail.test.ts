import { expect, test } from 'vitest';
import { applyTailBudget, buildOwnCut, findBudgetCutIndex } from '../src/pi-tuck/cut';

// F3: the budget cut is searched forward from the crossing and, only when that finds no boundary (the crossing is inside the final all-toolResult
// tail) and only for an oversized user-anchored tail (Case B), backward to the nearest earlier non-toolResult message. Case A (compact-all) keeps
// the forward-only search. One char is one token here (charsPerToken 1), so the sizes below are token counts.
const msg = (role: 'user' | 'assistant' | 'toolResult', size: number) => ({ role, content: 'x'.repeat(size) });
const live = (...messages: ReturnType<typeof msg>[]) => messages.map((message, i) => ({ entry: { id: `e${i}`, type: 'message' }, message }));
const entries = (...messages: ReturnType<typeof msg>[]) => messages.map((message, i) => ({ type: 'message', id: `e${i}`, parentId: i ? `e${i - 1}` : null, timestamp: '2026-01-01T00:00:00.000Z', message }));

test('a crossing inside a final all-toolResult tail returns the nearest earlier non-toolResult index', () => {
	// Newest first: 5, 10 -> the crossing is index 2 (a toolResult), and nothing after it is a boundary.
	expect(findBudgetCutIndex(live(msg('user', 5), msg('assistant', 5), msg('toolResult', 5), msg('toolResult', 5)), 10, 1, true)).toBe(1);
	// The fallback skips receipts at and before the crossing (index 3) to the nearest earlier boundary (index 2).
	expect(findBudgetCutIndex(live(msg('user', 5), msg('assistant', 5), msg('assistant', 12), msg('toolResult', 5), msg('toolResult', 5)), 10, 1, true)).toBe(2);
	// No earlier boundary at index 1 or later: still -1.
	expect(findBudgetCutIndex(live(msg('user', 5), msg('toolResult', 5), msg('toolResult', 5)), 10, 1, true)).toBe(-1);
});

test('without the Case B flag (Case A, compact-all) the search stays forward-only', () => {
	expect(findBudgetCutIndex(live(msg('user', 5), msg('assistant', 5), msg('toolResult', 5), msg('toolResult', 5)), 10, 1)).toBe(-1);
});

test('a forward success is unchanged', () => {
	// Crossing at index 2 (user), the forward search finds index 3 (assistant) and the backward fallback is not consulted.
	expect(findBudgetCutIndex(live(msg('user', 5), msg('assistant', 5), msg('user', 5), msg('assistant', 5)), 10, 1)).toBe(3);
	// Forward skips receipts to the next boundary.
	expect(findBudgetCutIndex(live(msg('user', 5), msg('assistant', 5), msg('toolResult', 5), msg('toolResult', 5), msg('assistant', 5)), 12, 1)).toBe(4);
	// The budget is not crossed at all.
	expect(findBudgetCutIndex(live(msg('user', 2), msg('assistant', 2)), 10, 1)).toBe(-1);
});

test('the oversized-tail guard still keeps the user-boundary tail when the cut is not after its start', () => {
	// The tail starts at index 2 (36 tokens, over 2.5 x 10). The backward fallback lands on index 2, which is not after the tail start.
	const guarded = [msg('user', 2), msg('assistant', 2), msg('user', 12), msg('toolResult', 12), msg('toolResult', 12)];
	const cut = buildOwnCut(entries(...guarded), 1);
	expect(cut.ok && !cut.compactAll && cut.messages.length).toBe(2);
	expect(applyTailBudget(entries(...guarded), cut, { maxTokens: 10, charsPerToken: 1 })).toBe(cut);
	// With a boundary after the tail start (index 3, an assistant message), the fallback now cuts there instead of keeping the whole tail.
	const tail = [msg('user', 2), msg('assistant', 2), msg('user', 2), msg('assistant', 10), msg('toolResult', 10), msg('toolResult', 10)];
	const wide = buildOwnCut(entries(...tail), 1);
	const result = applyTailBudget(entries(...tail), wide, { maxTokens: 10, charsPerToken: 1 });
	expect(result.ok && !result.compactAll && result.budgetCut).toBe('oversized_tail');
	expect(result.ok && result.firstKeptEntryId).toBe('e3');
});
