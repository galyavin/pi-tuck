import type { CompilerMessage } from "../types";
import { normalize } from "./normalize";
import { filterNoise } from "./filter-noise";
import { shrinkDialogue, wholeDialogue, type DialogueInput } from "./shrink";

export interface CompileInput {
  messages: CompilerMessage[];
  /** Eligible original branch only: receipt identity and order. */
  receiptContext?: { messages: CompilerMessage[]; sourceIndices: Array<number | undefined> };
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

const dialogueInput = (input: CompileInput): DialogueInput => ({
  blocks: filterNoise(normalize(input.messages, input.sourceIndices, input.receiptContext, input.sourceEntryIds, input.sourceTimes)),
  mandatorySourceIndices: input.ranking?.mandatorySourceIndices,
  sourceIndices: input.sourceIndices ?? input.messages.map((_, index) => index),
  sourceEntryIds: input.sourceEntryIds,
});

/** The whole pre-cut dialogue: user, assistant and notice records; tool actions and observations are omitted.
 * This disposable view grants neither present authority nor native tool execution. */
export const compileDialogue = (input: CompileInput): string => wholeDialogue(dialogueInput(input));

/** The dialogue shrunk to `ranking.maxBriefChars`, oldest assistant text first (see `shrinkDialogue`); "" when nothing fits. */
export const compileShrunkDialogue = (input: CompileInput & { ranking: { maxBriefChars: number } }): string =>
  shrinkDialogue(dialogueInput(input), input.ranking.maxBriefChars).text;
