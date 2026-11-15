import { prepareKeywordQuery, type KeywordMatcher } from "./keyword-query";

/**
 * Wall-clock budget for one search. A normal query over 400 entries takes ~10ms.
 * Aborting loudly beats returning a silently truncated match count.
 *
 * This is a per-entry checkpoint, not a hard per-call ceiling: JavaScript cannot
 * interrupt a running `RegExp.test`, so a single pathological entry still runs to
 * completion and the overshoot is caught on the next iteration. That bounds the
 * damage to one entry instead of the whole corpus, which is the point — the
 * unbounded case was N entries multiplied by the per-entry cost.
 */
const SEARCH_BUDGET_MS = 3000;

const startBudget = (): (() => void) => {
  const deadline = Date.now() + SEARCH_BUDGET_MS;
  return () => {
    if (Date.now() > deadline) {
      throw new Error(
        `Search aborted: query exceeded ${SEARCH_BUDGET_MS}ms on this history. ` +
        "Use more specific words, or read an entry by index.",
      );
    }
  };
};

/** Count matching terms. Query sequence and duplicates intentionally contribute. */
const countMatches = (hay: string, terms: readonly KeywordMatcher[]): number =>
  terms.reduce((count, term) => count + Number(term.test(hay)), 0);

// ── BM25-lite scoring ──
const BM25_K = 1.2;
const BM25_B = 0.75;

/** Count non-overlapping literal occurrences with the prepared matcher's rules. */
const termFreq = (text: string, matcher: KeywordMatcher): number => {
  let count = 0, offset = 0;
  for (;;) {
    const found = matcher.find(text, offset);
    if (!found) return count;
    count++;
    offset = found.index + Math.max(found.text.length, 1);
  }
};

interface BM25Context {
  n: number;         // total docs
  avgDl: number;     // average doc length (words)
  df: Map<string, number>; // original term -> docs containing it
}

/** Precompute IDF and avgDl across all docs. */
const buildBM25Context = (docs: string[], terms: readonly KeywordMatcher[], checkBudget: () => void): BM25Context => {
  const n = docs.length;
  const df = new Map<string, number>();
  let totalLen = 0;

  for (const doc of docs) {
    checkBudget();
    totalLen += doc.split(/\s+/).length;
    for (const term of terms) {
      if (term.test(doc)) {
        df.set(term.term, (df.get(term.term) ?? 0) + 1);
      }
    }
  }

  return { n, avgDl: totalLen / Math.max(n, 1), df };
};

/** BM25 score for a single doc against query terms. */
const bm25Score = (doc: string, terms: readonly KeywordMatcher[], ctx: BM25Context): number => {
  const dl = doc.split(/\s+/).length;
  let score = 0;

  for (const term of terms) {
    const tf = termFreq(doc, term);
    if (tf === 0) continue;

    const docFreq = ctx.df.get(term.term) ?? 0;
    // IDF: log((N - df + 0.5) / (df + 0.5) + 1)
    const idf = Math.log((ctx.n - docFreq + 0.5) / (docFreq + 0.5) + 1);
    // TF saturation with length normalization
    const tfNorm = (tf * (BM25_K + 1)) / (tf + BM25_K * (1 - BM25_B + BM25_B * dl / ctx.avgDl));
    score += idf * tfNorm;
  }

  return score;
};

/** Rank already-eligible recall rows; filtering and paging belong to the caller. */
export const rankRecallRows = (rows: readonly { role: string; text: string }[], query: string): number[] => {
  const rawQuery = query.trim();
  const checkBudget = startBudget();
  const prepared = prepareKeywordQuery(rawQuery);
  const terms = prepared.terms;
  // Preserve the role prefix and trailing space of the original BM25 documents.
  const docs = rows.map((row) => `${row.role} ${row.text} `);
  const ctx = buildBM25Context(docs, terms, checkBudget);

  const scored: Array<{ index: number; score: number }> = [];
  for (let i = 0; i < rows.length; i++) {
    checkBudget();
    const hay = docs[i];
    if (countMatches(hay, terms) === 0) continue;
    scored.push({ index: i, score: bm25Score(hay, terms, ctx) });
  }

  // Stable sort keeps source order for tied scores, including duplicate terms.
  scored.sort((a, b) => b.score - a.score);
  // Duplicate terms can make IDF negative. Preserve the original zero-floor
  // selection when a multi-term query also has a positive top score.
  const ranked = prepared.coverageTerms.length >= 2 && (scored[0]?.score ?? 0) > 0
    ? scored.filter((s) => s.score >= 0) : scored;
  return ranked.map((s) => s.index);
};
