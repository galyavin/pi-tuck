import { scriptedModelRuntime } from './model-fixture';
import { expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import { createAssistantMessageEventStream, getCurrentSystemMessage, type AssistantMessage } from '@earendil-works/pi-ai';
import { convertToLlm, createAgentSession, DefaultResourceLoader, estimateTokens, SessionManager, SettingsManager, type AgentSession, type ExtensionAPI, type ExtensionContext, type SessionBeforeCompactEvent, type SessionEntry } from '@earendil-works/pi-coding-agent';
import { installCompaction, type CompactionOptions } from '../src/compaction';
import { bandOf } from '../src/budget';
import { serializeTranscript } from '../src/pi-tuck/core/transcript';
import { SUMMARY_SUFFIX } from '../src/pi-tuck/core/format';

// Window 272,000 and response reserve max(32,768, model.maxTokens 128,000) leave an input room of 144,000 estimated tokens.
export const ROOM = 144000, HOST = 6000;
export const BAND = bandOf(ROOM);
/** A host that declares its reply reserve exactly (C1): the room is the window less 32,768. */
export const EXACT_RESERVE = { requestReserve: () => ({ response: 32768, responseExact: true as const }) };
export const ROOM_EXACT = 272000 - 32768;
export const BAND_EXACT = bandOf(ROOM_EXACT);
/** The text of the provider's overflow error, as the probe observed it. */
export const OVERFLOW_TEXT = 'Your input exceeds the context window of this model. Please adjust your input and try again.';

type Messages = Parameters<typeof convertToLlm>[0];

// An independent reference for the arithmetic, written from Pi's own functions and not from budget.ts.
export const est = estimateTokens;
export const nonSystem = (messages: Messages) => convertToLlm(messages).reduce((sum, m) => sum + (m.role === 'system' ? 0 : estimateTokens(m)), 0);
/** The guard's system formula over the request's own messages. */
export function referenceGuardSystem(messages: Messages, prompt: string) {
 const system = getCurrentSystemMessage(convertToLlm(messages));
 return Math.max(system ? estimateTokens(system) : 0, estimateTokens({ role: 'system', content: prompt, toolsAdded: system?.toolsAdded, timestamp: 0 }));
}
/** The system part a trigger charges: the observed prompt and tools, or the guard's formula over the saved messages, whichever is larger. */
export function referenceSystemPart(saved: Messages, observedPrompt: string, toolsJson: string, guardPrompt = observedPrompt) {
 const tools = JSON.parse(toolsJson);
 return Math.max(estimateTokens({ role: 'system', content: observedPrompt, ...(tools.length ? { toolsAdded: tools } : {}), timestamp: 0 }), referenceGuardSystem(saved, guardPrompt));
}

export interface Unseen { growHost: (tokens: number) => void; setTools: (dormant: boolean) => void; steer: (tokens: number) => Promise<void>; }

export interface Options {
 /** Where the request that matters is made. */
 at: 'prompt' | 'tool' | 'impossible' | 'tool-impossible';
 /** The reference measure of that request, queued messages not included (host input, system part and conversation as the guard counts them). */
 complete: number;
 host: number;
 /** The saved conversation starts with a compaction summary (Pi wraps it when it converts it for the model). */
 summary?: boolean;
 /** Tokens of a steering message queued during the tool call, so it is in the next request but not in the saved conversation. */
 queued?: number;
 keepRecent?: number;
 /** One long user turn of distinct content (a cut keeps as much as the plan allows). */
 oneTurn?: boolean;
 /** Tool rounds before the final answer (tool boundary only). Rounds after the first add `laterResult` tokens. */
 rounds?: number;
 laterResult?: number;
 /** Tokens of the first tool result (tool boundary). Without `history`, the history before it holds the rest of `complete`, at least this much. */
 fresh?: number;
 /** Tokens of old history (tool boundary). With `fresh`, the user prompt grows to take the rest of `complete`: a prompt is protected from the cut, so only `history` can be cut away. */
 history?: number;
 /** With `summary`: the summary also quotes the opening request with a text of this many characters, and the opening request is then omitted
 * by a native context edit, so the model receives the summary without that record (the saved summary is larger than what is sent). */
 omitted?: number;
 /** With `summary`: the summary is in another format (a Pi default summary), which this compactor cannot filter. */
 foreign?: boolean;
 /** Called at every tool boundary before the compactor decides (the event and context are the compactor's own). */
 onBoundary?: (event: Parameters<Parameters<ExtensionAPI['on']>[1]> extends never ? never : any, ctx: ExtensionContext) => void;
 /** Called with every cut Pi asks for, before the compactor answers (the event and context are the compactor's own). */
 onBeforeCompact?: (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => void;
 /** The last saved entry is a compaction (Pi has nothing to compact at the prompt boundary: it reports "Already compacted"). The prompt takes the rest of `complete`. */
 compactedLast?: boolean;
 /** Tokens of each old history cycle (default 6000); small cycles make many tool calls. */
 cycleSize?: number;
 /** With `history` at the prompt: the prompt grows until the prompt and the system part make exactly this many tokens (`complete` is then ignored). */
 incoming?: number;
 /** A handler registered before the compactor cancels every cut Pi asks for (as the Steward's profile enforcement may). */
 cancelCompact?: boolean;
 /** Called after the compactor has taken its snapshot at each decision (0: the prompt; i: the i-th tool boundary), for growth the trigger cannot see. */
 afterDecision?: (index: number, api: Unseen) => void;
 /** An extra tool, registered but not active at first, whose description is this many tokens; `afterDecision` can switch it on and off. */
 dormant?: number;
 /** The first replies fail, one kind per request: a provider overflow error (the input exceeds the context window), or a length stop with a small output (below the model's maximum, so Pi counts it recoverable). Pi recovers by cutting and retrying once. */
 replies?: ('overflow' | 'length')[];
 /** Pi's `compaction.reserveTokens` setting (default 32,768). Pi's own usage threshold compacts above the window less this. */
 reserveTokens?: number;
 /** The first reply reports this many input tokens of usage (Pi's own threshold for compacting after a reply looks at it). */
 usageFirst?: number;
 /** The scripted replies report usage input = the guard's last measure times this ratio, so the calibration factor ratchets. */
 usageRatio?: number;
 /** Every scripted reply reports this many output tokens (reasoning included) beside its input usage. Pi's usage threshold counts them; the compactor's calibration does not. */
 outputTokens?: number;
 /** Characters appended to the system prompt, so that the rounding of its estimate can be walked through all four residues. */
 pad?: number;
 /** An extra tool whose description is this many tokens, active for the first request and deactivated by the first effect: the saved system
  * message still declares it, so the guard's system formula exceeds the observed prompt and tools. */
 ballast?: number;
 /** Called as each request is answered (after its guard): the host view may grow or the tool set may change here, for the next boundary to see. */
 onRequest?: (request: number, context: { setHost: (tokens: number) => void; pi: ExtensionAPI }) => void;
 compaction?: Partial<CompactionOptions>;
 compactionEnabled?: boolean;
}

export async function harness(options: Options) {
 const dir = mkdtempSync(join(tmpdir(), 'pi-host-input-')); let session: AgentSession | undefined;
 const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw Error('Unexpected HTTP'); });
 const cleanup = async () => { if (session) { await session.abort(); session.dispose(); } network.mockRestore(); rmSync(dir, { recursive: true, force: true }); };
 try {
  const runtime = await scriptedModelRuntime(), model = runtime.getModel('openai-codex', 'gpt-6.1-sol');
  if (!model) throw Error('Required catalogue model unavailable');
  expect(model.contextWindow - Math.max(32768, model.maxTokens)).toBe(ROOM);
  const manager = SessionManager.inMemory(dir), faults: string[] = [], notices: string[] = [];
  const answer = (content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage => ({ role: 'assistant', content, stopReason, api: model.api, provider: model.provider, model: model.id, timestamp: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } } });
  // Repeated text lets the compactor summarize almost everything away; unique text (oneTurn) makes the cut keep as much as the plan allows.
  let uniq = 0;
  const text = (n: number) => options.oneTurn ? Array.from({ length: Math.ceil(n * 4 / 24) }, () => `item ${(++uniq).toString(36)} data;`).join(' ').slice(0, n * 4) : 'Observed mechanical test data. '.repeat(Math.ceil(n * 4 / 31)).slice(0, n * 4);
  // A text whose tool-result message estimates to exactly n tokens by Pi's own estimator.
  const resultTokens = (t: string) => estimateTokens({ role: 'toolResult', toolCallId: 'x', toolName: 'effect', isError: false, timestamp: 0, content: [{ type: 'text', text: t }] });
  const fit = (n: number) => { let k = Math.max(1, n); for (let i = 0; i < 4; i++) k = Math.max(1, Math.round(k * n / resultTokens(text(k)))); return text(k); };
  let turns = 0;
  const cycle = (n: number) => {
   const id = `history-${++turns}`;
   manager.appendMessage({ role: 'user', content: `Earlier request ${turns}`, timestamp: 0 });
   manager.appendMessage(answer([{ type: 'toolCall', id, name: 'effect', arguments: {} }], 'toolUse'));
   manager.appendMessage({ role: 'toolResult', toolCallId: id, toolName: 'effect', isError: false, timestamp: 0, content: [{ type: 'text', text: fit(n) }] });
   manager.appendMessage(answer([{ type: 'text', text: 'Observed prior result' }]));
  };
  // One long user turn: only tool rounds after the opening request, so a cut has no earlier turn to drop and must cut inside the turn.
  const round = (n: number) => {
   const id = `history-${++turns}`;
   manager.appendMessage(answer([{ type: 'toolCall', id, name: 'effect', arguments: {} }], 'toolUse'));
   manager.appendMessage({ role: 'toolResult', toolCallId: id, toolName: 'effect', isError: false, timestamp: 0, content: [{ type: 'text', text: fit(n) }] });
  };
  const saved = () => manager.buildSessionProjection().messages;
  const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: options.compactionEnabled ?? true, reserveTokens: options.reserveTokens ?? 32768, keepRecentTokens: options.keepRecent ?? 0 } });
  const state = { requests: 0, effects: 0, delivered: false, hostCalls: 0, aborts: 0 };
  let bigResult = 1, bigText = 'x', host = options.host;
  const guard: number[] = [], cutsAtRequest: number[] = [], cutsAtProbe: number[] = [];
  const note = 'Queued operator note. ';
  const systemPrompt = 'Host input contact. ' + text(12000) + 'p'.repeat(options.pad ?? 0);
  // The host's view can grow during a run (attempt effects are recorded in it).
  const exact = (n: number) => { const t = text(n); return t.length >= n * 4 ? t.slice(0, n * 4) : t + 'z'.repeat(n * 4 - t.length); };
  const hostInput = () => ({ role: 'custom' as const, customType: 'host.view', content: exact(host), display: false, timestamp: 0 });
  const probes: { at: string; complete: number; queued: number }[] = [];
  let extension: ExtensionAPI | undefined;
  const activeToolsJson = () => JSON.stringify(extension!.getAllTools().filter(t => extension!.getActiveTools().includes(t.name)).map(t => ({ name: t.name, description: t.description, parameters: t.parameters })));
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings, noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true, systemPrompt, extensionFactories: [async pi => {
   extension = pi;
   if (options.cancelCompact) pi.on('session_before_compact', () => ({ cancel: true }));
   if (options.onBeforeCompact) pi.on('session_before_compact', (event, ctx) => { options.onBeforeCompact!(event, ctx); });
   // The host's per-request view: present in every request, never in the saved conversation.
   pi.on('context', event => ({ messages: [hostInput(), ...event.messages.filter(m => !(m.role === 'custom' && m.customType === 'host.view'))] }));
   // Probes only (registered before the compactor's hooks): the complete request as the guard will count it, from Pi's own functions.
   const toolsJson = () => JSON.stringify(pi.getAllTools().filter(t => pi.getActiveTools().includes(t.name)).map(t => ({ name: t.name, description: t.description, parameters: t.parameters })));
   const hostTokens = () => nonSystem([hostInput()]);
   pi.on('before_agent_start', (event, ctx) => { cutsAtProbe.push(manager.getEntries().filter(e => e.type === 'compaction').length); const messages = saved(); probes.push({ at: 'prompt', queued: 0, complete: estimateTokens({ role: 'user', content: event.prompt, timestamp: 0 }) + referenceSystemPart(messages, event.systemPrompt, toolsJson(), ctx.getSystemPrompt()) + hostTokens() + nonSystem(messages) }); });
   pi.on('turn_end', (event, ctx) => { if (event.toolResults.length) options.onBoundary?.(event, ctx); });
   pi.on('turn_end', (event, ctx) => { if (event.toolResults.length) cutsAtProbe.push(manager.getEntries().filter(e => e.type === 'compaction').length); if (event.toolResults.length) probes.push({ at: 'tool', queued: nonSystem(event.context.pendingMessages as Messages), complete: referenceSystemPart(event.context.contextMessages, ctx.getSystemPrompt(), toolsJson()) + hostTokens() + nonSystem(event.context.contextMessages) }); });
   await installCompaction(pi, {
    requestReserve: () => ({ response: 32768 }),
    hostMessages: () => { state.hostCalls++; return [hostInput()]; },
    fail: e => faults.push(String(e) + (process.env.BUDGET_TRACE ? ' @ ' + String((e as Error).stack).split('\n').slice(1, 4).join(' | ') : '')), settings,
    ...options.compaction,
   });
   // Unseen growth: after the compactor has decided, before the next request is made.
   if (options.afterDecision) {
    let decisions = 0;
    const unseen: Unseen = { growHost: tokens => { host += tokens; }, setTools: dormant => { pi.setActiveTools(dormant ? ['effect', 'dormant'] : ['effect']); }, steer: async tokens => { await session!.steer(note + exact(tokens - 6)); } };
    pi.on('before_agent_start', () => { options.afterDecision!(decisions++, unseen); });
    pi.on('turn_end', event => { if (event.toolResults.length) options.afterDecision!(decisions++, unseen); });
   }
   // The guard's number for every request, computed independently (registered after the compactor's hook).
   pi.on('context_with_system', (event, ctx) => { guard.push(referenceGuardSystem(event.messages, ctx.getSystemPrompt()) + nonSystem(event.messages)); cutsAtRequest.push(manager.getEntries().filter(e => e.type === 'compaction').length); });
  }] });
  await loader.reload(); expect(loader.getExtensions().errors).toEqual([]);
  ({ session } = await createAgentSession({ cwd: dir, modelRuntime: runtime, model, thinkingLevel: 'low', sessionManager: manager, settingsManager: settings, resourceLoader: loader, tools: options.ballast ? ['effect', 'ballast'] : ['effect'], customTools: [...(options.dormant ? [{ name: 'dormant', label: 'Dormant', description: 'Dormant tool. ' + text(options.dormant), parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) }] : []), ...(options.ballast ? [{ name: 'ballast', label: 'Ballast', description: 'Ballast tool. ' + text(options.ballast), parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) }] : []), {
   name: 'effect', label: 'Effect', description: 'Local effect witness', parameters: Type.Object({}),
   execute: async () => {
    state.effects++;
    if (options.ballast && state.effects === 1) extension!.setActiveTools(['effect']);
    if (options.queued) await session!.steer(note + exact(options.queued - 6)); // the note's 22 characters are 6 tokens: the message is exactly `queued` tokens
    // The tool-boundary scenarios grow the conversation by the amount that lands the next request exactly where the case asks.
    if (options.at === 'tool' && state.effects === 1) {
     const have = referenceSystemPart(saved(), session!.systemPrompt, activeToolsJson()) + nonSystem([hostInput()]) + nonSystem(saved());
     bigResult = Math.max(1, options.complete - have); bigText = fit(bigResult);
    }
    return { content: [{ type: 'text', text: bigText }], details: {} };
   },
  }] }));
  // Notices to the operator (a warning when a cut cannot be made, advice on a capacity failure); every other UI call is a no-op.
  const ui = new Proxy({ notify: (message: string) => { notices.push(message); } }, { get: (target, key) => key in target ? (target as never)[key] : () => undefined });
  // ctx.abort() reaches Pi through this handler, so a test can see whether the compactor aborted the run.
  await session.bindExtensions({ uiContext: ui as never, abortHandler: () => { state.aborts++; void session!.abort(); } });
  const initialTools = JSON.parse(activeToolsJson());
  const mandatory = estimateTokens({ role: 'system', content: session.systemPrompt, ...(initialTools.length ? { toolsAdded: initialTools } : {}), timestamp: 0 });
  const opening = manager.appendMessage({ role: 'user', content: 'Opening task', timestamp: 0 });
  // A previous compaction: the saved conversation starts with a summary message that Pi wraps when it converts it for the model.
  if (options.summary) {
   const records: Parameters<typeof serializeTranscript>[0] = [{ kind: 'omission', reason: 'Earlier work, summarized. ' + text(800) }];
   if (options.omitted) records.unshift({ kind: 'excerpt', role: 'user', sourceIndex: 0, text: 'o'.repeat(options.omitted) });
   manager.appendCompaction(options.foreign ? '## Goal\nA default Pi summary written by a model. ' + text(800) : serializeTranscript(records) + SUMMARY_SUFFIX, opening, 1000, { compactor: 'pi-tuck', version: 2, adapter: 'standalone', keptUserTurns: 0 }, true);
   if (options.omitted) manager.appendContextEdit(opening, null);
  }
  // History up to the request the case asks for. At the tool boundary the last tool result is sized when the tool runs.
  let promptText = 'Continue';
  const promptTokens = () => estimateTokens({ role: 'user', content: promptText, timestamp: 0 });
  const target = options.at === 'prompt' ? options.complete : options.at === 'tool' ? options.complete - (options.fresh ?? 3000) : 20000;
  const historyComplete = () => promptTokens() + referenceSystemPart(saved(), session!.systemPrompt, activeToolsJson()) + nonSystem([hostInput()]) + nonSystem(saved());
  const sizeFor = options.oneTurn ? 1000 : options.cycleSize ?? 6000, slack = sizeFor + 500;
  if (options.at === 'tool' && options.history !== undefined) for (let left = options.history; left > 0; left -= sizeFor) options.oneTurn ? round(Math.min(sizeFor, left)) : cycle(Math.min(sizeFor, left));
  else if (!(options.at === 'prompt' && options.history !== undefined)) while (historyComplete() + slack < target) options.oneTurn ? round(sizeFor) : cycle(sizeFor);
  if (options.at === 'prompt' && options.compactedLast) {
   // The compaction keeps everything after the opening request, so the saved conversation is large and the last saved entry is the compaction.
   manager.appendCompaction(serializeTranscript([{ kind: 'omission', reason: 'Earlier work, summarized.' }]) + SUMMARY_SUFFIX, opening, 1000, { compactor: 'pi-tuck', version: 2, adapter: 'standalone', keptUserTurns: 0 }, true);
   // The prompt carries the rest, so the last saved entry stays the compaction.
   const rest = options.complete - historyComplete();
   expect(rest).toBeGreaterThanOrEqual(0);
   promptText = 'Continue' + 'q'.repeat(rest * 4);
   expect(historyComplete()).toBe(options.complete);
  } else if (options.at === 'prompt' && options.history !== undefined) {
   for (let left = options.history; left > 0; left -= sizeFor) cycle(Math.min(sizeFor, left));
   if (options.incoming !== undefined) {
    // The prompt and the system part together make `incoming` tokens.
    const system = referenceSystemPart(saved(), session!.systemPrompt, activeToolsJson()), words = options.incoming - system - 2;
    expect(words).toBeGreaterThan(0);
    promptText = 'Continue' + 'q'.repeat(words * 4);
    expect(promptTokens() + system).toBe(options.incoming);
   } else {
    // The prompt carries the rest of the request; it is protected from every cut.
    const rest = options.complete - historyComplete();
    expect(rest).toBeGreaterThan(0);
    promptText = 'Continue' + 'q'.repeat(rest * 4);
    expect(historyComplete()).toBe(options.complete);
   }
  } else if (options.at === 'prompt') {
   // Land the incoming request exactly: a filler message of the remaining tokens.
   const gap = options.complete - historyComplete() - 60;
   if (gap > 0) options.oneTurn ? round(gap) : cycle(gap);
   const rest = options.complete - historyComplete();
   if (rest > 0) manager.appendMessage(answer([{ type: 'text', text: 'y'.repeat(rest * 4) }]));
   expect(historyComplete()).toBe(options.complete);
  } else if (options.at === 'tool-impossible') { bigResult = 100; bigText = text(100); }
  else if (options.at === 'tool' && options.history !== undefined && options.fresh !== undefined) {
   // The prompt carries the rest: 2 tokens for the tool call that follows it, then the first tool result of `fresh` tokens.
   const rest = options.complete - historyComplete() - 2 - options.fresh;
   expect(rest).toBeGreaterThan(0);
   promptText = 'Continue ' + 'q'.repeat(rest * 4);
  }
  const cutsBefore = manager.getEntries().filter(e => e.type === 'compaction').length;
  const rounds = options.rounds ?? 1;
  session.agent.streamFunction = (_m, _ctx, streamOptions) => {
   if (streamOptions?.signal?.aborted) { const m = answer([], 'aborted'); const s = createAssistantMessageEventStream(); s.push({ type: 'error', reason: 'aborted', error: m }); s.end(m); return s; }
   state.requests++;
   if (state.requests === 2) state.delivered = JSON.stringify(_ctx.messages).includes(note);
   options.onRequest?.(state.requests, { setHost: tokens => { host = tokens; }, pi: extension! });
   // After the first round the host view outgrows the room by itself: no cut can help from then on.
   if (options.at === 'tool-impossible' && state.requests === 1) host = ROOM + 20000;
   const toolRound = (options.at === 'tool' || options.at === 'tool-impossible') && state.requests <= rounds;
   if (toolRound && state.requests > 1) { bigText = text(options.laterResult ?? 100); }
   const stream = createAssistantMessageEventStream();
   const failing = options.replies?.[state.requests - 1];
   if (failing) {
    // Pi ignores a reply that is not newer than the last cut.
    const cutAt = manager.getEntries().reduce((latest, e) => e.type === 'compaction' ? Math.max(latest, Date.parse(e.timestamp)) : latest, 0);
    const failed = failing === 'length' ? answer([{ type: 'text', text: 'A reply cut short' }], 'length') : answer([], 'error');
    if (failing === 'overflow') failed.errorMessage = OVERFLOW_TEXT; else failed.usage.output = failed.usage.totalTokens = 2048;
    failed.timestamp = Math.max(Date.now(), cutAt + 1);
    if (failing === 'length') stream.push({ type: 'done', reason: 'length', message: failed }); else stream.push({ type: 'error', reason: 'error', error: failed });
    stream.end(failed); return stream;
   }
   const message = answer(toolRound ? [{ type: 'toolCall', id: `boundary-effect-${state.requests}`, name: 'effect', arguments: {} }] : [{ type: 'text', text: 'Finished' }], toolRound ? 'toolUse' : 'stop');
   if (options.usageFirst !== undefined && state.requests === 1) { message.usage.input = options.usageFirst; message.usage.totalTokens = options.usageFirst; }
   if (options.usageRatio !== undefined && guard.length) { message.usage.input = Math.ceil(guard.at(-1)! * options.usageRatio); message.usage.totalTokens = message.usage.input; }
   if (options.outputTokens !== undefined) { message.usage.output = options.outputTokens; message.usage.totalTokens += options.outputTokens; }
   stream.push({ type: 'done', reason: toolRound ? 'toolUse' : 'stop', message }); stream.end(message); return stream;
  };
  const compactions = () => manager.getEntries().filter((e): e is Extract<SessionEntry, { type: 'compaction' }> => e.type === 'compaction').slice(cutsBefore);
  return {
   dir, manager, session, state, faults, notices, probes, guard, saved, promptTokens, cleanup, compactions, answer, text, fit, cycle, round, setHost: (tokens: number) => { host = tokens; }, hostInput, extension: () => extension!, mandatory,
   async run() {
    await session!.prompt(promptText);
    const cuts = compactions().length, kept = nonSystem(saved());
    const measured = probes.find(p => p.at === (options.at === 'tool' ? 'tool' : 'prompt'));
    expect(network).not.toHaveBeenCalled();
    return { cuts, requests: state.requests, effects: state.effects, faults, measured, delivered: state.delivered, kept, hostCalls: state.hostCalls, guard, entries: compactions(), notices, probes, cutsAtRequest, cutsAtProbe, system: mandatory, aborts: state.aborts, last: session!.messages.findLast(m => m.role === 'assistant') as AssistantMessage | undefined,
     probe: JSON.stringify({ ...options, onRequest: undefined, compaction: undefined, mandatory, saved: nonSystem(saved()), bigResult, probes, guard, cuts, requests: state.requests, effects: state.effects, faults, aborts: state.aborts, delivered: state.delivered, hostCalls: state.hostCalls }) };
   },
  };
 } catch (error) { await cleanup(); throw error; }
}

