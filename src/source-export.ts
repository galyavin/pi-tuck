import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildGlobalIndexById } from "./tuck/core/global-indices";
import { createRecall, type RecallPolicy, type ReadableEntry } from "./recall";

/** Select one original readable source. No filesystem, state, paging or semantic inference. */
export function exportSource(entries: readonly SessionEntry[], branch: readonly SessionEntry[],
 input: { entryId: string } | { index: number }, policy: RecallPolicy = {}): (ReadableEntry & { index: number | undefined }) | undefined {
 if (branch.some(e => e.type === "context_edit" && e.replacement !== null))
  throw new Error("pi-tuck does not support replacement context edits");
 const indices = buildGlobalIndexById(entries);
 const matches = branch.filter(e => "entryId" in input ? e.id === input.entryId : indices.get(e.id) === input.index);
 const source = matches[0];
 if (matches.length !== 1 || !source || entries.filter(e => e.id === source.id).length !== 1 ||
  source.type === "compaction" || branch.some(e => e.type === "context_edit" && e.targetId === source.id)) return;
 const recall = createRecall(policy), row = recall.readable(source, recall.recallAttempts(branch));
 return row ? { ...row, index: indices.get(source.id) } : undefined;
}
