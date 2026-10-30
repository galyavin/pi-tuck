import { SessionManager, type ExtensionContext, type SessionEntry, type SessionHeader } from '@earendil-works/pi-coding-agent';
import { tuck, tuckObservedDraft } from './tuck.js';
import { measurableConversationTokens } from './budget.js';
import { DIAGNOSTIC_BUILD, type IncidentRecord } from './diagnostics.js';
export function inspectIncident(records: IncidentRecord[]) {
 const inputs = records.filter(r => r.kind === 'replay-input');
 const results = inputs.map(record => {
  const i = record.data as { build?: string; receiptId?: string; entries?: SessionEntry[]; branchEntryIds?: string[]; header?: SessionHeader; contextWindow?: number; reserve?: number; tokensBefore?: number; retainCurrentInput?: boolean; operatorManual?: boolean; previousSummary?: string };
  if (record.partial || i.build !== DIAGNOSTIC_BUILD || !i.entries || !i.header || !Array.isArray(i.branchEntryIds) || i.branchEntryIds.some(id => typeof id !== 'string') || !Number.isSafeInteger(i.contextWindow) || !Number.isSafeInteger(i.reserve) || !Number.isSafeInteger(i.tokensBefore)) return { mode: 'partial-inspection', notice: 'Missing/redacted inputs or nonmatching build; no deterministic replay claim.' };
  const manager = SessionManager.inMemory('/offline-compaction-replay', undefined, [i.header, ...i.entries]);
  if (i.branchEntryIds?.length) manager.branch(i.branchEntryIds.at(-1)!);
  const ctx = { sessionManager: manager, cwd: '/offline-compaction-replay', model: { contextWindow: i.contextWindow } } as unknown as ExtensionContext;
  const draft = tuckObservedDraft(tuck, { branchEntries: manager.getBranch(), tokensBefore: i.tokensBefore!, previousSummary: i.previousSummary, operatorManual: i.operatorManual }, ctx, i.reserve!, messages => measurableConversationTokens(messages, ctx), {}, i.retainCurrentInput);
  const proposal = records.find(r => r.kind === 'proposal' && (r.data as { details?: { diagnosticReceipt?: { id?: string } } })?.details?.diagnosticReceipt?.id === i.receiptId)?.data as { summary?: string; firstKeptEntryId?: string } | undefined;
  const matchesRecordedProposal = proposal && draft.compaction ? proposal.summary === draft.compaction.summary && proposal.firstKeptEntryId === draft.compaction.firstKeptEntryId : null;
  return { mode: 'deterministic-selection-replay', draft, receiptId: i.receiptId ?? null, matchesRecordedProposal, notice: 'Supplied permitted originals and resolved state only; no tools, inference, semantic fidelity, persistence or transmission claim.' };
 });
 return { build: DIAGNOSTIC_BUILD, records: records.length, results, notice: 'Prepared context is a public hook observation, not wire or provider history. Structural redaction does not detect all semantic secrets.' };
}
export function readableIncident(records: IncidentRecord[]): string {
 return '# Compaction incident\n\n' + JSON.stringify(inspectIncident(records), null, 2) + '\n\n' + records.map(r => `## ${r.kind} (${r.scope})${r.partial ? ' — PARTIAL' : ''}\n\n${JSON.stringify(r.data, null, 2)}`).join('\n\n');
}