export async function scenario(options: Options) {
 const h = await harness(options);
 try { return await h.run(); } finally { await h.cleanup(); }
}

/** The settings a cut recorded about its own arithmetic (diagnostics.ts), and the view and mode of its summary. */
export function receiptOf(entry: Extract<SessionEntry, { type: 'compaction' }>) {
 const details = entry.details as { tokensAfter: number; view: string; mode: string; diagnosticReceipt: { reason: string; settings: { draftReservedTokens: number; hostInputTokens?: number; mandatoryInputTokens?: number; target?: 'band' | 'room'; triggerMarginTokens?: number; responseReserveTokens?: number; calibrationFactor?: number; calibrationWindow?: number[]; calibrationIdentity?: string } } };
 return { ...details.diagnosticReceipt.settings, reason: details.diagnosticReceipt.reason, tokensAfter: details.tokensAfter, view: details.view, mode: details.mode };
}

export const WINDOW = 272000;
/**
 * The arithmetic of one cut, to the token. The request after it is counted by the guard from Pi's own functions; it must be exactly what the
 * planner said it would be (the draft's conversation plus the mandatory input the trigger charged), and the planner must have reserved,
 * for the target it chose, exactly the window less that target plus that mandatory input. Valid when nothing unseen grew in between.
 */
export function expectParity(result: { entries: Extract<SessionEntry, { type: 'compaction' }>[]; guard: number[]; cutsAtRequest: number[]; probe: string; system: number }, mandatory: { host: number; incoming?: number; queued?: number; system?: number }, limits: { room: number; band: number } = { room: ROOM, band: BAND }, factor = 1) {
 const { entries, guard, cutsAtRequest, probe } = result;
 const expected = (mandatory.system ?? result.system) + mandatory.host + (mandatory.incoming ?? 0) + (mandatory.queued ?? 0);
 for (const entry of entries) {
  const r = receiptOf(entry);
  expect(r.mandatoryInputTokens, probe).toBe(expected);
  expect(r.hostInputTokens, probe).toBe(mandatory.host);
  expect(r.triggerMarginTokens, probe).toBe(limits.room - limits.band);
  expect(r.draftReservedTokens, probe).toBe(WINDOW - Math.floor((r.target === 'band' ? limits.band : limits.room) / factor) + expected);
 }
 if (entries.length === 1) {
  // The first request made after the cut.
  const first = cutsAtRequest.findIndex(n => n >= 1);
  expect(first, probe).toBeGreaterThanOrEqual(0);
  // The trigger's system part is the larger of two formulas that round differently, so it may exceed the guard's by a token or two, never fall short.
  const planned = receiptOf(entries[0]!).tokensAfter + expected;
  expect(planned - guard[first]!, probe + ` planned ${planned}`).toBeGreaterThanOrEqual(0);
  expect(planned - guard[first]!, probe + ` planned ${planned}`).toBeLessThanOrEqual(2);
 }
}
