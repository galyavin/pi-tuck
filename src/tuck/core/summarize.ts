import type { CompilerMessage } from "../types";
import { normalize } from "./normalize";
import { filterNoise } from "./filter-noise";
import { shrinkDialogue, type DialogueInput } from "./shrink";

export interface CompileInput {
  messages: CompilerMessage[];
  /** Native session-global source indices parallel to messages. */
  sourceIndices?: Array<number | undefined>;
  /** Actual native entry IDs parallel to originals, not inferred from text. */
  sourceEntryIds?: readonly string[];
  sourceTimes?: readonly import("./source-time").SourceTime[];
  ranking?: {
    /** The complete serialized length a summary of the dialogue may have, header and closing section included. */
    maxBriefChars?: number;
    /** Full sources rendered separately by the caller: they render as nothing here. */
    mandatorySourceIndices?: ReadonlySet<number>;
  };
}

/** Compile the lower ranks once under their remaining serialized amount.
 * `step` describes the result for diagnostics; it does not select another plan. */
export const compileDialogue = (input: CompileInput) => shrinkDialogue({
  blocks: filterNoise(normalize(input.messages, input.sourceIndices, input.sourceEntryIds, input.sourceTimes)),
  mandatorySourceIndices: input.ranking?.mandatorySourceIndices,
  sourceIndices: input.sourceIndices ?? input.messages.map((_, index) => index),
  sourceEntryIds: input.sourceEntryIds,
} satisfies DialogueInput, input.ranking?.maxBriefChars ?? Infinity);
