import { expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { installCompaction } from '../src/compaction';
import { Run, RUN_TRANSITIONS, type RunPhase } from '../src/run';
import { scriptedModelRuntime } from './model-fixture';

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const OPS = ['prompt', 'handled', 'custom', 'compact', 'steer', 'abort', 'tree', 'race', 'settled', 'late-input', 'off', 'huge', 'unsaved', 'length', 'tool'] as const;
type Op = (typeof OPS)[number];
const orders = (n: number): Op[][] => n === 0 ? [[]] : orders(n - 1).flatMap(head => OPS.map(op => [...head, op]));

async function rig() {
  const dir = mkdtempSync(join(tmpdir(), 'tuck-orders-'));
  const runtime = await scriptedModelRuntime({ contextWindow: 32768, maxTokens: 4096 });
  const model = runtime.getModel('openai-codex', 'gpt-6.1-sol')!;
  const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: true, reserveTokens: 4096, keepRecentTokens: 0 } });
  const manager = SessionManager.inMemory(dir);
  for (let i = 0; i < 12; i++) {
    manager.appendMessage({ role: 'user', content: `Task ${i}: ` + 'context '.repeat(625), timestamp: i });
    manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: `Done ${i}. ` + 'answer '.repeat(625) }], api: model.api, provider: model.provider,
      model: model.id, stopReason: 'stop', timestamp: i, usage: i === 11 ? { ...usage, input: 30000, totalTokens: 30000 } : usage } as AssistantMessage);
  }
  const state = { mode: '' as Op | '', sent: 0 };
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings, noExtensions: true, noSkills: true, noContextFiles: true,
    noPromptTemplates: true, noThemes: true, systemPrompt: 'Follow the current task.', extensionFactories: [
      async (api: ExtensionAPI) => { api.on('agent_settled', () => { if (state.mode === 'settled') { state.mode = ''; void session.prompt('From settled').catch(() => {}); } }); },
      async (api: ExtensionAPI) => { await installCompaction(api, { settings, fail: () => {} }); },
      async (api: ExtensionAPI) => {
        api.on('input', async event => {
          if (state.mode === 'late-input') await new Promise(resolve => setTimeout(resolve, 2));
          return event.text.includes('HANDLE-ME') ? { action: 'handled' as const } : undefined;
        });
        api.on('turn_end', async () => { if (state.mode === 'steer') { state.mode = ''; await session.steer('Steered'); } });
      },
    ] } as never);
  await loader.reload();
  const { session } = await createAgentSession({ cwd: dir, modelRuntime: runtime, model, thinkingLevel: 'low', sessionManager: manager, settingsManager: settings, resourceLoader: loader } as never);
  await session.bindExtensions({ onError: () => {}, abortHandler: () => { void session.abort(); } } as never);
  session.agent.streamFunction = () => {
    state.sent++;
    if (state.mode === 'abort') { state.mode = ''; void session.abort(); }
    const stream = createAssistantMessageEventStream(), mode = state.mode;
    if (mode === 'tool' || mode === 'length') state.mode = '';
    const message = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage: { ...usage, input: 28000, output: 100, totalTokens: 28100 },
      stopReason: mode === 'tool' ? 'toolUse' : mode === 'length' ? 'length' : 'stop',
      content: mode === 'tool' ? [{ type: 'toolCall', id: `c${state.sent}`, name: 'ls', arguments: {} }]
        : mode === 'length' ? [{ type: 'thinking', thinking: 'thought '.repeat(50) }] : [{ type: 'text', text: 'ok '.repeat(900) }] } as AssistantMessage;
    stream.push({ type: 'done', reason: message.stopReason as 'stop', message }); stream.end(message); return stream;
  };
  return { session, manager, state, cleanup: () => { session.dispose(); rmSync(dir, { recursive: true, force: true }); } };
}

// Choice 4: RUN_TRANSITIONS rejects an edge by latching the run shut, so no order of Pi's events may ask for one.
test('no order of session events reaches an invalid run transition', async () => {
  const edges = new Set<RunPhase | string>(), invalid: string[] = [];
  let order = '';
  const real = Run.prototype.transition;
  const spy = vi.spyOn(Run.prototype, 'transition').mockImplementation(function (this: Run, phase, error) {
    const edge = `${this.phase} -> ${phase}`;
    edges.add(edge);
    if (!RUN_TRANSITIONS[this.phase].includes(phase)) invalid.push(`${order}: ${edge}`);
    return real.call(this, phase, error);
  });
  try {
    for (const ops of orders(Number(process.env.ORDER_DEPTH ?? 2))) {
      order = ops.join(', ');
      const { session, manager, state, cleanup } = await rig();
      try {
        for (const op of ops) {
          state.mode = op;
          const quiet = (work: Promise<unknown>) => work.catch(() => {});
          const custom = () => quiet(session.sendCustomMessage({ customType: 'x', content: 'Custom task', display: true }, { triggerTurn: true }));
          const saves = vi.spyOn(manager, 'appendCompaction');
          if (op === 'unsaved') saves.mockImplementation(() => { throw new Error('disk full'); });
          if (op === 'handled') await quiet(session.prompt('HANDLE-ME'));
          else if (op === 'custom') await custom();
          else if (op === 'compact') await quiet(session.compact());
          else if (op === 'tree') await quiet(session.navigateTree((manager.getBranch()[4] ?? manager.getEntries()[4])!.id, { summarize: false }));
          else if (op === 'race') await Promise.all([quiet(session.prompt('One')), quiet(session.prompt('HANDLE-ME')), custom()]);
          else if (op === 'off') { session.setAutoCompactionEnabled(false); await quiet(session.prompt('Off')); session.setAutoCompactionEnabled(true); }
          else if (op === 'huge') await quiet(session.prompt('word '.repeat(40_000)));
          else await quiet(session.prompt(op));
          await quiet(session.waitForIdle()); state.mode = ''; saves.mockRestore();
        }
      } finally { cleanup(); }
    }
  } finally { spy.mockRestore(); }
  if (process.env.ORDER_EDGES) console.log([...edges].sort().join('\n'));
  // The orders must reach the plan, claim, refusal and persistence phases for the claim above to mean anything.
  for (const edge of ['decided -> claimed', 'decided -> expired', 'claimed -> starting', 'expired -> starting', 'starting -> admitted', 'decided -> failed'])
    expect(edges).toContain(edge);
  expect(invalid).toEqual([]);
}, 600_000);
