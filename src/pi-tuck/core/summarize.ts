import { orderByOriginalSource } from "./source-order";
import type { CompilerMessage, NormalizedBlock } from "../types";
import { normalize } from "./normalize";
import { filterNoise } from "./filter-noise";
import { compileBrief, planBrief, buildBriefRecords } from "./brief";
import { SUMMARY_SUFFIX } from "./format";
import { parseRecords, serializeTranscript, MAX_RECEIPT_CHARACTERS } from "./transcript";
import { selectRankedBriefBlocks, type BriefRankingOptions } from "./rank";

export interface RankedCompileInput {
  messages: CompilerMessage[];
  /** Eligible original branch only; receipt identity/order, not extra ranked content. */
  receiptContext?: { messages: CompilerMessage[]; sourceIndices: Array<number | undefined> };
  /** Native session-global source indices parallel to messages. */
  sourceIndices?: Array<number | undefined>;
  /** Actual native entry IDs parallel to originals, not inferred from text. */
  sourceEntryIds?: readonly string[];
  sourceTimes?: readonly import("./source-time").SourceTime[];
  ranking?: BriefRankingOptions;
}

/** Select eligible originals once. No inferred state or prior-view merging. */
export const compileRanked = (input: RankedCompileInput): string => {
  const blocks = filterNoise(normalize(input.messages, input.sourceIndices, input.receiptContext, input.sourceEntryIds, input.sourceTimes));
  const selected = selectRankedBriefBlocks(blocks, input.ranking);
  const transcript = serializeTranscript(parseRecords(compileBrief(selected)));
  return transcript ? transcript + SUMMARY_SUFFIX : "";
};

/** Exact local prices only when masking cannot couple producer suppression or call deduplication. */
const independentSavings = (originals: NormalizedBlock[], bodies: NormalizedBlock[]): number[] | undefined => {
  const calls = new Map<string, NormalizedBlock>(), texts = new Set<string>(), carriers = new Set<string>();
  const key = (producer: number | undefined, id: string | undefined, name: string, receipt: number, error: boolean) =>
    JSON.stringify([producer, id, name, receipt, error]);
  for (const block of originals) if (block.kind === "tool_call") {
    const overview = buildBriefRecords([block])[0];
    if (overview?.kind === "tool_call") {
      if (texts.has(overview.text)) return undefined;
      texts.add(overview.text);
    }
    const receipt = block.receipt;
    if (block.sourceIndex !== undefined && receipt && (receipt.status === "error" || receipt.status === "non-error") && receipt.sourceIndices.length === 1) {
      const identity = key(block.sourceIndex, block.callId, block.name, receipt.sourceIndices[0], receipt.status === "error");
      if (calls.has(identity)) return undefined;
      calls.set(identity, block);
    }
  }
  for (const body of bodies) if (body.kind === "tool_result" && body.originalReceipt && body.sourceIndex !== undefined) {
    const r = body.originalReceipt;
    const identity = key(r.producer.sourceIndex, r.producer.toolCallId, r.producer.toolName, body.sourceIndex, r.isError);
    if (carriers.has(identity)) return undefined;
    carriers.add(identity);
  }
  const charge = (blocks: NormalizedBlock[], full: boolean) => {
    planBrief(blocks, new Set(full ? blocks.filter(b => b.kind === "bash") : []), blocks);
    const records = buildBriefRecords(blocks);
    for (const block of blocks) if (block.kind === "tool_result" && !block.originalReceipt)
      records.push({ kind: "omission", role: "toolResult", sourceIndex: block.sourceIndex,
        ...(block.sourceTime && block.sourceIndex !== undefined ? { sourceTimes: [{ sourceIndex: block.sourceIndex, ...block.sourceTime }] } : {}),
        reason: "Historical observation body omitted; read original source" });
    return records.reduce((sum, record) => sum + JSON.stringify(record).length + 1, 0);
  };
  return bodies.map(body => {
    let producer: NormalizedBlock | undefined;
    if (body.kind === "tool_result" && body.originalReceipt && body.sourceIndex !== undefined) {
      const r = body.originalReceipt;
      producer = calls.get(key(r.producer.sourceIndex, r.producer.toolCallId, r.producer.toolName, body.sourceIndex, r.isError));
    }
    const full = producer ? [producer, body] : [body];
    const masked = full.map(block => block === body && block.kind === "tool_result" ? { ...block, originalReceipt: undefined } : block);
    return charge(full, true) - charge(masked, false);
  });
};

/** Whole original dialogue first; only already bounded historical evidence bodies.
 * This disposable view grants neither present authority nor native tool execution. */
