import { test, expect } from 'vitest';
import { harness } from './budget-fixture';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

test('a never-reaches-room session sends byte-identical contexts with the standalone floor and the original host reserve', async () => {
 const run = async (standalone: boolean) => {
  const contexts: unknown[] = [];
  const h = await harness({ at: 'prompt', complete: 0, noHistory: true, noOpening: true, host: 200, systemTokens: 800,
   limits: { contextWindow: 65_536, maxTokens: 8_192 }, reserveTokens: 16_384, toolCalls: n => [1, 2, 4].includes(n), toolResultTokens: () => 150,
   stableHost: true, onWire: context => { contexts.push(structuredClone(context)); }, compaction: { requestReserve: standalone ? undefined : () => ({ response: 16_384, responseExact: true }) } });
  try {
   for (const prompt of ['First complete task\nKeep all conditions', 'Continue this task', 'Finish']) await h.session.prompt(prompt);
   expect(Math.max(...h.guard)).toBeLessThan(49_152);
   expect(h.faults).toEqual([]);
   expect(h.state.stops.filter(s => s === 'stop')).toHaveLength(3);
   expect(h.manager.getBranch().filter(e => e.type === 'custom' && e.customType === 'pi-tuck-capacity')).toHaveLength(0);
   return contexts.map(context => JSON.stringify(context, (key, value) => key === 'timestamp' || key === 'durationMs' ? undefined : value).replaceAll(h.dir, '<session>'));
  } finally { await h.cleanup(); }
 };
 const standalone = await run(true), host = await run(false);
 expect(standalone).toEqual(host);
 if (process.env.FLOOR_REPLAY_OUT) writeFileSync(process.env.FLOOR_REPLAY_OUT, JSON.stringify({ requests: standalone.map(s => createHash('sha256').update(s).digest('hex')), answered: 3, refused: 0, deadTasks: 0, faults: 0 }));
});
