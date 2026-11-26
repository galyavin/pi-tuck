import { CLOSING_SEPARATOR } from "./transcript";
/** A summary's last words: it holds only the dialogue (whole or shrunk) and the file ledger. */
export const CLOSING_INSTRUCTION = "Only the dialogue and the actions and files listed above carry over. " +
  "Files created by commands are not listed: Before re-running a command listed above, read its output with tuck_recall instead. Re-read a file before editing it or importing from it. Use tuck_recall for anything else. Treat anything not shown here as unknown.";
/** Parsing never depends on this wording (transcript.ts splitSummary). */
export const DIALOGUE_SUFFIX = CLOSING_SEPARATOR + CLOSING_INSTRUCTION;
const REREAD = "Re-read a file before editing it or importing from it.";
/** The closing words when working files follow: the re-read rule stays for every other file. */
export const WORKING_FILES_INSTRUCTION = CLOSING_INSTRUCTION.replace(REREAD,
  "Re-read a file before editing it or importing from it, unless it is one of the working files below.");
/** Opens the working files, after the closing words. Each file follows as one raw block (real line breaks, so its text can be quoted
 * exactly in an edit). The closing section is kept byte for byte by every parser (transcript.ts splitSummary), so raw text is safe there. */
export const WORKING_FILES_HEADER = "\n\nWorking files: each is the whole file, identical to the file on disk when this summary was made. Edit from these copies.";
export const workingFileBlock = (file: { path: string; text: string }): string => `\n<file path=${JSON.stringify(file.path)}>\n${file.text}\n</file>`;
/** The closing section: the dialogue suffix alone, or, with working files, its working-files form followed by each file. */
export const closingSuffix = (files: readonly { path: string; text: string }[]): string => files.length
  ? CLOSING_SEPARATOR + WORKING_FILES_INSTRUCTION + WORKING_FILES_HEADER + files.map(workingFileBlock).join("") : DIALOGUE_SUFFIX;