export const compileResidual = (input: RankedCompileInput, includeObservationBodies = true, maxCharacters?: number, dialogueOnly = false): string => {
  if (maxCharacters !== undefined && (!Number.isSafeInteger(maxCharacters) || maxCharacters < 0))
    throw new Error("Invalid residual offer ceiling");
  const originals = filterNoise(normalize(input.messages, input.sourceIndices, input.receiptContext, input.sourceEntryIds, input.sourceTimes));
  // A complete-dialogue offer must not fail solely on bulky old action records.
  // Native admission owns capacity; this never changes fresh/native sources.
  if (dialogueOnly) {
    const blocks = originals.filter(block => ["user", "assistant", "notice"].includes(block.kind));
    planBrief(blocks, new Set(blocks), originals, input.ranking?.mandatorySourceIndices);
    const records = buildBriefRecords(blocks);
    if (blocks.length < originals.length) records.push({ kind: "omission",
      reason: "Historical tool actions and observations omitted; read original sources with pi_tuck_recall" });
    orderByOriginalSource(records, input.sourceIndices ?? input.messages.map((_, index) => index), input.sourceEntryIds);
    return records.length ? serializeTranscript(records) + SUMMARY_SUFFIX : "";
  }
  const bodies = originals.filter(block => block.kind === "tool_result" && block.originalReceipt ||
    block.kind === "bash" && block.sourceIndex !== undefined && block.output.length <= MAX_RECEIPT_CHARACTERS);
  const omitted = new Set(includeObservationBodies ? [] : bodies);
  const render = () => {
    const blocks = originals.map(block => omitted.has(block) && block.kind === "tool_result" ? { ...block, originalReceipt: undefined } : block);
    planBrief(blocks, new Set(blocks.filter(block =>
      ["user", "assistant", "notice"].includes(block.kind) || block.kind === "bash" && bodies.includes(block) && !omitted.has(block))),
      blocks, input.ranking?.mandatorySourceIndices);
    const records = buildBriefRecords(blocks);
    for (const block of blocks) if (block.kind === "tool_result" && !block.originalReceipt)
      records.push({ kind: "omission", role: "toolResult", sourceIndex: block.sourceIndex,
        ...(block.sourceTime && block.sourceIndex !== undefined ? { sourceTimes: [{ sourceIndex: block.sourceIndex, ...block.sourceTime }] } : {}),
        reason: "Historical observation body omitted; read original source" });
    // Only already-partial historical display payloads change. Exact originals,
    // complete members and mandatory native sources retain their existing owner.
    for (const record of records) if (record.kind === "tool_call" &&
      !(record.sourceIndex !== undefined && input.ranking?.mandatorySourceIndices?.has(record.sourceIndex)) &&
      record.argumentsJSONPrefix !== undefined && record.argumentsJSONPrefix.length > 256) {
      const prefix = record.argumentsJSONPrefix;
      let end = 256;
      if (/[\uD800-\uDBFF]/u.test(prefix[end - 1]) && /[\uDC00-\uDFFF]/u.test(prefix[end])) end--;
      record.argumentsJSONPrefix = prefix.slice(0, end);
    }
    orderByOriginalSource(records, input.sourceIndices ?? input.messages.map((_, index) => index), input.sourceEntryIds);
    return records.length ? serializeTranscript(records) + SUMMARY_SUFFIX : "";
  };
  let summary = render();
  if (!includeObservationBodies) {
    const prices = independentSavings(originals, bodies);
    if (prices) {
      let predicted = summary.length;
      bodies.forEach((body, i) => { if (prices[i] <= 0) { omitted.delete(body); predicted += prices[i]; } });
      const candidate = render();
      if (candidate.length === predicted && candidate.length <= summary.length) return candidate;
      for (const body of bodies) omitted.add(body);
    }
    // Coupled records pay their actual complete-view cost; additions terminate.
    let restored: boolean;
    do {
      restored = false;
      for (const body of bodies) if (omitted.delete(body)) {
        const candidate = render();
        if (candidate.length <= summary.length) { summary = candidate; restored = true; }
        else omitted.add(body);
      }
    } while (restored);
    return summary;
  }
  if (maxCharacters === undefined || summary.length <= maxCharacters) return summary;
  const prices = independentSavings(originals, bodies);
  if (prices) {
    const removals = bodies.map((body, order) => ({ body, order, saving: prices[order] }))
      .filter(item => item.saving > 0).sort((a, b) => b.saving - a.saving || a.order - b.order);
    let predicted = summary.length;
    for (const { body, saving } of removals) {
      omitted.add(body); predicted -= saving;
      if (predicted <= maxCharacters) break;
    }
    const candidate = render();
    if (candidate.length === predicted) return candidate;
    // Unexpected serialization coupling retains the exact existing allocator.
    omitted.clear();
  }
  // Fixed largest-saving order; charge the complete view, including replacement
  // producer envelopes. Never trade a cheap exact body for a larger placeholder.
  const removals = bodies.map((body, order) => {
    omitted.add(body); const saving = summary.length - render().length; omitted.delete(body);
    return { body, order, saving };
  }).filter(item => item.saving > 0).sort((a, b) => b.saving - a.saving || a.order - b.order);
  for (const { body } of removals) {
    omitted.add(body); const next = render();
    if (next.length < summary.length) summary = next; else omitted.delete(body);
    if (summary.length <= maxCharacters) break;
  }
  // Whole dialogue may itself exceed this offer ceiling. Admission owns that
  // decision; do not silently truncate dialogue or manufacture fitting evidence.
  return summary;
};
