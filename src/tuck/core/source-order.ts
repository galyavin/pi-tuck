import type { TranscriptRecord } from "./transcript";
/** Original entry order, including public sources without numeric message coordinates.
 * Stable sorting preserves split records within each original source. */
export function orderByOriginalSource(records: TranscriptRecord[], sourceIndices: readonly (number | undefined)[], sourceEntryIds: readonly string[] = []): TranscriptRecord[] {
  const indices = new Map<number, number>(), ids = new Map<string, number>();
  sourceIndices.forEach((index, order) => { if (index !== undefined) indices.set(index, order); });
  sourceEntryIds.forEach((id, order) => ids.set(id, order));
  const order = (record: TranscriptRecord) =>
    (record.sourceEntryId === undefined ? undefined : ids.get(record.sourceEntryId)) ??
    (record.sourceIndex === undefined ? undefined : indices.get(record.sourceIndex)) ?? Infinity;
  return records.sort((a, b) => order(a) - order(b));
}
