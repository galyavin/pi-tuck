import type { NormalizedBlock } from "../types";
import { isSourceExport, isLookupTool, isRecallTool } from "./recall-operation";
import { isDialogue } from "./brief";

/** Suppress lookup call echoes. Every result stays available for counted omissions. */
export const filterNoise = (blocks: NormalizedBlock[]): NormalizedBlock[] => blocks.filter(b =>
  !(b.kind === "tool_call" && isLookupTool(b.name) && !(isRecallTool(b.name) && isSourceExport(b.args))) &&
  !(isDialogue(b) && !b.text.trim()));
