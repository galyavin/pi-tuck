/** Recorded export attempt, not proof of a successful write or current file truth. */
export const isSourceExport = (args: unknown): boolean => !!args && typeof args === "object" &&
  !Array.isArray(args) && "outputPath" in args && typeof args.outputPath === "string" && !!args.outputPath.trim();

/** The history recall tool. Sessions written before the rename to pi-tuck call it vcc_recall. */
export const isRecallTool = (name: string): boolean => ["tuck_recall", "vcc_recall"].includes(name.toLowerCase());
/** The two history lookup tools; exports exist only on ordinary recall. */
export const isLookupTool = (name: string): boolean => isRecallTool(name) || ["tuck_search", "vcc_search"].includes(name.toLowerCase());
