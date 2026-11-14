import { expect, test } from 'vitest';
import { rankRecallRows } from '../src/tuck/core/search-entries';

test('duplicate keywords keep the inherited zero-floor selection', () => {
  const rows = ['auth', 'auth', 'rare'].map(text => ({ role: 'user', text }));
  expect(rankRecallRows(rows, 'auth auth rare')).toEqual([2]);
  // A single distinct term keeps its matches even when all scores are negative.
  expect(rankRecallRows(rows, 'auth auth')).toEqual([0, 1]);
  // Multi-term queries with no positive score also keep their matches.
  expect(rankRecallRows(rows, 'auth auth absent')).toEqual([0, 1]);
});

test('all tied matches survive in source order without a result cap', () => {
  const rows = Array.from({ length: 75 }, () => ({ role: 'user', text: 'needle' }));
  expect(rankRecallRows(rows, 'needle')).toEqual(rows.map((_, index) => index));
});
