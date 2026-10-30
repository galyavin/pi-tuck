import { orderByOriginalSource } from "./source-order";
import type { CompilerMessage } from "../types";
import { normalize } from "./normalize";
import { filterNoise } from "./filter-noise";
import { compileBrief, planBrief, buildBriefRecords } from "./brief";
import { DIALOGUE_SUFFIX, RANKED_SUFFIX } from "./format";
import { parseRecords, serializeTranscript } from "./transcript";
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
  return transcript ? transcript + RANKED_SUFFIX : "";
};

/** The whole pre-cut dialogue: user, assistant and notice records; tool actions and observations are omitted.
 * This disposable view grants neither present authority nor native tool execution. */
export const compileDialogue = (input: RankedCompileInput): string => {
  const originals = filterNoise(normalize(input.messages, input.sourceIndices, input.receiptContext, input.sourceEntryIds, input.sourceTimes));
  const blocks = originals.filter(block => ["user", "assistant", "notice"].includes(block.kind));
  planBrief(blocks, new Set(blocks), originals, input.ranking?.mandatorySourceIndices);
  const records = buildBriefRecords(blocks);
  if (blocks.length < originals.length) records.push({ kind: "omission",
    reason: "Historical tool actions and observations omitted; read original sources with tuck_recall" });
  orderByOriginalSource(records, input.sourceIndices ?? input.messages.map((_, index) => index), input.sourceEntryIds);
  return records.length ? serializeTranscript(records) + DIALOGUE_SUFFIX : "";
};
