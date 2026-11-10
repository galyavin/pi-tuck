import { CLOSING_SEPARATOR } from "./transcript";
/** A summary's last words: it holds only the dialogue (whole or shrunk) and the file ledger. */
export const CLOSING_INSTRUCTION = "Only the dialogue, actions and files above carry over; the rest is still in the history. " +
  "Before redoing a step or deciding from memory, look it up: tuck_search by meaning (if offered), tuck_recall by #N or keyword. Files made by commands are not listed. Re-read a file before editing or importing it.";
/** Parsing never depends on this wording (transcript.ts splitSummary). */
export const DIALOGUE_SUFFIX = CLOSING_SEPARATOR + CLOSING_INSTRUCTION;
