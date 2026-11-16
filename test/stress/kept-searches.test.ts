import { expect, test } from 'vitest';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { harness } from '../budget-fixture';
import { buildGlobalIndexById } from '../../src/tuck/core/global-indices';
import { parseRecords, splitSummary } from '../../src/tuck/core/transcript';
import { checkCut } from '../shapes/checks';
import { convertToLlm } from '@earendil-works/pi-coding-agent';

const enabled = /^(1|true|yes)$/i.test(process.env.STRESS ?? '');
const answer = (content: unknown[], stopReason = 'stop') => ({ role: 'assistant', content, stopReason,
  api: 'openai-completions', provider: 'fixture', model: 'fixture', timestamp: 0,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }) as never;
function call(manager: SessionManager, id: string, name: string, args: object, text: string) {
  manager.appendMessage(answer([{ type: 'toolCall', id, name, arguments: args }], 'toolUse'));
  return manager.appendMessage({ role: 'toolResult', toolCallId: id, toolName: name, isError: false, content: [{ type: 'text', text }], timestamp: 0 });
}
function padding(manager: SessionManager, label: string) {
  for (let i = 0; i < 8; i++) {
    call(manager, `${label}-${i}`, 'bash', { command: `cat log-${label}-${i}` }, `Recorded ${label} ${i}.\n`.repeat(1800));
    manager.appendMessage(answer([{ type: 'text', text: `Finished ${label} ${i}.` }]));
  }
}

for (const mutation of ['none', 'write', 'bash'] as const) {
  test.skipIf(!enabled)(`kept search across cuts: ${mutation === 'none' ? 'preserved' : `voided by ${mutation}`}`, async () => {
    const seed = SessionManager.inMemory('/kept-search-stress');
    seed.appendMessage({ role: 'user', content: 'Find the recorded implementation and continue.', timestamp: 0 });
    const output = 'src/a.ts:12:the recorded implementation\nsrc/b.ts:18:another match';
    const result = call(seed, 'search', 'bash', { command: 'cd /work/repo && rg -n implementation src | head -20' }, output);
    padding(seed, 'before');
    const h = await harness({ at: 'prompt', complete: 0, host: 0, branch: seed.getBranch(), noHistory: true, noOpening: true,
      systemTokens: 256, reserveTokens: 8192, keepRecent: 20000, cutAtDefault: true,
      limits: { contextWindow: 32768, maxTokens: 8192 }, usageRatio: 1, rejectOverWindow: true });
    const summaries = () => h.compactions().map(entry => entry.summary);
    try {
      await h.session.prompt('Continue after inspecting the search.');
      expect(summaries().length).toBeGreaterThan(0);
      expect(checkCut(convertToLlm(h.saved()), h.manager.getEntries())).toEqual([]);
      const searches = (summary: string) => parseRecords(splitSummary(summary)!.body).filter(record => record.title === 'Kept-search');
      const index = buildGlobalIndexById(h.manager.getEntries()).get(result)!;
      expect(searches(summaries().at(-1)!)).toEqual([{ kind: 'section', title: 'Kept-search', sourceIndex: index,
        text: `bash cd /work/repo && rg -n implementation src | head -20 (as recorded at #${index}; no file it lists was written or edited since):\n${output}` }]);
      const firstCuts = summaries().length;
      if (mutation === 'write') call(h.manager, 'mutation', 'write', { path: '/work/repo/src/a.ts', content: 'changed' }, 'written');
      if (mutation === 'bash') call(h.manager, 'mutation', 'bash', { command: 'npm run build' }, 'built');
      padding(h.manager, 'after');
      h.session.agent.state.messages = h.saved();
      await h.session.prompt('Continue after the next batch of work.');
      expect(summaries().length).toBeGreaterThan(firstCuts);
      expect(checkCut(convertToLlm(h.saved()), h.manager.getEntries())).toEqual([]);
      for (const summary of summaries().slice(firstCuts)) expect(searches(summary)).toHaveLength(mutation === 'none' ? 1 : 0);
      const source = h.manager.getEntries().find(entry => entry.id === result);
      expect(source?.type === 'message' && source.message.role === 'toolResult' && source.message.content).toEqual([{ type: 'text', text: output }]);
      expect(h.state.stops.filter(stop => stop === 'stop')).toHaveLength(2);
      expect(h.faults).toEqual([]);
      process.stderr.write(`kept-search stress: ${mutation}, ${summaries().length} saved cuts, ${h.state.requests} requests, PASS\n`);
    } finally { await h.cleanup(); }
  }, 60000);
}
