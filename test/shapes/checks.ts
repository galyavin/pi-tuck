import type { Message } from '@earendil-works/pi-ai';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { parseRecords, splitSummary, type TranscriptRecord } from '../../src/tuck/core/transcript';

export const RULES = ['current-prompt', 'openings', 'omissions', 'refusal'] as const;
export type Rule = typeof RULES[number];
export interface Finding { rule: Rule; detail: string }
type Role = 'user' | 'assistant' | 'toolResult';
interface Unit { index: number; entryId: string; role: Role; text: string; toolCallId?: string }

export function body(content: unknown): string {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.flatMap(part => part.type === 'text' ? [part.text as string] : []).join('\n') : '';
}

/** Decode only summary records, never the raw tail: literal \\n in a source stays literal.
 * The protocol reader handles v1's JSON escapes (including tabs/quotes) and v2's line escapes. */
export function view(messages: readonly Message[]) {
  const records: TranscriptRecord[] = [];
  const native: Message[] = [];
  for (const message of messages) {
    const content = body(message.content);
    const at = content.search(/(?:TUCK|VCC)-TRANSCRIPT\/[12]\n/);
    if (at < 0) { native.push(message); continue; }
    const summary = splitSummary(content.slice(at));
    if (!summary) throw new Error('Summary has no closing separator');
    records.push(...parseRecords(summary.body, summary.version));
  }
  return { records, native, texts: [...native.map(m => body(m.content)),
    ...records.flatMap(record => record.kind === 'excerpt' ? [record.text] : [])] };
}

/** Independent enumeration of recall's public session-file message indices. One text block is an assistant unit,
 * as in shrinkDialogue; tool calls are actions, and each tool result is a separate unit. */
function originals(entries: readonly SessionEntry[]) {
  const units: Unit[] = [];
  const users: { index: number; text: string; answered: boolean }[] = [];
  const indexById = new Map<string, number>();
  let index = 0;
  for (const entry of entries) {
    if (entry.type !== 'message') continue;
    indexById.set(entry.id, index);
    const message = entry.message;
    if (message.role === 'user') {
      const text = body(message.content);
      users.push({ index, text, answered: false });
      if (text) units.push({ index, entryId: entry.id, role: 'user', text });
    } else if (message.role === 'assistant' && !['error', 'aborted'].includes(message.stopReason)) {
      if (users.length && message.content.length) users.at(-1)!.answered = true;
      for (const part of message.content) if (part.type === 'text' && part.text.trim()) units.push({ index, entryId: entry.id, role: 'assistant', text: part.text });
    } else if (message.role === 'toolResult') {
      units.push({ index, entryId: entry.id, role: 'toolResult', text: body(message.content), toolCallId: message.toolCallId });
    }
    index++;
  }
  return { units, users, sourceCount: index, indexById };
}

/** An aggregate can count several units; each still needs a resolvable original index. A heading mentioning
 * tuck_recall without an index or count is not evidence that the dropped sources were accounted for. */
