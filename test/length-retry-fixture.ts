import { expect } from 'vitest';
import type { TranscriptContext } from '@earendil-works/pi-ai';
import { requestReplyFloor } from '../src/request-capacity';
import { parseRecords, splitSummary } from '../src/tuck/core/transcript';
import { harness } from './budget-fixture';

export const thinkingLengthCells = [
 { name: 'setup below the room', above: false, twice: false },
 { name: 'setup above the room', above: true, twice: false },
 { name: 'the retried reply stops again', above: true, twice: true },
] as const;

export async function thinkingLengthCell(cell: { above: boolean; twice: boolean }) {
 const wire: TranscriptContext[] = [], originals: { id: string; json: string }[] = [];
 const h = await harness({ at: 'prompt', complete: 21_500, host: 200, systemTokens: cell.above ? 16_648 : 6_000,
  history: cell.above ? 4_000 : 11_000, incoming: cell.above ? 17_500 : 6_750,
  limits: { contextWindow: 32_768, maxTokens: 16_384 }, reserveTokens: 16_384, keepRecent: 20_000,
  thinkingOnlyLength: n => n === 1 || cell.twice && n === 2, piRequestPath: true, compaction: { requestReserve: undefined },
  onWire: context => wire.push(structuredClone(context as TranscriptContext)) });
 h.extension().on('turn_end', event => { originals.push({ id: event.messageEntryId, json: JSON.stringify(event.message) }); });
 try {
  const r = await h.run(), branch = h.manager.getBranch();
  const retry = branch.filter(entry => entry.type === 'custom' && entry.customType === 'pi-tuck-capacity' &&
   (entry.data as { kind?: string })?.kind === 'retry');
  const cut = h.compactions().find(entry => (entry.details as { deepest?: boolean })?.deepest);
  const details = cut?.details as { tokensAfter?: number; carriedTarget?: number } | undefined;
  const summary = cut && splitSummary(cut.summary);
  const records = summary ? parseRecords(summary.body, summary.version) : [];
  const preserved = originals.length === h.state.answers.length && originals.every(original => {
   const entry = h.manager.getEntry(original.id);
   return entry?.type === 'message' && JSON.stringify(entry.message) === original.json;
  });
  return { requests: h.state.requests, caps: h.state.requestOptions.map(request => request.baseMaxTokens),
   contextTokens: h.state.requestOptions.map(request => request.contextTokens),
   outputs: h.state.answers.map(answer => answer.usage.output), stops: h.state.answers.map(answer => answer.stopReason),
   retries: retry.length, receipt: retry[0]?.type === 'custom' ? retry[0].data : undefined,
   omitted: !wire[1]?.messages.some(message => message.role === 'assistant' && message.stopReason === 'length'), preserved,
   wholePrompt: r.wholePrompt.every(Boolean),
   noOptionalHistory: wire[1] !== undefined && wire[1].messages.every(message => message.role === 'system' || message.role === 'user') &&
    records.every(record => record.kind !== 'excerpt' || record.role === 'user'),
   deepest: details !== undefined && details.tokensAfter === details.carriedTarget,
   replyFloor: requestReplyFloor(branch, 16_384, h.session.model!), faults: [...h.faults], notices: [...h.notices] };
 } finally { await h.cleanup(); }
}

export function expectThinkingLengthOutcome(cell: (typeof thinkingLengthCells)[number], r: Awaited<ReturnType<typeof thinkingLengthCell>>) {
 expect(r.preserved).toBe(true);
 expect(r.faults).toEqual([]);
 expect(r.replyFloor).toBe(Math.max(1, ...r.outputs));
 expect(r.notices).toEqual(!cell.above || cell.twice ? [
  "pi-tuck: the model exhausted its output allowance before producing an answer or tool call. The unfinished response is saved in the session.",
 ] : []);

 if (!cell.above) {
  expect(r.requests).toBe(1);
  expect(r.retries).toBe(0);
  expect(r.stops).toEqual(['length']);
  return;
 }

 expect(r.requests).toBe(2);
 expect(r.retries).toBe(1);
 expect(r.stops).toEqual(['length', cell.twice ? 'length' : 'stop']);
 expect(r.omitted).toBe(true);
 expect(r.wholePrompt).toBe(true);
 expect(r.noOptionalHistory).toBe(true);
 expect(r.deepest).toBe(true);
 expect(r.caps[1]).toBeGreaterThan(Math.max(r.caps[0]!, r.outputs[0]!));
 expect(r.receipt).toMatchObject({ kind: 'retry', stoppedOutputTokens: r.outputs[0], piEstimateTokens: r.contextTokens[1], piCap: r.caps[1] });
}
