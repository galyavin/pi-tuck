import type { NormalizedBlock } from "../types";
import { isSourceExport, isLookupTool, isRecallTool } from "./recall-operation";

/** Suppress lookup echoes, retaining recorded export attempts and exactly paired outcomes. */
export const filterNoise = (blocks: NormalizedBlock[]): NormalizedBlock[] => blocks.filter(b =>
  !(b.kind === "tool_call" && isLookupTool(b.name) && !(isRecallTool(b.name) && isSourceExport(b.args))) &&
  !(b.kind === "tool_result" && isLookupTool(b.name) &&
    !(isRecallTool(b.name) && b.recallExport)) &&
  !((b.kind === "user" || b.kind === "assistant" || b.kind === "notice") && !b.text.trim()));
