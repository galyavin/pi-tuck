import type { NormalizedBlock } from "../types";
import type { TranscriptRecord } from "./transcript";

// ── truncation ──

// Unicode-aware word segmentation via Intl.Segmenter (built-in, zero dependency)
const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });

/** Check if segment is a word (Bun's isWordLike is unreliable for alphanumeric tokens) */
const isWord = (seg: { segment: string; isWordLike?: boolean }): boolean =>
  seg.isWordLike === true || /[\p{L}\p{N}]/u.test(seg.segment);

// Common stop words — don't count toward budget
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "must",
  "to", "of", "in", "for", "on", "with", "at", "by", "from", "as",
  "into", "through", "during", "before", "after", "above", "below",
  "between", "under", "over",
  "and", "but", "or", "nor", "not", "so", "yet", "both", "either",
  "neither", "each", "every", "all", "any", "few", "more", "most",
  "other", "some", "such", "no",
  "that", "this", "these", "those", "it", "its",
  "i", "me", "my", "we", "our", "you", "your", "he", "him", "his",
  "she", "her", "they", "them", "their", "who", "which", "what",
  "if", "then", "than", "when", "where", "how", "just", "also",
]);

/** Sentence boundaries are mechanical candidates, not claims of complete meaning.
 * Preserve exact sanitized-block offsets. Known structured regions are atomic;
 * no clipping can turn a partial command/object into an apparent whole one. */
