/**
 * Session-global message indices — the single definition of the `#N` index space.
 *
 * Recall numbers every `type == "message"` entry
 * in session-file order, counting across compaction windows and abandoned
 * branches. Compaction summaries must emit the same numbers, but `normalize`
 * historically numbered the selected window from zero. This module owns the
 * counting rule so both sides agree by construction.
 *
 * Ported from k0valik/pi-blackhole commit f82e07a (issue #28).
 */

/** Entries counted by the global `#N` index: persisted message entries. */
export const isCountedMessageEntry = (entry: any): boolean =>
  entry?.type === "message" && entry.message != null;

/**
 * Map session entry ids to their global message index (position among counted
 * message entries in array order, which matches session-file order). Entries
 * without a usable id still occupy an index. Duplicate ids are dropped
 * fail-closed so callers emit no ref instead of a wrong one.
 */
export interface GlobalIndexCursor {
  byId: Map<string, number>;
  ambiguous: Set<string>;
  messageIndex: number;
  through: number;
}

/** An optional cursor extends the same index over append-only session entries without recounting history. */
export const buildGlobalIndexById = (entries: readonly any[], cursor: GlobalIndexCursor = {
  byId: new Map(), ambiguous: new Set(), messageIndex: 0, through: 0,
}): Map<string, number> => {
  const { byId, ambiguous } = cursor;
  for (let at = cursor.through; at < entries.length; at++) {
    const entry = entries[at];
    if (!isCountedMessageEntry(entry)) continue;
    const id = entry?.id;
    if (typeof id === "string" && id.length > 0) {
      if (byId.has(id) || ambiguous.has(id)) {
        byId.delete(id);
        ambiguous.add(id);
      } else {
        byId.set(id, cursor.messageIndex);
      }
    }
    cursor.messageIndex++;
  }
  cursor.through = entries.length;
  return byId;
};
