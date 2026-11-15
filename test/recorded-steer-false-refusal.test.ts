import { expect, test, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage, type ToolResultMessage } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI, type SessionEntry, type SessionHeader } from '@earendil-works/pi-coding-agent';
import { installCompaction, seedWindow } from '../src/compaction';
import { carriesPrompt } from '../src/request-capacity';
import { nonSystem, referenceSystemPart } from './budget-fixture';

// Public NIM benchmark recording, task ansible-42355d18, entries 0..18. Only the three read bodies are shortened;
// duplicate read details are removed and machine paths are scrubbed. The issue and the late instruction remain whole.
const recorded = readFileSync(new URL('./fixtures/steer-false-refusal.jsonl', import.meta.url), 'utf8').trim().split('\n').map(line => JSON.parse(line)) as [SessionHeader, ...SessionEntry[]];
const entries = recorded.slice(1) as SessionEntry[];
const messages = entries.flatMap(entry => entry.type === 'message' ? [entry.message] : []);
const users = messages.filter(message => message.role === 'user');
const textOf = (message: typeof users[number]) => typeof message.content === 'string' ? message.content : message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
const task = textOf(users[0]!), steer = textOf(users[1]!);
const replies = messages.filter((message): message is AssistantMessage => message.role === 'assistant');
const results = messages.filter((message): message is ToolResultMessage => message.role === 'toolResult');
const identity = replies[0]!;
const key = JSON.stringify([identity.provider, identity.api, identity.model]);

test('recorded NIM session admits the late steer and sends the whole task and instruction', async () => {
 const dir = mkdtempSync(join(tmpdir(), 'pi-tuck-recorded-steer-'));
 const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'));
 let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
 let handle: Awaited<ReturnType<typeof installCompaction>> | undefined;
 try {
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider(identity.provider, { baseUrl: 'https://fixture.invalid/v1', api: identity.api, apiKey: 'scripted-fixture', models: [{
   id: identity.model, name: 'Recorded NIM model', api: identity.api, reasoning: true, input: ['text', 'image'],
   contextWindow: 32768, maxTokens: 8192, cost: identity.usage.cost,
  }] });
  const model = runtime.getModel(identity.provider, identity.model)!;
  vi.spyOn(runtime, 'hasConfiguredAuth').mockReturnValue(true);
  vi.spyOn(runtime, 'getAuth').mockResolvedValue({ auth: { headers: { 'x-scripted-fixture': '1' } }, source: 'scripted test' });
  // Restore model selection and the recorded calibration before replay. The task starts the live run below;
  // all recorded assistant/tool messages before the steer load through Pi's actual stream and tool loop.
  const taskIndex = entries.findIndex(entry => entry.type === 'message' && entry.message.role === 'user');
  const manager = SessionManager.inMemory(dir, undefined, [{ ...recorded[0], cwd: dir }, ...entries.slice(0, taskIndex)]);
  for (const entry of entries) if (entry.type === 'custom') manager.appendCustomEntry(entry.customType, entry.data);
  expect(seedWindow(manager.getBranch(), key)).toEqual([1, 0.7956134008194746, 0.81717263253285, 0.854427645788337]);
  const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 } });
  const faults: string[] = [], requests: { task: boolean; steer: boolean }[] = [], liveSteers: boolean[] = [];
  let aborts = 0, request = 0, loadedResults = 0, beforeRound = 0;
  const system = messages.find(message => message.role === 'system')!;
  if (system.role !== 'system') throw new Error('Missing recorded system message');
  const tools = system.toolsAdded!;
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings, noExtensions: true, noSkills: true,
   noContextFiles: true, noPromptTemplates: true, noThemes: true, systemPrompt: Object.values(system.sections ?? {}).join('\n\n'),
   extensionFactories: [async (pi: ExtensionAPI) => {
    // Observe the real boundary before pi-tuck plans it: the recorded parallel round must still cross the hard line.
    pi.on('turn_end', (event, ctx) => {
     if (event.toolResults.length !== 3 || !event.toolResults.every(result => result.toolName === 'read')) return;
     const active = pi.getAllTools().filter(tool => pi.getActiveTools().includes(tool.name));
     beforeRound = referenceSystemPart(event.context.contextMessages, ctx.getSystemPrompt(), JSON.stringify(active)) + nonSystem(event.context.contextMessages);
    });
    handle = await installCompaction(pi, { settings, fail: error => faults.push(String(error)) });
    // This hook runs after the tool-boundary decision, exactly where the recording's late user entry arrived.
    pi.on('turn_end', async event => {
     if (event.toolResults.length === 3 && event.toolResults.every(result => result.toolName === 'read')) {
      liveSteers.push(session!.isStreaming);
      await session!.steer(steer);
     }
    });
   }],
  });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  session = (await createAgentSession({ cwd: dir, modelRuntime: runtime, model, thinkingLevel: 'high', sessionManager: manager, settingsManager: settings,
   resourceLoader: loader, tools: ['bash', 'read'], customTools: tools.filter(tool => ['bash', 'read'].includes(tool.name)).map(tool => ({
    name: tool.name, label: tool.name, description: tool.description, parameters: Type.Unsafe(tool.parameters),
    execute: async (id: string) => {
     const result = results.find(message => message.toolCallId === id);
     if (!result) throw new Error(`Unrecorded tool call ${id}`);
     loadedResults++;
     return { content: result.content, details: {} };
    },
   })),
  })).session;
  const ui = new Proxy({ notify: () => {} }, { get: (target, name) => name in target ? target[name as keyof typeof target] : () => undefined });
  await session.bindExtensions({ uiContext: ui as never, abortHandler: () => { aborts++; void session!.abort(); } });
  session.agent.streamFunction = async (_model, context, options) => {
   const stream = createAssistantMessageEventStream();
   if (options?.signal?.aborted) {
    const error = { ...replies[0]!, content: [], stopReason: 'aborted' as const };
    stream.push({ type: 'error', reason: 'aborted', error }); stream.end(error); return stream;
   }
   requests.push({ task: carriesPrompt(context.messages, task), steer: carriesPrompt(context.messages, steer) });
   const reply = replies[request++];
   const message: AssistantMessage = reply ? structuredClone(reply) : { ...structuredClone(replies[0]!), content: [{ type: 'text', text: 'Recorded session continued.' }], stopReason: 'stop' };
   stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message }); stream.end(message);
   return stream;
  };
  expect(nonSystem(results.filter(result => result.toolName === 'read'))).toBeGreaterThan(25088);
  await session.prompt(task);
  expect(beforeRound).toBeGreaterThan(25088); // room 16,384 + Pi's 8,704-token clamp margin
  expect(loadedResults).toBe(results.length);
  expect(liveSteers).toEqual([true]);
  expect(faults).toEqual([]);
  expect(aborts).toBe(0);
  expect(manager.getEntries().filter(entry => entry.type === 'custom' && entry.customType === 'pi-tuck-capacity' && (entry.data as { kind?: string })?.kind === 'refusal')).toEqual([]);
  expect(requests).toEqual([{ task: true, steer: false }, { task: true, steer: false }, { task: true, steer: false }, { task: true, steer: true }]);
  expect(session.messages.findLast(message => message.role === 'assistant')?.stopReason).toBe('stop');
 } finally {
  if (session) { await session.abort(); session.dispose(); }
  await handle?.close();
  network.mockRestore();
  rmSync(dir, { recursive: true, force: true });
 }
});
