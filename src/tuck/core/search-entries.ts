import { isLookupTool } from "./recall-operation";
import type { Message } from "@earendil-works/pi-ai";
import type { RenderedEntry } from "./render-entries";
import { textOf, extractToolCallArgsText, clip } from "./content";
import { prepareKeywordQuery, type KeywordMatcher } from "./keyword-query";

export interface SearchHit extends RenderedEntry {
  /** Number of query terms matched (for ranking) */
  matchCount?: number;
}

/**
 * Result of a search, with enough metadata for a caller to report truncation
 * honestly (see `searchEntriesDetailed`).
 */
export interface SearchResult {
  hits: SearchHit[];
  /** Genuine matches found before the hard cap was applied (after any
   *  relative-floor noise filtering). May exceed `hits.length`. */
  totalBeforeCap: number;
  /** True when the hard cap discarded matches (`totalBeforeCap > hits.length`). */
  truncated: boolean;
}
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
        `Search aborted: query exceeded ${SEARCH_BUDGET_MS}ms. Simplify the pattern — ` +
        "nested quantifiers such as (a+)+ can make matching blow up.",
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

/** Count non-overlapping literal occurrences with the prepared matcher's semantics. */
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

/**
 * Aggregate character budget for ALL toolCall arguments appended to one
 * message's searchable text — a single shared budget across every toolCall
 * in the message, not per call, so N toolCalls can't multiply the bound and
 * make one message's contribution to the BM25 doc corpus unbounded.
 *
 * Head-only cap: content past this budget is not indexed via toolCall
 * arguments at all. This is an honest tradeoff, not a proxy for full
 * coverage — a Write/Edit tool result commonly only acknowledges success
 * (e.g. "wrote 400 lines"), so a fact buried past the cap in a giant
 * argument is not guaranteed to be searchable elsewhere either.
 */
const TOOL_ARGS_BUDGET = 2000;

/**
 * Tool name of the recall tool itself (src/tools/recall.ts). A search
 * operation must not match its own query or its own prior output: the
 * tuck_recall or tuck_search invocation is persisted as an ordinary assistant toolCall (its
 * `{ query }` argument, excluded below in `toolCallArgsText`) followed by an
 * ordinary toolResult message (its `N matches for "<query>"` text, excluded
 * in `fullText`) — without both exclusions a repeated query keeps matching
 * its own prior invocation/output and the hit count grows on every search.
 * This is a targeted introspection invariant for the two named history lookup tools, not a
 * general allowlist/blocklist over tool names or tool results.
 */


/** Text of every toolCall's arguments in a message's content, for search —
 *  bounded once, in aggregate, by TOOL_ARGS_BUDGET. Excludes the recall
 *  tool's own arguments (see isLookupTool). */
const toolCallArgsText = (content: Message["content"]): string => {
  if (!content || typeof content === "string") return "";
  const raw = content
    .filter((part) => part.type === "toolCall")
    .filter((part) => !isLookupTool(part.name ?? ""))
    .map((part) => extractToolCallArgsText(part.arguments))
    .filter(Boolean)
    .join("\n");
  return clip(raw, TOOL_ARGS_BUDGET);
};

/**
 * Build full searchable text for a message: text parts plus toolCall
 * arguments (bash command, Write/Edit content, etc.) so a match that only
 * exists in a tool call's arguments is still findable.
 *
 * The recall tool's own toolResult is excluded (searchable text ""): it
 * echoes back `N matches for "<query>"` from the *previous* recall call, so
 * indexing it would make a repeated query self-match and grow with every
 * search. This only affects search indexing — browse/no-query returns
 * entries before fullText runs (see `searchEntriesDetailed`), and #N expand reads
 * the message/entry directly, not through this function, so the toolResult
 * is still fully visible there.
 */
const fullText = (msg: Message): string => {
  if ((msg as any).role === "bashExecution") {
    return `${(msg as any).command ?? ""} ${(msg as any).output ?? ""}`;
  }
  if (msg.role === "toolResult" && isLookupTool(msg.toolName ?? "")) {
    return "";
  }
  const text = textOf(msg.content);
  const argsText = toolCallArgsText(msg.content);
  return argsText ? `${text}\n${argsText}` : text;
};

