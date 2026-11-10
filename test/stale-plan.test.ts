import { expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage, type Context } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { installCompaction } from '../src/compaction';
import { scriptedModelRuntime } from './model-fixture';

// pi-tuck plans a prompt's cut on `input`. When a later extension handles that input, no run starts for it, and the plan must not reach the
// next run: one a custom message starts, or one on another branch after a move in the tree.
async function lifecycle(handled: boolean, treeTo?: number) {
  const dir = mkdtempSync(join(tmpdir(), 'tuck-stale-plan-'));
  const runtime = await scriptedModelRuntime({ contextWindow: 32768, maxTokens: 4096 });
  const model = runtime.getModel('openai-codex', 'gpt-6.1-sol')!;
  const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: true, reserveTokens: 4096, keepRecentTokens: 0 } });
  const manager = SessionManager.inMemory(dir);
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  for (let i = 0; i < 12; i++) {
    manager.appendMessage({ role: 'user', content: `Task ${i}: ` + 'context '.repeat(400), timestamp: i });
    manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: `Done ${i}. ` + 'answer '.repeat(400) }], api: model.api, provider: model.provider,
      model: model.id, stopReason: 'stop', timestamp: i, usage } as AssistantMessage);
  }
  const faults: string[] = [], requests: Context[] = [];
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings, noExtensions: true, noSkills: true, noContextFiles: true,
    noPromptTemplates: true, noThemes: true, systemPrompt: 'Follow the current task.', extensionFactories: [
      async (api: ExtensionAPI) => { await installCompaction(api, { settings, fail: error => faults.push(String(error)) }); },
      async (api: ExtensionAPI) => { api.on('input', event => event.text.includes('HANDLE-ME') ? { action: 'handled' } : undefined); },
    ] } as never);
  await loader.reload();
  const { session } = await createAgentSession({ cwd: dir, modelRuntime: runtime, model, thinkingLevel: 'low', sessionManager: manager, settingsManager: settings,
    resourceLoader: loader, tools: [] } as never);
  await session.bindExtensions({ onError: (event: { error: string }) => faults.push(event.error) } as never);
  session.agent.streamFunction = (_m, ctx) => {
    requests.push(structuredClone(ctx));
    const stream = createAssistantMessageEventStream();
    const message = { role: 'assistant', content: [{ type: 'text', text: 'ok' }], api: model.api, provider: model.provider, model: model.id, stopReason: 'stop',
      timestamp: Date.now(), usage } as AssistantMessage;
    stream.push({ type: 'done', reason: 'stop', message }); stream.end(message); return stream;
  };
  try {
    if (handled) await session.prompt('HANDLE-ME ' + 'handled prompt text '.repeat(1500));
    expect(requests).toHaveLength(0);
    if (treeTo !== undefined) await session.navigateTree(manager.getEntries().filter(e => e.type === 'message')[treeTo].id);
    await session.sendCustomMessage({ customType: 'report', content: 'CUSTOM-RUN a short report', display: false }, { triggerTurn: true });
    expect(faults).toEqual([]);
    expect(requests).toHaveLength(1);
    const cuts = manager.getEntries().filter(e => e.type === 'compaction') as { id: string; firstKeptEntryId: string }[];
    for (const cut of cuts) expect(manager.getBranch(cut.id).map(e => e.id)).toContain(cut.firstKeptEntryId);
    const request = JSON.stringify(requests[0]);
    expect(request).toContain('CUSTOM-RUN');
    return { messages: requests[0].messages.length, chars: request.length, cuts: cuts.length };
  } finally { await session.abort(); session.dispose(); rmSync(dir, { recursive: true, force: true }); }
}

test('a run a custom message starts plans afresh after a handled input', async () => {
  expect(await lifecycle(true)).toEqual(await lifecycle(false));
});

for (const treeTo of [7, 15]) test(`a move in the tree drops the plan of a handled input (to message ${treeTo})`, async () => {
  expect(await lifecycle(true, treeTo)).toEqual(await lifecycle(false, treeTo));
});
