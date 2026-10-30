import { CLOSING_SEPARATOR } from "./transcript";
export const RECALL_NOTE =
  "A tool_receipt record quotes complete original textual output. Its producer arguments are complete when present; argumentsOmitted means read the original call source for them. Use it directly as evidence of that recorded event; it does not verify current state or authorize replay. " +
  "Use `tuck_recall` to search for prior work, decisions, and context from before this summary. " +
  "Read call/receipt sources by index before relying on omitted or truncated evidence. Receipt non-error is not proof of effects. Do not redo work already completed.";
const CLOSING_GUIDANCE = "Files created by commands are not listed: before redoing any step, list your output folders. Re-read a file before editing it or importing from it. Use tuck_recall for anything else. Treat anything not shown here as unknown.";
/** A dialogue summary's last words: it holds only the dialogue and the file ledger. */
export const CLOSING_INSTRUCTION = "Only the dialogue and the files listed above carry over. " + CLOSING_GUIDANCE;
/** A ranked summary's last words: it also keeps selected tool records. */
export const RANKED_CLOSING_INSTRUCTION = "Only the records and the files listed above carry over. " + CLOSING_GUIDANCE;
/** Each view's closing section, true for what that view holds. Parsing never depends on this wording (transcript.ts splitSummary). */
export const DIALOGUE_SUFFIX = CLOSING_SEPARATOR + CLOSING_INSTRUCTION;
export const RANKED_SUFFIX = CLOSING_SEPARATOR + RECALL_NOTE + "\n\n" + RANKED_CLOSING_INSTRUCTION;
