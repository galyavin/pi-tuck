import { CLOSING_SEPARATOR } from "./transcript";
/** A summary's last words: it holds only the dialogue (whole or shrunk) and the file ledger. */
export const CLOSING_INSTRUCTION = "Only the dialogue and the files listed above carry over. " +
  "Re-read a file before editing it or importing from it. Use tuck_recall for anything else. Treat anything not shown here as unknown.";
/** Parsing never depends on this wording (transcript.ts splitSummary). */
export const DIALOGUE_SUFFIX = CLOSING_SEPARATOR + CLOSING_INSTRUCTION;
