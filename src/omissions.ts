import type { ExtensionContext, SessionEntry } from '@earendil-works/pi-coding-agent';
import { buildGlobalIndexById } from './tuck/core/global-indices';
import { parseRecords, serializeRecord, splitSummary, transcriptHeader } from './tuck/core/transcript';
import { textOf } from "./tuck/core/content";
import { isDiscardedResponse } from "./protocol";
import { createRecall, type RecallPolicy } from './recall';
/** Native branch edits supply exclusion; original global indices supply provenance. */
export function omittedSourceIndices(entries: readonly SessionEntry[], branch: readonly SessionEntry[]): ReadonlySet<number> {
 const edits = new Set<string>();
 for (const entry of branch) if (entry.type === 'context_edit') {
  if (entry.replacement !== null) throw new Error('pi-tuck does not support replacement context edits');
  edits.add(entry.targetId);
 }
 if (!edits.size) return new Set();
 const indices = buildGlobalIndexById(entries);
 return new Set([...edits].flatMap(id => indices.has(id) ? [indices.get(id)!] : []));
}
/** Preserve surviving record bytes/order, and the summary's format (a v1 summary stays v1). No text matching or semantic inference. */
export function filterOmittedSummary(summary: string, omitted: ReadonlySet<number>, sources?: readonly SessionEntry[], rangeOmitted = omitted): string {
 if (!omitted.size) return summary;
 const split = splitSummary(summary);
 if (!split) throw new Error('Cannot apply native source omission to an unsupported compaction summary');
 const { body, closing, version } = split;
 const records = parseRecords(body, version), lines = body ? body.split('\n') : [];
 // A broad range does not identify the role of an intervening source. Without
 // original sources there is no evidence that an edit removes a counted unit.
 const indices = sources && rangeOmitted.size && records.some(record => record.sourceRange) ? buildGlobalIndexById(sources) : undefined;
 const sourceUnits = new Map<number, { role: string; missing: number }>();
 const shownBySource = new Map<string, string[]>();
 for (const record of records) if (record.kind === 'excerpt' && record.sourceIndex !== undefined && !record.span) {
  const key = `${record.role}:${record.sourceIndex}`, shown = shownBySource.get(key) ?? [];
  shown.push(record.text); shownBySource.set(key, shown);
 }
 if (indices && sources) for (const entry of sources) {
  if (entry.type !== 'message') continue;
  const index = indices.get(entry.id);
  if (index === undefined) continue;
  const message = entry.message;
  const shown = shownBySource.get(`${message.role}:${index}`) ?? [];
  if (message.role === 'user') {
   const text = textOf(message.content);
   sourceUnits.set(index, { role: 'user', missing: Number(Boolean(text.length) && !shown.includes(text)) });
  } else if (message.role === 'assistant' && !isDiscardedResponse(message)) {
   const available = [...shown];
   let missing = 0;
   for (const part of message.content) if (part.type === 'text' && part.text.trim()) {
    const at = available.indexOf(part.text);
    if (at < 0) missing++; else available.splice(at, 1);
   }
   sourceUnits.set(index, { role: 'assistant', missing });
  } else if (message.role === 'toolResult') sourceUnits.set(index, { role: 'toolResult', missing: 1 });
 }
 const retained = records.flatMap((record, at) => {
  if ((record.sourceIndex !== undefined && omitted.has(record.sourceIndex)) || record.sourceIndices?.some(index => omitted.has(index))) return [];
  if (!record.sourceRange || !indices || record.count === undefined) return [lines[at]!];
  const range = record.sourceRange;
  let removed = 0;
  const remaining: number[] = [];
  for (const [index, unit] of sourceUnits) {
   if (index < range.start || index > range.end || unit.role !== record.role || !unit.missing) continue;
   if (rangeOmitted.has(index)) removed += unit.missing; else if (!omitted.has(index)) remaining.push(index);
  }
  if (!removed) return [lines[at]!];
  const count = record.count - removed;
  if (count <= 0) return [];
  const sourceRange = remaining.length ? { start: Math.min(...remaining), end: Math.max(...remaining) } : range;
  const adjusted = { ...record, count, sourceRange };
  return [version === 1 ? JSON.stringify(adjusted) : serializeRecord(adjusted)];
 });
 return transcriptHeader(version) + '\n' + retained.join('\n') + closing;
}