const sentenceSegmenter = new Intl.Segmenter("en", { granularity: "sentence" });
const passageRanges = (text: string): { start: number; end: number }[] => {
  const ranges: { start: number; end: number }[] = [];
  const prose = (start: number, end: number) => {
    if (start === end) return;
    const chunk = text.slice(start, end);
    // An unfenced object/array may contain blank lines. Without a parser that
    // can prove its end, conservatively keep this entire region as one atom.
    if (/(?:^|\n)[ \t]*[\[{]/u.test(chunk)) { ranges.push({ start, end }); return; }
    let cursor = start;
    const paragraph = (stop: number) => {
      const body = text.slice(cursor, stop);
      if (/(?:^|\n)(?: {4}|\t| {0,3}\|.*\|[ \t]*(?:\n|$)|(?:const|let|var|def|class|function|import|export)\s)|`/u.test(body))
        ranges.push({ start: cursor, end: stop });
      else for (const part of sentenceSegmenter.segment(body))
        ranges.push({ start: cursor + part.index, end: cursor + part.index + part.segment.length });
      cursor = stop;
    };
    for (const gap of chunk.matchAll(/\n[ \t]*\n+/gu)) paragraph(start + gap.index! + gap[0].length);
    paragraph(end);
  };
  let cursor = 0, open: { start: number; marker: string } | undefined;
  let indented: number | undefined;
  // Markdown indented code keeps blank lines inside the same region. Discover
  // that region before prose paragraph segmentation can divide it.
  for (const row of text.matchAll(/[^\n]*(?:\n|$)/gu)) {
    if (!row[0]) continue;
    const start = row.index!, end = start + row[0].length;
    const fence = row[0].match(/^ {0,3}(`{3,}|~{3,})/u);
    if (open) {
      if (fence && fence[1]![0] === open.marker[0] && fence[1]!.length >= open.marker.length &&
        row[0].slice(fence[0].length).trim() === "") {
        ranges.push({ start: open.start, end }); cursor = end; open = undefined;
      }
      continue;
    }
    const code = /^(?: {4}|\t)/u.test(row[0]);
    if (indented !== undefined) {
      if (code || !row[0].trim()) continue;
      ranges.push({ start: indented, end: start }); cursor = start; indented = undefined;
    }
    if (fence) { prose(cursor, start); open = { start, marker: fence[1]! }; }
    else if (code) {
      // A syntactic header and its indented body are one known code region.
      if (/(?:^|\n)(?:def|class|function)\s/u.test(text.slice(cursor, start))) indented = cursor;
      else { prose(cursor, start); indented = start; }
    }
  }
  if (open) ranges.push({ start: open.start, end: text.length });
  else if (indented !== undefined) ranges.push({ start: indented, end: text.length });
  else prose(cursor, text.length);
  return ranges;
};

/** The passages of a text and the words each costs. Segmenting is most of the work of a clip, so a block is analyzed once for every clip. */
interface Analysis { passages: { start: number; end: number }[]; costs: number[] }
const analyze = (text: string): Analysis => {
  const passages = passageRanges(text);
  return { passages, costs: passages.map(({ start, end }) => [...segmenter.segment(text.slice(start, end))]
    .filter((seg) => isWord(seg) && !STOP_WORDS.has(seg.segment.toLowerCase())).length) };
};

/** Existing word/serialized budgets choose complete source passages, never
 * rewritten prose. Physical line wrapping does not define a prose candidate. */
const excerptRecords = (text: string, { passages, costs }: Analysis, role: "user" | "assistant" | "custom", sourceIndex: number | undefined,
  headLimit: number, tailLimit: number): TranscriptRecord[] => {
  const charLimit = 1024;
  const identity = { role, ...(sourceIndex !== undefined ? { sourceIndex } : {}) };
  if (text.length <= charLimit && JSON.stringify(text).length <= charLimit && costs.reduce((sum, cost) => sum + cost, 0) <= headLimit + tailLimit)
    return [{ kind: "excerpt", ...identity, text }];
  let head = 0, headCost = 0, tail = passages.length, tailCost = 0;
  while (head < tail && headCost + costs[head]! <= headLimit && JSON.stringify(text.slice(0, passages[head]!.end)).length <= charLimit) { headCost += costs[head++]!; }
  if (tailLimit > 0) {
    while (tail > head && tailCost + costs[tail - 1]! <= tailLimit && JSON.stringify(text.slice(passages[tail - 1]!.start)).length <= charLimit) { tailCost += costs[--tail]!; }
  }
  const headEnd = head ? passages[head - 1]!.end : 0;
  const tailStart = tail < passages.length ? passages[tail]!.start : text.length;
  const span = (start: number, end: number) => ({ coordinateSpace: "sanitized-block" as const, start, end, totalCharacters: text.length });
  const records: TranscriptRecord[] = [];
  if (headEnd) records.push({ kind: "excerpt", ...identity, text: text.slice(0, headEnd), span: span(0, headEnd) });
  records.push({ kind: "omission", ...identity, reason: "source truncated; read source; omitted text may qualify retained quotations", span: span(headEnd, tailStart) });
  if (tailStart < text.length) records.push({ kind: "excerpt", ...identity, text: text.slice(tailStart), span: span(tailStart, text.length) });
  return records;
};

/** The user, assistant and notice blocks of a dialogue; tool blocks are never rendered. */
export type DialogueBlock = Extract<NormalizedBlock, { kind: "user" | "assistant" | "notice" }>;
export const isDialogue = (block: NormalizedBlock): block is DialogueBlock => block.kind === "user" || block.kind === "assistant" || block.kind === "notice";

/** A user or assistant text block the omission notices count when it is unselected: non-empty, and not rendered in the mandatory base. */
export const isOmittable = (block: NormalizedBlock, mandatorySources?: ReadonlySet<number>): boolean =>
  (block.kind === "user" || block.kind === "assistant") && Boolean(block.text.trim()) &&
  (block.sourceIndex === undefined || !mandatorySources?.has(block.sourceIndex));

/** `sources` are the distinct locators of the omitted blocks in ascending order; at most the first 9 decide the notice. */
export const omissionRecord = (role: "user" | "assistant", count: number, sources: number[], unlocated: boolean): TranscriptRecord => ({
  kind: "omission", role, count,
  ...(sources.length ? { sourceIndices: sources.slice(0, 8) } : {}),
  reason: "Completely unselected historical text blocks; count is text blocks, not messages. " +
    "sourceIndices are individual original locators, not a contiguous range. " +
    (sources.length > 8 ? "Locator list incomplete. " : "") +
    (unlocated ? "Some text blocks have no source locator. " : "") +
    "Read originals with tuck_recall; omitted text may qualify retained text. No new authority." });

const analyses = new WeakMap<DialogueBlock, Analysis>();

/** The word budgets of a clipped excerpt: the passages kept from the start of the text, and from its end. */
export type Clip = readonly [headWords: number, tailWords: number];

/** The records of one dialogue block alone, before source times are attached: its whole original text, or, with a `clip`, the excerpts
 * that keep their sanitized-block spans around an omission. A mandatory source renders nothing: the adapter quotes it in its base. */
export const blockRecords = (b: DialogueBlock, mandatory: ReadonlySet<number> | undefined, clip?: Clip): TranscriptRecord[] => {
  if (!b.text.trim() || b.sourceIndex !== undefined && mandatory?.has(b.sourceIndex)) return [];
  const role = b.kind === "notice" ? "custom" : b.kind;
  const notice = b.kind === "notice" && b.sourceEntryId !== undefined ? { sourceEntryId: b.sourceEntryId } : {};
  if (!clip) return [{ kind: "excerpt", role, ...(b.sourceIndex !== undefined ? { sourceIndex: b.sourceIndex } : {}), text: b.originalText ?? b.text, ...notice }];
  let analysis = analyses.get(b);
  if (!analysis) analyses.set(b, analysis = analyze(b.text));
  return excerptRecords(b.text, analysis, role, b.sourceIndex, clip[0], clip[1]).map(record => ({ ...record, ...notice }));
};

/** A source time for each locator a user record names; only briefs of times-carrying blocks have them. */
export const decorateRecord = (record: TranscriptRecord, times: NormalizedBlock["sourceTimes"]): TranscriptRecord => {
  // Times mark the user's turns only: on every record they cost a fifth to a third of the summary's tokens.
  if (!times || record.role !== "user") return record;
  const indices = record.sourceIndices ?? (record.sourceIndex === undefined ? [] : [record.sourceIndex]);
  return indices.length ? { ...record, sourceTimes: indices.map(sourceIndex => ({ sourceIndex, ...(times[sourceIndex] ?? { basis: "unknown" as const }) })) } : record;
};
