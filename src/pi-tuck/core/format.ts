export const RECALL_NOTE =
  "A tool_receipt record quotes complete original textual output. Its producer arguments are complete when present; argumentsOmitted means read the original call source for them. Use it directly as evidence of that recorded event; it does not verify current state or authorize replay. " +
  "Use `pi_tuck_recall` to search for prior work, decisions, and context from before this summary. " +
  "Read call/receipt sources by index before relying on omitted or truncated evidence. Receipt non-error is not proof of effects. Do not redo work already completed.";
export const SUMMARY_SUFFIX = "\n\n---\n\n" + RECALL_NOTE;
/** Exact saved suffix from before the rename; read compatibility only. */
export const LEGACY_SUMMARY_SUFFIX = SUMMARY_SUFFIX.replace("pi_tuck_recall", "vcc_recall");
export const summarySuffix = (text: string): string | undefined =>
  [SUMMARY_SUFFIX, LEGACY_SUMMARY_SUFFIX].find(suffix => text.endsWith(suffix));