/** Custom quotes carry native entry identity; no text matching or legacy fallback. */
export function filterCustomQuotes(summary: string, entries: readonly SessionEntry[], branch: readonly SessionEntry[], policy: RecallPolicy = {}): string {
 const split = splitSummary(summary);
 if (!split) throw new Error('Cannot resolve custom sources in an unsupported compaction summary');
 const { body, closing, version } = split;
 const records = parseRecords(body, version);
 if (!records.some(record => record.role === "custom")) return summary;
 const omitted = new Set(branch.flatMap(entry => entry.type === 'context_edit' && entry.replacement === null ? [entry.targetId] : []));
 const eligible = createRecall(policy).isHistorySource, indices = buildGlobalIndexById(entries);
 const globalCounts = new Map<string, number>(), branchSources = new Map<string, SessionEntry[]>();
 for (const entry of entries) globalCounts.set(entry.id, (globalCounts.get(entry.id) ?? 0) + 1);
 for (const entry of branch) { const found = branchSources.get(entry.id) ?? []; found.push(entry); branchSources.set(entry.id, found); }
 const lines = body ? body.split('\n') : [];
 const retained = records.flatMap((record, i) => {
  if (record.role !== 'custom') return [lines[i]!];
  const id = record.sourceEntryId, source = id === undefined ? undefined : branchSources.get(id);
  if (!id || globalCounts.get(id) !== 1 || source?.length !== 1 || omitted.has(id)) return [];
  const entry = source[0]!;
  if (record.sourceIndex !== undefined && indices.get(id) !== record.sourceIndex) return [];
  if (!(entry.type === 'custom_message' || entry.type === 'message' && entry.message.role === 'custom') || !eligible(entry)) return [];
  return [lines[i]!];
 });
 return transcriptHeader(version) + '\n' + retained.join('\n') + closing;
}
type ProjectedMessages = ReturnType<ExtensionContext['sessionManager']['buildSessionProjection']>['messages'];
/** The saved conversation as this compactor delivers it: native omissions and ineligible custom quotes removed from summaries. */
function projectMessages(messages: ProjectedMessages, ctx: ExtensionContext, policy: RecallPolicy | undefined, allowForeign: boolean): ProjectedMessages {
 const entries = ctx.sessionManager.getEntries(), branch = ctx.sessionManager.getBranch();
 const omitted = omittedSourceIndices(entries, branch);
 const lastCut = branch.findLastIndex(entry => entry.type === 'compaction');
 const cut = branch[lastCut];
 const afterCut = new Set<number>();
 if (omitted.size && cut?.type === 'compaction') {
  const indices = buildGlobalIndexById(entries);
  for (const entry of branch.slice(lastCut + 1)) if (entry.type === 'context_edit' && entry.replacement === null) {
   const index = indices.get(entry.targetId); if (index !== undefined) afterCut.add(index);
  }
 }
 return messages.map(message => message.role === 'compactionSummary' && (!allowForeign || splitSummary(message.summary) !== undefined)
  ? { ...message, summary: filterCustomQuotes(filterOmittedSummary(message.summary, omitted, entries,
      cut?.type === 'compaction' && cut.summary === message.summary ? afterCut : new Set()), entries, branch, policy) } : message);
}
export function projectedMessages(messages: ProjectedMessages, ctx: ExtensionContext, policy?: RecallPolicy): ProjectedMessages {
 return projectMessages(messages, ctx, policy, false);
}
/**
 * The same as `projectedMessages` for every summary in this compactor's format, and it never throws for any other: a summary of another
 * format (a Pi default summary, an empty draft) cannot be filtered and is left as it is. For counting a conversation that a cut is about
 * to replace, such as an operator's /compact on a session whose saved summary is foreign. The context hook and the triggers stay strict.
 */
export function measurableMessages(messages: ProjectedMessages, ctx: ExtensionContext, policy?: RecallPolicy): ProjectedMessages {
 return projectMessages(messages, ctx, policy, true);
}
