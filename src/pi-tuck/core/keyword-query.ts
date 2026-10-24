/** A literal, case-insensitive (non-Unicode-RegExp) keyword matcher. */
export interface KeywordMatcher {
  readonly term: string;
  /** Stateless containment test. */
  test(text: string): boolean;
  /** Stateless first match at or after fromIndex, in UTF-16 source coordinates. */
  find(text: string, fromIndex?: number): { index: number; text: string } | undefined;
  /** Equality under the exact matcher semantics, rather than case folding. */
  equivalent(other: KeywordMatcher): boolean;
}

export interface PreparedKeywordQuery {
  /** Stopword-filtered terms in original sequence, including duplicates. */
  readonly terms: readonly KeywordMatcher[];
  /** Terms deduplicated by actual matcher equivalence, for coverage decisions. */
  readonly coverageTerms: readonly KeywordMatcher[];
  test(text: string): boolean;
}

const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "shall", "of", "in", "to", "for",
  "with", "on", "at", "from", "by", "as", "into", "through", "during",
  "before", "after", "above", "below", "between", "out", "off", "over",
  "under", "again", "further", "then", "once", "here", "there", "when",
  "where", "why", "how", "all", "both", "each", "few", "more", "most",
  "other", "some", "such", "no", "nor", "not", "only", "own", "same",
  "so", "than", "too", "very", "just", "about", "it", "its", "that",
  "this", "what", "which", "who", "whom", "these", "those",
]);

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const matcher = (term: string): KeywordMatcher => {
  const source = escapeRegex(term);
  const testRegex = new RegExp(source, "i");
  const findRegex = new RegExp(source, "gi");
  const exactRegex = new RegExp(`^(?:${source})$`, "i");
  return {
    term,
    test: (text) => testRegex.test(text),
    find: (text, fromIndex = 0) => {
      findRegex.lastIndex = Math.max(0, fromIndex);
      const match = findRegex.exec(text);
      findRegex.lastIndex = 0; // No cursor survives a call, including unsuccessful searches.
      return match ? { index: match.index, text: match[0] } : undefined;
    },
    equivalent: (other) => exactRegex.test(other.term)
      && new RegExp(`^(?:${escapeRegex(other.term)})$`, "i").test(term),
  };
};

/** Prepare the natural-keyword semantics shared by ranking and localization. */
export const prepareKeywordQuery = (query: string): PreparedKeywordQuery => {
  const raw = query.trim().split(/\s+/).filter(Boolean);
  const meaningful = raw.filter((term) => !STOPWORDS.has(term.toLowerCase()) && term.length > 1);
  const selected = meaningful.length ? meaningful : raw;
  const terms = selected.map(matcher);
  const coverageTerms: KeywordMatcher[] = [];
  for (const term of terms) if (!coverageTerms.some((seen) => seen.equivalent(term))) coverageTerms.push(term);
  return {
    terms,
    coverageTerms,
    test: (text) => terms.some((term) => term.test(text)),
  };
};
