import { expect, test } from 'vitest';
import { harness } from './budget-fixture';
import { carriesPrompt } from '../src/request-capacity';

for (const room of [16384, 32768]) for (const steer of [false, true]) {
 test(`large parallel round preserves the whole run prompt${steer ? ' with a steer at the next boundary' : ' without a steer'} (room ${room})`, async () => {
  const h = await harness({ at: 'tool', complete: 0, host: 200, systemTokens: 1500,
   noHistory: true, noOpening: true, cutAtDefault: true, keepRecent: 20000,
   limits: { contextWindow: room + 16384, maxTokens: 8192 }, reserveTokens: 16384,
   parallelReads: [12806, 9137, 4996].map(size => size * room / 16384), rounds: 1,
   compaction: { requestReserve: undefined }, piRequestPath: true,
   afterDecision: (at, api) => { if (steer && at === 1) void api.steer(70); },
  });
  const prompt = 'TASK_BEGIN\n' + h.sized(2040) + '\nTASK_LAST_REQUIREMENT';
  const carried: boolean[] = [], steered: boolean[] = [], rounds: number[][] = [], owners: boolean[] = [];
  const ownerIds: (string | undefined)[] = [];
  let steeringText = '';
  h.extension().on('message_end', (event, ctx) => {
   if (event.message.role === 'user') {
    const state = h.compactionHandle().inspectState(ctx), branch = h.manager.getBranch();
    owners.push(state.run?.prompt?.text(branch) === prompt);
    if (owners.length > 1) steeringText = typeof event.message.content === 'string' ? event.message.content :
     event.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
   }
  });
  h.extension().on('context_with_system', (event, ctx) => {
   ownerIds.push(h.compactionHandle().inspectState(ctx).run?.prompt?.id(h.manager.getBranch()));
   carried.push(carriesPrompt(event.messages, prompt));
   steered.push(Boolean(steeringText) && carriesPrompt(event.messages, steeringText));
   rounds.push(event.messages.filter(message => message.role === 'toolResult').map(message => JSON.stringify(message.content).length));
  });
  try {
   await h.session.prompt(prompt);
   expect(h.faults).toEqual([]);
   expect(h.state.aborts).toBe(0);
   expect(h.state.requests).toBe(2);
   expect(carried).toEqual([true, true]);
   expect(steered).toEqual([false, steer]);
   expect(owners).toEqual(steer ? [true, true] : [true]);
   expect(ownerIds[0]).toBeDefined();
   expect(ownerIds[1]).toBe(ownerIds[0]);
   expect(h.state.results).toHaveLength(3);
   expect(h.state.results.reduce((a, b) => a + b, 0)).toBeGreaterThan(room + 8704);
   expect(rounds[1]).toHaveLength(3);
   expect(h.state.clips).toBeGreaterThan(0);
   const originals = h.manager.getBranch().filter(entry => entry.type === 'message' && entry.message.role === 'toolResult');
   expect(originals).toHaveLength(3);
   for (const entry of originals) expect(JSON.stringify(entry)).not.toContain('are not shown');
   expect(h.session.messages.findLast(message => message.role === 'assistant')?.stopReason).toBe('stop');
  } finally { await h.cleanup(); }
 });
}
