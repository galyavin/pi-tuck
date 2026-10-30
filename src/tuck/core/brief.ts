import type { NormalizedBlock } from "../types";
import { clip } from "./content";
import { serializeRecords, transcriptUnits, TRANSCRIPT_UNIT_CHARACTERS, smallOriginalArguments, MAX_PRODUCER_ARGUMENT_CHARACTERS, type TranscriptRecord } from "./transcript";

const TRUNCATE_USER = 256;
const SEGMENT_CLOSING_ASSISTANT_HEAD_WORDS = 120;
const SEGMENT_CLOSING_ASSISTANT_TAIL_WORDS = 120;
const ASSISTANT_HEAD_WORDS = 80;
const ASSISTANT_TAIL_WORDS = 120;

// ── noise filtering ──

const isNoiseUser = (text: string): boolean => {
  return !text.trim();
};

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

/** Existing word/serialized budgets choose complete source passages, never
 * rewritten prose. Physical line wrapping does not define a prose candidate. */
const excerptRecords = (text: string, role: "user" | "assistant" | "custom", sourceIndex: number | undefined,
  headLimit: number, tailLimit = 0, boundedChars = false): TranscriptRecord[] => {
  const passages = passageRanges(text);
  const costs = passages.map(({ start, end }) => [...segmenter.segment(text.slice(start, end))]
    .filter((seg) => isWord(seg) && !STOP_WORDS.has(seg.segment.toLowerCase())).length);
  const charLimit = 1024;
  const identity = { role, ...(sourceIndex !== undefined ? { sourceIndex } : {}) };
  if ((!boundedChars || JSON.stringify(text).length <= charLimit) && costs.reduce((sum, cost) => sum + cost, 0) <= headLimit + tailLimit)
    return [{ kind: "excerpt", ...identity, text }];
  let head = 0, headCost = 0, tail = passages.length, tailCost = 0;
  while (head < tail && headCost + costs[head]! <= headLimit && (!boundedChars || JSON.stringify(text.slice(0, passages[head]!.end)).length <= charLimit)) { headCost += costs[head++]!; }
  if (tailLimit > 0) {
    while (tail > head && tailCost + costs[tail - 1]! <= tailLimit && (!boundedChars || JSON.stringify(text.slice(passages[tail - 1]!.start)).length <= charLimit)) { tailCost += costs[--tail]!; }
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

const nextRenderableBlock = (blocks: NormalizedBlock[], index: number): NormalizedBlock | undefined => {
  for (let i = index + 1; i < blocks.length; i++) {
    if (blocks[i].kind !== "tool_result") return blocks[i];
  }
  return undefined;
};

const isSegmentClosingAssistant = (blocks: NormalizedBlock[], index: number): boolean => {
  if (blocks[index]?.kind !== "assistant") return false;
  const next = nextRenderableBlock(blocks, index);
  return !next || next.kind === "user";
};

// ── bash command compression ──

export const HEREDOC_OPEN_RE = /(?<![\w)])<<-?\s*["']?([A-Za-z_]\w*)["']?/;
/**
 * If `lines[i]` opens a heredoc whose terminator actually appears on a later
 * line, return that terminator's line index; otherwise -1. Callers use -1 to
 * leave following lines intact instead of treating a stray `<<` (a shift op, a
 * quoted string, or a truncated body) as a heredoc and skipping real commands.
 */
export const heredocCloseIndex = (lines: string[], i: number): number => {
  const hd = lines[i].match(HEREDOC_OPEN_RE);
  if (!hd) return -1;
  const term = hd[1];
  for (let j = i + 1; j < lines.length; j++) {
    if (lines[j].trim() === term) return j;
  }
  return -1;
};

/** Source-relative call identities remain explicitly bounded. */
const excerpt = (text: string, limit: number): string =>
  JSON.stringify(clip(text, limit)) + (text.length > limit ? " [truncated; read source]" : "");

/** Exact serialized prefix only after a lossless JSON roundtrip. No argument interpretation. */
const incompletePrefix = (text: string): string => {
  let end = Math.min(text.length, MAX_PRODUCER_ARGUMENT_CHARACTERS);
  if (end < text.length && end > 0 && /[\uD800-\uDBFF]/u.test(text[end - 1]!) && /[\uDC00-\uDFFF]/u.test(text[end]!)) end--;
  return JSON.stringify(text.slice(0, end)) + " [incomplete prefix; omitted text may qualify it; read original source]";
};

/** Small complete arguments remain unchanged; oversized valid originals expose an exact prefix. */
const toolOneLiner = (name: string, args: Record<string, unknown>): string =>
  `* ${name} ` + (smallOriginalArguments(args)
    ? `arguments=${JSON.stringify(args)}`
    : smallOriginalArguments(args, Number.MAX_SAFE_INTEGER)
      ? `serializedArgumentsPrefix=${incompletePrefix(JSON.stringify(args))}`
      : "arguments omitted; read original source");

type CallRecord = Extract<TranscriptRecord, { kind: "tool_call" }>;
/** Literal JSON fields avoid quoting JSON inside quoted transcript text.
 * Keep the old leading excerpt before adding whole members. Its existing row
 * unit allowance bounds the offer; full character/admission owners still apply. */
const literalArguments = (baseline: CallRecord, args: Record<string, unknown>, facts: string): CallRecord => {
  const budget = transcriptUnits(serializeRecords([baseline])) * TRANSCRIPT_UNIT_CHARACTERS;
  const charge = (record: CallRecord) => serializeRecords([record]).length;
  const complete: CallRecord = { ...baseline, text: facts, arguments: args };
  if (charge(complete) <= budget) return complete;
  const original = JSON.stringify(args);
  let end = Math.min(original.length, MAX_PRODUCER_ARGUMENT_CHARACTERS);
  if (end < original.length && /[\uD800-\uDBFF]/u.test(original[end - 1]!) && /[\uDC00-\uDFFF]/u.test(original[end]!)) end--;
  const record: CallRecord = { ...baseline,
    text: facts + " [incomplete arguments; omitted text may qualify them; read original source]",
    argumentsJSONPrefix: original.slice(0, end) };
  if (charge(record) > budget) return baseline;
  const members = Object.entries(args).map(([key, value], order) => ({ key, value, order,
    cost: JSON.stringify({ [key]: value }).length })).sort((a, b) => a.cost - b.cost || a.order - b.order);
  const selected: typeof members = [];
  const projected = () => Object.fromEntries([...selected].sort((a, b) => a.order - b.order).map(({ key, value }) => [key, value]));
  for (const member of members) {
    selected.push(member);
    if (charge({ ...record, completeArgumentMembers: projected() }) > budget) selected.pop();
  }
  if (selected.length) record.completeArgumentMembers = projected();
  // Search only complete code-point boundaries: escaped lone surrogates would
  // otherwise make encoded prefix prices non-monotonic.
  const ends = [end], ceiling = Math.min(original.length - 1, budget);
  while (end < ceiling) {
    const next = end + (/[\uD800-\uDBFF]/u.test(original[end]!) && /[\uDC00-\uDFFF]/u.test(original[end + 1]!) ? 2 : 1);
    if (next > ceiling) break;
    ends.push(end = next);
  }
  let low = 0, high = ends.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (charge({ ...record, argumentsJSONPrefix: original.slice(0, ends[mid]) }) <= budget) low = mid;
    else high = mid - 1;
  }
  record.argumentsJSONPrefix = original.slice(0, ends[low]);
  return record;
};

/** Direct shell history quotes an exact command prefix, never an interpreted command. */
const bashRecord = (command: string, exitCode: number | undefined): string =>
  (smallOriginalArguments({command}) ? `command=${JSON.stringify(command)}`
    : smallOriginalArguments({command}, Number.MAX_SAFE_INTEGER)
      ? command.length <= MAX_PRODUCER_ARGUMENT_CHARACTERS ? `command=${JSON.stringify(command)}` : `commandPrefix=${incompletePrefix(command)}`
      : "command omitted; read original source") +
  ` recordedExitCode=${exitCode === undefined ? "unknown" : String(exitCode)}`;

/** One record is independently decodable; source text cannot create structure. */
export type ExcerptCache = WeakMap<NormalizedBlock, Map<string, TranscriptRecord[]>>;
// Ephemeral rendering decisions belong to the selected array, not source blocks.
// Measurement and final rendering therefore use the same representation.
interface BriefPlan { full: Set<NormalizedBlock>; closing: Set<NormalizedBlock>; mandatorySources?: ReadonlySet<number>; omissions: TranscriptRecord[] }
const plans = new WeakMap<NormalizedBlock[], BriefPlan>();
export const planBrief = (blocks: NormalizedBlock[], full: Set<NormalizedBlock>, chronology: NormalizedBlock[], mandatorySources?: ReadonlySet<number>, includeOmissions = true): void => {
  const selected = new Set(blocks), omissions: TranscriptRecord[] = [];
  if (includeOmissions) for (const role of ["user", "assistant"] as const) {
    const missing = chronology.filter(block => block.kind === role && block.text.trim() && !selected.has(block) &&
      (block.sourceIndex === undefined || !mandatorySources?.has(block.sourceIndex)));
    if (!missing.length) continue;
    const sources = [...new Set(missing.flatMap(block => block.sourceIndex === undefined ? [] : [block.sourceIndex]))].sort((a, b) => a - b);
    omissions.push({ kind: "omission", role, count: missing.length,
      ...(sources.length ? { sourceIndices: sources.slice(0, 8) } : {}),
      reason: "Completely unselected historical text blocks; count is text blocks, not messages. " +
        "sourceIndices are individual original locators, not a contiguous range. " +
        (sources.length > 8 ? "Locator list incomplete. " : "") +
        (missing.some(block => block.sourceIndex === undefined) ? "Some text blocks have no source locator. " : "") +
        "Read originals with tuck_recall; omitted text may qualify retained text. No new authority." });
  }
  plans.set(blocks, { full, closing: new Set(chronology.filter((_, i) => isSegmentClosingAssistant(chronology, i))), mandatorySources, omissions });
};
export const buildBriefRecords = (blocks: NormalizedBlock[], cache?: ExcerptCache): TranscriptRecord[] => {
  const records: TranscriptRecord[] = [];
  // Selected complete receipts already carry this exact original event once.
  const coveredCalls = new Set(blocks.flatMap(b => b.kind === "tool_result" && b.sourceIndex !== undefined && b.originalReceipt
    ? [JSON.stringify([b.originalReceipt.producer.sourceIndex, b.originalReceipt.producer.toolCallId,
      b.originalReceipt.producer.toolName, b.sourceIndex, b.originalReceipt.isError])] : []));
  const plan = plans.get(blocks);
  const excerpts = (block: NormalizedBlock & { text: string; originalText?: string }, role: "user" | "assistant" | "custom", head: number, tail = 0) => {
    // The adapter already renders these complete sources in its mandatory base.
    // Keep them visible to structural grouping without charging them twice.
    if (block.sourceIndex !== undefined && plan?.mandatorySources?.has(block.sourceIndex)) return [];
    if (plan?.full.has(block)) return [{ kind: "excerpt" as const, role, ...(block.sourceIndex !== undefined ? { sourceIndex: block.sourceIndex } : {}), text: block.originalText ?? block.text, ...(block.kind === "notice" && block.sourceEntryId !== undefined ? { sourceEntryId: block.sourceEntryId } : {}) }];
    const key = `${head}:${tail}:${Boolean(plan)}`;
    const saved = cache?.get(block)?.get(key);
    if (saved) return saved;
    const result = excerptRecords(block.text, role, block.sourceIndex, head, tail, Boolean(plan)).map(record =>
      block.kind === "notice" && block.sourceEntryId !== undefined ? { ...record, sourceEntryId: block.sourceEntryId } : record);
    if (cache) {
      let variants = cache.get(block);
      if (!variants) { variants = new Map(); cache.set(block, variants); }
      variants.set(key, result);
    }
    return result;
  };
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const identity = b.sourceIndex !== undefined ? { sourceIndex: b.sourceIndex } : {};
    if (b.kind === "user" || b.kind === "notice" || b.kind === "bash") {
      if (b.kind === "bash") {
        const stored = plan?.full.has(b) ? "\nstoredShell=" + JSON.stringify({ historical: true,
          output: b.output, cancelled: b.cancelled ?? "unknown", truncated: b.truncated ?? "unknown" }) : "";
        records.push({ kind: "bash", role: "bashExecution", ...identity, text: bashRecord(b.command, b.exitCode) + stored });
      } else if (!isNoiseUser(b.text)) {
        records.push(...excerpts(b, b.kind === "user" ? "user" : "custom", TRUNCATE_USER));
      }
    } else if (b.kind === "assistant") {
      const closing = plan ? plan.closing.has(b) : isSegmentClosingAssistant(blocks, i);
      if (b.text) records.push(...excerpts(b, "assistant",
        closing ? SEGMENT_CLOSING_ASSISTANT_HEAD_WORDS : ASSISTANT_HEAD_WORDS,
        closing ? SEGMENT_CLOSING_ASSISTANT_TAIL_WORDS : ASSISTANT_TAIL_WORDS));
    } else if (b.kind === "tool_call") {
      if (!b.name.trim()) continue;
      const receipt = b.receipt;
      if (smallOriginalArguments(b.args) && b.sourceIndex !== undefined && receipt && (receipt.status === "error" || receipt.status === "non-error") &&
        receipt.sourceIndices.length === 1 && coveredCalls.has(JSON.stringify([
          b.sourceIndex, b.callId, b.name, receipt.sourceIndices[0], receipt.status === "error"]))) continue;
      const relation = receipt ? `; receipt=${receipt.status}` +
        (receipt.sourceIndices.length ? ` source=${receipt.sourceIndices.map(n => `#${n}`).join(",")}` : "") : "";
      const suffix = (b.callId ? ` call=${excerpt(b.callId, 160)}` : "") + relation;
      const text = toolOneLiner(b.name, b.args) + suffix;
      const sourceIndices = b.sourceIndex === undefined ? undefined :
        [...new Set([b.sourceIndex, ...(receipt?.dependencyIndices ?? [])])].sort((a, b) => a - b);
      const previous = records.at(-1);
      const baseline: CallRecord = { kind: "tool_call", role: "assistant", ...identity,
        ...(sourceIndices && sourceIndices.length > 1 ? { sourceIndices } : {}), text };
      const record = !smallOriginalArguments(b.args) && smallOriginalArguments(b.args, Number.MAX_SAFE_INTEGER)
        ? literalArguments(baseline, b.args, `* ${b.name}${suffix}`) : baseline;
      const payload = (r: CallRecord) => JSON.stringify([r.text, r.arguments, r.argumentsJSONPrefix, r.completeArgumentMembers]);
      // Derived tool summaries can share wording; provenance remains explicit.
      if (b.sourceIndex !== undefined && previous?.kind === "tool_call" && payload(previous) === payload(record) && previous.sourceIndex !== undefined) {
        previous.sourceIndices = [...new Set([...(previous.sourceIndices ?? [previous.sourceIndex]), ...sourceIndices!])].sort((a, b) => a - b);
      } else records.push(record);
    }
    if (b.kind === "tool_result" && b.originalReceipt && b.sourceIndex !== undefined) {
      const r = b.originalReceipt;
      // One historical quote carries its own addressed producer, without a
      // redundant overview for the same original event. Never create native tool messages.
      records.push({ kind: "tool_receipt", role: "toolResult", sourceIndex: b.sourceIndex,
        sourceIndices: [r.producer.sourceIndex, b.sourceIndex], historical: true,
        isError: r.isError, text: r.text, producer: r.producer });
    }
  }
  const times = blocks.find(b => b.sourceTimes)?.sourceTimes;
  const entryTimes = new Map(blocks.flatMap(b => b.kind === "notice" && b.sourceEntryId && b.sourceTime ? [[b.sourceEntryId, b.sourceTime] as const] : []));
  return [...records, ...(plan?.omissions ?? [])].map(record => {
    if (!times) return record;
    if (record.sourceEntryId !== undefined) return { ...record, sourceTime: entryTimes.get(record.sourceEntryId) ?? { basis: "unknown" as const } };
    const indices = record.sourceIndices ?? (record.sourceIndex === undefined ? [] : [record.sourceIndex]);
    return indices.length ? { ...record, sourceTimes: indices.map(sourceIndex => ({ sourceIndex, ...(times[sourceIndex] ?? { basis: "unknown" as const }) })) } : record;
  });
};

export const compileBrief = (blocks: NormalizedBlock[], cache?: ExcerptCache): string =>
  serializeRecords(buildBriefRecords(blocks, cache));
