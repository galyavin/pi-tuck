import type { CompilerMessage } from "../types";
import { normalize } from "./normalize";
import { filterNoise } from "./filter-noise";
import { shrinkDialogue, wholeDialogue, omittedDialogue, type DialogueInput } from "./shrink";

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

// A cut offers the whole dialogue and then, when it does not fit, the shrunk one, from the same input: normalize it once. The blocks are
// never mutated, and keeping the same objects also keeps their cached passage analyses.
const inputs = new WeakMap<CompileInput, DialogueInput>();
const normalized = new WeakMap<NonNullable<CompileInput["sourceIndices"]>, {
  messages: CompileInput["messages"]; sourceTimes: CompileInput["sourceTimes"]; sourceEntryIds: CompileInput["sourceEntryIds"];
  receiptContext: CompileInput["receiptContext"]; blocks: DialogueInput["blocks"];
}>();
const dialogueInput = (input: CompileInput): DialogueInput => {
  let prepared = inputs.get(input);
  if (!prepared) {
    const cached = input.sourceIndices && normalized.get(input.sourceIndices);
    const blocks = cached?.messages === input.messages && cached.sourceTimes === input.sourceTimes &&
      cached.sourceEntryIds === input.sourceEntryIds && cached.receiptContext === input.receiptContext ? cached.blocks :
      normalize(input.messages, input.sourceIndices, input.receiptContext, input.sourceEntryIds, input.sourceTimes).filter(block =>
        block.kind === "tool_result" || filterNoise([block]).length > 0);
    if (input.sourceIndices) normalized.set(input.sourceIndices, { messages: input.messages, sourceTimes: input.sourceTimes, sourceEntryIds: input.sourceEntryIds, receiptContext: input.receiptContext, blocks });
    inputs.set(input, prepared = { blocks, mandatorySourceIndices: input.ranking?.mandatorySourceIndices,
      sourceIndices: input.sourceIndices ?? input.messages.map((_, index) => index), sourceEntryIds: input.sourceEntryIds });
  }
  return prepared;
};

/** The whole pre-cut dialogue: user, assistant and notice records; tool actions and observations are omitted.
 * This disposable view grants neither present authority nor native tool execution. */
export const compileDialogue = (input: CompileInput): string => wholeDialogue(dialogueInput(input));

/** The lower ranks within `ranking.maxBriefChars`; "" when the counted omission floor cannot fit. */
export const compileShrunkDialogue = (input: CompileInput & { ranking: { maxBriefChars: number } }): string =>
  shrinkDialogue(dialogueInput(input), input.ranking.maxBriefChars).text;

export const compileOmissions = (input: CompileInput): string => omittedDialogue(dialogueInput(input));