/**
 * Relative BM25 noise floor for MULTI-TERM natural-language queries only:
 * after sorting by score, drop hits scoring below this fraction of the top
 * score. Relative (not absolute) because BM25 magnitudes vary with corpus
 * size and document length, so a fixed score threshold would behave
 * inconsistently across short vs. long sessions.
 *
 * Applied only when the query has >=2 DISTINCT effective terms after
 * stopword filtering and case/duplicate normalization (see the
 * `effectiveTermCount >= 2` gate below `searchEntriesDetailed` uses before
 * calling `applyRelativeFloor`). Distinct, not raw count: "auth auth" or
 * "Auth AUTH" is semantically a single-term query and must bypass the floor
 * like any other single term — repeating or casing a word doesn't turn it
 * into the multi-term OR-tail noise this floor targets. The normalization is
 * gate-only; it doesn't change `terms` or the BM25 scoring itself, which
 * already matches case-insensitively. For a genuine single term, every hit's
 * occurrence already satisfies the whole query — its BM25 score differences
 * reflect term frequency and document length, not multi-term OR-tail noise,
 * so filtering by it there risks real matches for no corresponding noise
 * reduction. The inherited floor is retained unchanged; private-corpus
 * observations and their unavailable harness are not public quality evidence.
 *
 * The top-scoring hit always survives by construction: its own score
 * always satisfies `score >= topScore * floor`
 * for any floor <= 1, so a non-empty scored[] can never be filtered to zero.
 */
const BM25_RELATIVE_FLOOR = 0.2;

/**
 * Hard cap on total SEARCH results, applied after the relative floor so pagination stays bounded regardless
 * of how noisy or broad a query is.
 *
 * The inherited cap is retained unchanged. This is a resource bound, not
 * a claim about retrieval quality on an undistributed corpus.
 */
const SEARCH_RESULT_CAP = 50;

/**
 * Tuning overrides for `searchEntriesDetailed`; without them a search uses `BM25_RELATIVE_FLOOR` and
 * `SEARCH_RESULT_CAP`. `tuckRecall` passes a floor of 0 and a cap of every row, because it pages its own responses.
 */
export interface SearchTuning {
  relativeFloor?: number;
  cap?: number;
}

/** Drop scored hits below `floor` of the top score. The top hit's own score
 *  always passes (score >= score * floor for floor <= 1), so this can never
 *  turn a non-empty `scored` into an empty result. */
const applyRelativeFloor = (
  scored: Array<{ hit: SearchHit; score: number }>,
  floor: number,
): Array<{ hit: SearchHit; score: number }> => {
  if (scored.length === 0) return scored;
  const topScore = scored[0].score;
  if (topScore <= 0) return scored;
  return scored.filter((s) => s.score >= topScore * floor);
};

/**
 * Bound `hits` to `cap` entries, reporting the pre-cap count so callers can
 * signal truncation honestly instead of understating "total matches".
 *
 * Order preserved, never re-sorted: hits are already highest-score-first, so
 * `slice(0, cap)` keeps the top `cap` hits.
 */
const capHits = (hits: SearchHit[], cap: number): SearchResult => {
  const totalBeforeCap = hits.length;
  const capped = totalBeforeCap > cap ? hits.slice(0, cap) : hits;
  return { hits: capped, totalBeforeCap, truncated: capped.length < totalBeforeCap };
};

/** BM25 keyword search with truncation metadata. */
export const searchEntriesDetailed = (
  entries: RenderedEntry[],
  messages: Message[],
  query?: string,
  tuning?: SearchTuning,
): SearchResult => {
  if (!query?.trim()) return { hits: entries, totalBeforeCap: entries.length, truncated: false };

  const relativeFloor = tuning?.relativeFloor ?? BM25_RELATIVE_FLOOR;
  const cap = tuning?.cap ?? SEARCH_RESULT_CAP;
  const rawQuery = query.trim();
  const checkBudget = startBudget();

  // Natural language / multi-word query: BM25 scoring
  const prepared = prepareKeywordQuery(rawQuery);
  const terms = prepared.terms;

  // Build all docs for BM25 context
  const docs: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const msg = messages[i];
    const text = msg ? fullText(msg) : e.summary;
    const filePart = e.files?.join(" ") ?? "";
    docs.push(`${e.role} ${text} ${filePart}`);
  }

  const ctx = buildBM25Context(docs, terms, checkBudget);

  const scored: Array<{ hit: SearchHit; score: number }> = [];
  for (let i = 0; i < entries.length; i++) {
    checkBudget();
    const e = entries[i];
    const hay = docs[i];
    const mc = countMatches(hay, terms);
    if (mc === 0) continue;
    scored.push({ hit: { ...e, matchCount: mc }, score: bm25Score(hay, terms, ctx) });
  }

  // Sort by BM25 score desc, then drop the noisy long tail relative to the
  // top score (multi-term queries only — see BM25_RELATIVE_FLOOR), then
  // apply the hard cap.
  scored.sort((a, b) => b.score - a.score);
  // Gate on DISTINCT normalized terms, not raw term count: "auth auth" or
  // "Auth AUTH" is semantically a single-term query and must bypass the
  // floor like any other single term — repeating/casing a word doesn't turn
  // it into the multi-term OR-tail noise this floor targets. This is a
  // gate-only normalization; it does not change `terms` itself or the BM25
  // scoring above, which already matches case-insensitively.
  const effectiveTermCount = prepared.coverageTerms.length;
  const floored = effectiveTermCount >= 2 ? applyRelativeFloor(scored, relativeFloor) : scored;
  return capHits(floored.map((s) => s.hit), cap);
};
