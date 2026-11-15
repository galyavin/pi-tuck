import { expect, test, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage, type ToolResultMessage } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI, type SessionEntry, type SessionHeader } from '@earendil-works/pi-coding-agent';
import { installCompaction } from '../src/compaction';
import { carriesPrompt } from '../src/request-capacity';
import { providerRequest } from './request-options';
import { clampMaxTokensToContext } from '@earendil-works/pi-ai/api/simple-options';
import { normalizeContext } from '@earendil-works/pi-ai';

// Public SWE-bench Pro recording lane__lane__nim-a1b1__7209ad028c__T__0012.
// Keep only model selection, system/tools, the starting task, reply 69 (zero-based) and its read result.
// Their message objects are whole; discarded history and cuts cannot shrink this fresh round.
const recorded = readFileSync(new URL('./fixtures/fresh-reasoning-refusal.jsonl', import.meta.url), 'utf8').trim().split('\n').map(line => JSON.parse(line)) as [SessionHeader, ...SessionEntry[]];
const entries = recorded.slice(1) as SessionEntry[];
const messages = entries.flatMap(entry => entry.type === 'message' ? [entry.message] : []);
const user = messages.find(message => message.role === 'user')!;
if (user.role !== 'user') throw new Error('Missing recorded task');
const task = typeof user.content === 'string' ? user.content : user.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
const reply = messages.find((message): message is AssistantMessage => message.role === 'assistant')!;
const result = messages.find((message): message is ToolResultMessage => message.role === 'toolResult')!;

test('recorded NIM fresh reasoning round is sent whole beyond the hard line with Pi’s clamped reply cap', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'pi-tuck-recorded-reasoning-'));
 const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'));
 let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
 let handle: Awaited<ReturnType<typeof installCompaction>> | undefined;
 try {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider(reply.provider, { baseUrl: 'https://fixture.invalid/v1', api: reply.api, apiKey: 'scripted-fixture', models: [{
   id: reply.model, name: 'Recorded NIM model', api: reply.api, reasoning: true, input: ['text', 'image'],
   contextWindow: 32768, maxTokens: 16384, cost: reply.usage.cost,
  }] });
  const model = runtime.getModel(reply.provider, reply.model)!;
  vi.spyOn(runtime, 'hasConfiguredAuth').mockReturnValue(true);
  vi.spyOn(runtime, 'getAuth').mockResolvedValue({ auth: { headers: { 'x-scripted-fixture': '1' } }, source: 'scripted test' });
  const taskIndex = entries.findIndex(entry => entry.type === 'message' && entry.message.role === 'user');
  const manager = SessionManager.inMemory(dir, undefined, [{ ...recorded[0], cwd: dir }, ...entries.slice(0, taskIndex)]);
  const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 } });
  const faults: string[] = [], requests: { messages: unknown[]; cap: number; estimate: number }[] = [];
  let aborts = 0, loadedResults = 0;
  const system = messages.find(message => message.role === 'system')!;
  if (system.role !== 'system') throw new Error('Missing recorded system message');
  const tools = system.toolsAdded!;
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings, noExtensions: true, noSkills: true,
   noContextFiles: true, noPromptTemplates: true, noThemes: true, systemPrompt: Object.values(system.sections ?? {}).join('\n\n'),
   extensionFactories: [async (pi: ExtensionAPI) => {
    handle = await installCompaction(pi, { settings, fail: error => faults.push(String(error)) });
    pi.on('context_with_system', event => { expect(carriesPrompt(event.messages, task)).toBe(true); });
   }],
  });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  session = (await createAgentSession({ cwd: dir, modelRuntime: runtime, model, thinkingLevel: 'high', sessionManager: manager, settingsManager: settings,
   resourceLoader: loader, tools: tools.map(tool => tool.name), customTools: tools.map(tool => ({
    name: tool.name, label: tool.name, description: tool.description, parameters: Type.Unsafe(tool.parameters),
    execute: async (id: string) => {
     expect(id).toBe(result.toolCallId);
     loadedResults++;
     return { content: structuredClone(result.content), details: {} };
    },
   })),
  })).session;
  const ui = new Proxy({ notify: () => {} }, { get: (target, name) => name in target ? target[name as keyof typeof target] : () => undefined });
  await session.bindExtensions({ uiContext: ui as never, abortHandler: () => { aborts++; void session!.abort(); } });
  session.agent.streamFunction = async (_model, context, options) => {
   const stream = createAssistantMessageEventStream();
   const wire = await providerRequest(model, context, options);
   requests.push({ messages: structuredClone(context.messages), cap: wire.maxTokens, estimate: wire.contextTokens });
   const message: AssistantMessage = requests.length === 1 ? structuredClone(reply) : {
    ...structuredClone(reply), content: [{ type: 'text', text: 'Recorded session continued.' }], stopReason: 'stop',
   };
   stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message }); stream.end(message);
   return stream;
  };
  await session.prompt(task);
  expect(faults).toEqual([]);
  expect(aborts).toBe(0);
  expect(loadedResults).toBe(1);
  expect(requests, JSON.stringify(session.messages.findLast(message => message.role === 'assistant'))).toHaveLength(2);
  expect(requests[1]!.messages).toContainEqual(reply);
  expect(requests[1]!.messages).toContainEqual(expect.objectContaining({ role: 'toolResult', toolCallId: result.toolCallId, content: result.content }));
  expect(reply.content.find(block => block.type === 'thinking')).toMatchObject({ thinkingSignature: 'reasoning_content', thinking: expect.any(String) });
  const minimum = clampMaxTokensToContext({ ...model, contextWindow: 1 }, normalizeContext({ messages: [] }), model.maxTokens);
  expect(requests[1]!.cap).toBeGreaterThanOrEqual(minimum);
  expect(requests[1]!.cap).toBe(clampMaxTokensToContext(model, normalizeContext({ messages: requests[1]!.messages as never }), model.maxTokens));
  const receipts = manager.getBranch().filter((entry): entry is Extract<SessionEntry, { type: 'custom' }> => entry.type === 'custom' && entry.customType === 'pi-tuck-capacity');
  expect(receipts.some(entry => (entry.data as { kind: string }).kind === 'refusal')).toBe(false);
  const admission = receipts.find(entry => (entry.data as { kind: string }).kind === 'native-floor');
  expect(admission).toMatchObject({ data: { kind: 'native-floor', room: 16384, piCap: requests[1]!.cap, piEstimateTokens: requests[1]!.estimate } });
  const data = admission!.data as { estimatedTokens: number; hardLine: number };
  expect(data.estimatedTokens).toBeGreaterThan(data.hardLine);
  expect(session.messages.findLast(message => message.role === 'assistant')?.stopReason).toBe('stop');
 } finally {
  if (session) { await session.abort(); session.dispose(); }
  await handle?.close();
  network.mockRestore();
  rmSync(dir, { recursive: true, force: true });
 }
});
