import type { ExtensionContext, SessionEntry } from '@earendil-works/pi-coding-agent';
import { buildGlobalIndexById } from './tuck/core/global-indices';
import { TRANSCRIPT_HEADER, parseRecords, splitSummary } from './tuck/core/transcript';
import { createRecall, type RecallPolicy } from './recall';
/** Native branch edits supply exclusion; original global indices supply provenance. */
export function omittedSourceIndices(entries: readonly SessionEntry[], branch: readonly SessionEntry[]): ReadonlySet<number> {
 const indices = buildGlobalIndexById(entries);
 const edits = new Map<string, boolean>();
 for (const entry of branch) if (entry.type === 'context_edit') {
  if (entry.replacement !== null) throw new Error('pi-tuck does not support replacement context edits');
  edits.set(entry.targetId, true);
 }
 return new Set([...edits].flatMap(([id, omitted]) => omitted && indices.has(id) ? [indices.get(id)!] : []));
}
/** Preserve surviving record bytes/order. No text matching or semantic inference. */
export function filterOmittedSummary(summary: string, omitted: ReadonlySet<number>): string {
 if (!omitted.size) return summary;
 const split = splitSummary(summary);
 if (!split) throw new Error('Cannot apply native source omission to an unsupported compaction summary');
 const { body, closing } = split;
 const records = parseRecords(body), lines = body ? body.split('\n') : [];
 const retained = records.flatMap((record, i) =>
  (record.sourceIndex !== undefined && omitted.has(record.sourceIndex)) || record.sourceIndices?.some(index => omitted.has(index)) ? [] : [lines[i]!]);
 return TRANSCRIPT_HEADER + '\n' + retained.join('\n') + closing;
}

/** Custom quotes carry native entry identity; no text matching or legacy fallback. */
export function filterCustomQuotes(summary: string, entries: readonly SessionEntry[], branch: readonly SessionEntry[], policy: RecallPolicy = {}): string {
 const split = splitSummary(summary);
 if (!split) throw new Error('Cannot resolve custom sources in an unsupported compaction summary');
 const { body, closing } = split;
 const omitted = new Set(branch.flatMap(entry => entry.type === 'context_edit' && entry.replacement === null ? [entry.targetId] : []));
 const eligible = createRecall(policy).isHistorySource, indices = buildGlobalIndexById(entries);
 const globalCounts = new Map<string, number>(), branchSources = new Map<string, SessionEntry[]>();
 for (const entry of entries) globalCounts.set(entry.id, (globalCounts.get(entry.id) ?? 0) + 1);
 for (const entry of branch) { const found = branchSources.get(entry.id) ?? []; found.push(entry); branchSources.set(entry.id, found); }
 const lines = body ? body.split('\n') : [];
 const records = parseRecords(body);
 const retained = records.flatMap((record, i) => {
  if (record.role !== 'custom') return [lines[i]!];
  const id = record.sourceEntryId, source = id === undefined ? undefined : branchSources.get(id);
  if (!id || globalCounts.get(id) !== 1 || source?.length !== 1 || omitted.has(id)) return [];
  const entry = source[0]!;
  if (record.sourceIndex !== undefined && indices.get(id) !== record.sourceIndex) return [];
  if (!(entry.type === 'custom_message' || entry.type === 'message' && entry.message.role === 'custom') || !eligible(entry)) return [];
  return [lines[i]!];
 });
 return TRANSCRIPT_HEADER + '\n' + retained.join('\n') + closing;
}
type ProjectedMessages = ReturnType<ExtensionContext['sessionManager']['buildSessionProjection']>['messages'];
/** The saved conversation as this compactor delivers it: native omissions and ineligible custom quotes removed from summaries. */
export function projectedMessages(messages: ProjectedMessages, ctx: ExtensionContext, policy?: RecallPolicy): ProjectedMessages {
 const entries = ctx.sessionManager.getEntries(), branch = ctx.sessionManager.getBranch();
 const omitted = omittedSourceIndices(entries, branch);
 return messages.map(message => message.role === 'compactionSummary'
  ? { ...message, summary: filterCustomQuotes(filterOmittedSummary(message.summary, omitted), entries, branch, policy) } : message);
}
/** Whether a compaction summary is in this compactor's own format. */
const isTranscriptSummary = (summary: string) => splitSummary(summary) !== undefined;
/**
 * The same as `projectedMessages` for every summary in this compactor's format, and it never throws for any other: a summary of another
 * format (a Pi default summary, an empty draft) cannot be filtered and is left as it is. For counting a conversation that a cut is about
 * to replace, such as an operator's /compact on a session whose saved summary is foreign. The context hook and the triggers stay strict.
 */
export function measurableMessages(messages: ProjectedMessages, ctx: ExtensionContext, policy?: RecallPolicy): ProjectedMessages {
 const entries = ctx.sessionManager.getEntries(), branch = ctx.sessionManager.getBranch();
 const omitted = omittedSourceIndices(entries, branch);
 return messages.map(message => message.role === 'compactionSummary' && isTranscriptSummary(message.summary)
  ? { ...message, summary: filterCustomQuotes(filterOmittedSummary(message.summary, omitted), entries, branch, policy) } : message);
}