function omissions(units: Unit[], records: TranscriptRecord[], native: readonly Message[], sourceCount: number, indexById: Map<string, number>): string[] {
  const missing: Unit[] = [];
  for (const unit of units) {
    const raw = native.find(message => message.role === unit.role &&
      (unit.role !== 'toolResult' || message.role === 'toolResult' && message.toolCallId === unit.toolCallId) && body(message.content).includes(unit.text));
    const quoted = records.some(record => record.kind === 'excerpt' && record.sourceIndex === unit.index && record.role === unit.role && record.text.includes(unit.text));
    if (!raw && !quoted) missing.push(unit);
  }
  const failures: string[] = [];
  const covered = new Set<Unit>();
  for (const record of records.filter(record => record.kind === 'omission')) {
    const ids = [...(record.sourceEntryId === undefined ? [] : [record.sourceEntryId]),
      ...Array.from((record.reason ?? '').matchAll(/"entryId"\s*:\s*"([^"\\]+)"/g), match => match[1]!)];
    if (ids.some(id => !indexById.has(id))) { failures.push('omission points outside original entry IDs'); continue; }
    const locators = [...new Set([...(record.sourceIndex === undefined ? [] : [record.sourceIndex]), ...(record.sourceIndices ?? []),
      ...ids.map(id => indexById.get(id)!),
      ...Array.from((record.reason ?? '').matchAll(/"index"\s*:\s*(\d+)/g), match => Number(match[1]))])];
    if (locators.some(index => index < 0 || index >= sourceCount)) { failures.push('omission points outside original message indices'); continue; }
    // A counted inclusive range covers dropped units of its named role, even
    // with retained units or other roles between its endpoints. Exact counts
    // are required; a broad range with a plausible-looking total is not enough.
    if (record.sourceRange) {
      const { start, end } = record.sourceRange;
      if (start < 0 || end >= sourceCount || start > end) { failures.push('omission range points outside original message indices'); continue; }
      if (!record.role || record.count === undefined) { failures.push('omission range needs a role and count'); continue; }
      const ranged = missing.filter(unit => unit.role === record.role && unit.index >= start && unit.index <= end);
      if (record.count !== ranged.length) { failures.push(`omission range count ${record.count} does not equal ${ranged.length} dropped ${record.role} unit(s)`); continue; }
      for (const unit of ranged) covered.add(unit);
      continue;
    }
    const candidates = missing.filter(unit => !covered.has(unit) && locators.includes(unit.index) && (!record.role || record.role === unit.role));
    const count = record.count ?? (locators.length === 1 ? 1 : 0);
    for (const unit of candidates.slice(0, count)) covered.add(unit);
  }
  // Fresh tool-result clips are explicit inline omission records, with an exact recall locator.
  for (const unit of missing) if (unit.role === 'toolResult' && native.some(message => message.role === 'toolResult' &&
    message.toolCallId === unit.toolCallId && /\[pi-tuck: characters/.test(body(message.content)) &&
    body(message.content).includes('tuck_recall') &&
    (body(message.content).includes(`"entryId":"${unit.entryId}"`) || new RegExp(`"index"\\s*:\\s*${unit.index}(?:[,}])`).test(body(message.content))))) covered.add(unit);
  for (const role of ['user', 'assistant', 'toolResult'] as const) {
    const lost = missing.filter(unit => unit.role === role && !covered.has(unit));
    if (lost.length) failures.push(`${role}: ${lost.length} dropped/clipped unit(s) lack a counted omission with their pointer; first indices ${lost.slice(0, 8).map(unit => unit.index).join(',')}`);
  }
  return failures;
}

export function checkCut(messages: readonly Message[], entries: readonly SessionEntry[]): Finding[] {
  const { records, native, texts } = view(messages);
  const { users, units, sourceCount, indexById } = originals(entries);
  const watched = new Map([...users.slice(0, 1), ...users.filter(user => user.answered).slice(-8)].map(user => [user.index, user]));
  const lost = [...watched.values()].filter(user => !texts.some(text => text.includes(user.text.slice(0, 80))));
  return [
    ...(lost.length ? [{ rule: 'openings' as const, detail: `first 80 characters missing for user indices ${lost.map(user => user.index).join(',')}` }] : []),
    ...omissions(units, records, native, sourceCount, indexById).map(detail => ({ rule: 'omissions' as const, detail })),
  ];
}

export function checkPrompt(messages: readonly Message[], prompt: string): Finding[] {
  // Whole means an exact contiguous string, not a head, a substring shared by another turn, or a recall pointer.
  return view(messages).texts.some(text => text.includes(prompt)) ? [] : [{ rule: 'current-prompt', detail: 'the current input is not whole in the provider request' }];
}

export function checkRefusal(answered: boolean, promptTokens: number, room: number): Finding[] {
  return !answered && promptTokens < room ? [{ rule: 'refusal', detail: `refused although the current prompt alone fits (${promptTokens} < ${room})` }] : [];
}
