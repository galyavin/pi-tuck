/** Recorded export attempt, not proof of a successful write or current file truth. */
export const isSourceExport = (args: unknown): boolean => !!args && typeof args === "object" &&
  !Array.isArray(args) && "outputPath" in args && typeof args.outputPath === "string" && !!args.outputPath.trim();

/** Historical names are read compatibility only; never registered as aliases. */
export const isRecallTool = (name: string): boolean => ["pi_tuck_recall", "vcc_recall"].includes(name.toLowerCase());
/** The history lookup tools, including saved legacy calls; exports exist only on recall. */
export const isLookupTool = (name: string): boolean => isRecallTool(name) || ["pi_tuck_search", "vcc_search"].includes(name.toLowerCase());
