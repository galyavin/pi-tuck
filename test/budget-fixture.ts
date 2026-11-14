import { createHash } from 'node:crypto';
import { scriptedModelRuntime } from './model-fixture';
import { expect, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import { createAssistantMessageEventStream, getCurrentSystemMessage, type AssistantMessage, type Usage } from '@earendil-works/pi-ai';
import { convertToLlm, createAgentSession, DefaultResourceLoader, estimateTokens, SessionManager, SettingsManager, type AgentSession, type ExtensionAPI, type ExtensionContext, type SessionBeforeCompactEvent, type SessionEntry } from '@earendil-works/pi-coding-agent';
import { installCompaction, type CompactionOptions } from '../src/compaction';
import { bandOf } from '../src/budget';
import { serializeTranscript } from '../src/tuck/core/transcript';
import { DIALOGUE_SUFFIX } from '../src/tuck/core/format';
import { providerRequest } from './request-options';
import { estimateContextTokens } from '@earendil-works/pi-ai/utils/estimate';

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
/** How many messages a projection carries, on the same conversion `nonSystem` weighs, so two views of one session can be counted alike. */
export const nonSystemCount = (messages: Messages) => convertToLlm(messages).filter(m => m.role !== 'system').length;
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
 /** Avoid Vitest's global spy retention when a stress dimension creates thousands of model runtimes. */
 trackRuntimeSpies?: boolean;
 /** Apply Pi's actual SimpleStreamOptions and capped OpenAI payload builders before the scripted server answers. */
 piRequestPath?: boolean;
 /** Keep the scripted provider and host/probes, but do not install pi-tuck. Native Pi owns all cuts. */
 plainPi?: boolean;
 /** Start a fresh AgentSession from a saved branch, including learned-budget receipts. */
 branch?: SessionEntry[];
 /** Capture normalized request hashes only for comparisons that need them. */
 fingerprintWire?: boolean;
 /** A scripted provider context-overflow error on a particular request, independent of Pi's output clamp. */
 providerOverflowAt?: (request: number) => boolean;
 /** Install with no cutAt, so the compactor's own default cut point applies; otherwise the harness pins cutAt 1 unless `compaction` sets it. */
 cutAtDefault?: boolean;
 /** Where the request that matters is made. */
 at: 'prompt' | 'tool' | 'impossible' | 'tool-impossible';
 /** The reference measure of that request, queued messages not included (host input, system part and conversation as the guard counts them). */
 complete: number;
 host: number;
 /** The saved conversation starts with a compaction summary (Pi wraps it when it converts it for the model). */
 summary?: boolean;
 /** With `summary`: the cut kept nothing, so the summary alone is the conversation (its `firstKeptEntryId` is empty). At a prompt the prompt
  * then carries the whole request; `incoming` sizes it, else it takes the rest of `complete`. */
 summaryOnly?: boolean;
 /** Build no history and do no prompt sizing: the caller drives the session itself, prompt by prompt. */
 noHistory?: boolean;
 /** Seed no opening user turn: the session's first user turn is the case's first prompt. */
 noOpening?: boolean;
 /** Answer request N with a tool call rather than a final text, so the run keeps going after the first request. */
 toolCalls?: (request: number) => boolean;
 /** The size of the Nth tool result, so one run can grow by mixed amounts. */
 toolResultTokens?: (call: number) => number;
 /** Request N never answers: the stream stays open, as a stalled provider's does, until the turn is aborted. */
 neverEnds?: (request: number) => boolean;
 /** Tokens of reply streamed to a stalling request before the transport went quiet. An aborted reply is saved with what arrived, so this is the
  * content a run leaves on the session when its last request dies: the conversation it crosses the room on, with no run-end cut to tidy it. */
 stallChars?: (request: number) => number;
 /** Characters of thinking on the reply to request N, as a model that replays its reasoning sends them. */
 thinkingChars?: (request: number) => number;
 /** Exhaust the real Pi request cap with thinking only, with no text or tool call. */
 thinkingOnlyLength?: (request: number) => boolean;
 /** Another extension, present beside the compactor: it appends N boundary entries at every turn end. */
 turnEndEntries?: number;
 /** A host extension that patches a system-prompt section in `before_agent_start`, as an engine adds the current iteration's packet: called with the
  * run's number, it returns the section's size in tokens to set from this run on, null to remove it, or undefined to leave it as it is. */
 systemSection?: (run: number) => number | null | undefined;
 /** Register that host extension after the compactor instead of before it. */
 systemSectionLate?: boolean;
 /** Inspect the scripted transport context without changing it. */
 onWire?: (context: unknown) => void;
 /** Stable host text for replay comparisons; ordinary stress keeps its changing host witness. */
 stableHost?: boolean;
 /** Observe pi-tuck refusals without changing their handling. */
 onFailure?: (error: unknown) => void;
 /** Another model from the catalogue, for a case that depends on which API it uses. */
 model?: { provider: string; id: string };
 /** Persist the session to a file, then close it and open it again: the caller starts from a saved session. */
 reopen?: boolean;
 /** Persist the session to a file as it runs, but do not reopen it: a case that reads the saved file back at the end needs a persisted session,
  * and the run itself stays a first-open one. What reaches the disk is the same either way; only the file is new. */
 persist?: boolean;
 /** Tokens of the fixture summary's own text (default 800). */
 summaryTokens?: number;
 /** Seed a previous summary and a tail of complete user/tool turns for long-running session tests. */
 seededTail?: { summary: number; tail: number; cycle: number };
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
 /** Called at every idle prompt before the compactor decides its cut (the context is the compactor's own). */
 onPrompt?: (ctx: ExtensionContext) => void;
 /** The last saved entry is a compaction (Pi has nothing to compact at the prompt boundary: it reports "Already compacted"). The prompt takes the rest of `complete`. */
 compactedLast?: boolean;
 /** Tokens of each old history cycle (default 6000); small cycles make many tool calls. */
 cycleSize?: number;
 /** With `history` at the prompt: the prompt grows until the prompt and the system part make exactly this many tokens (`complete` is then ignored). */
 incoming?: number;
 /** A handler registered before the compactor cancels every cut Pi asks for (as another extension's policy may). */
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
 /** A provider that enforces its own window: when the count its tokenizer makes of a request (the guard's measure times `usageRatio`, or the
  * measure itself when that ratio is not a finite number above 0) exceeds the model's window, the request is refused with the overflow error
  * instead of answered. Density above 1 then meets the window, and Pi's overflow recovery runs. */
 rejectOverWindow?: boolean;
 /** Physical server capacity when the catalogue's configured context window is wrong. */
 providerWindow?: number;
 /** A provider that reports no usage at all: the reply carries no usage object for pi-tuck to calibrate against. */
 noUsage?: boolean;
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
 /** Isolate final capacity/projection arithmetic: native auto-cuts and pi-tuck's planners are absent, while the guard remains active. */
 guardOnly?: boolean;
 /** The model's window and maximum output when they are not the 272,000 and 128,000 the pins assume (a small-room test). The fixture then does not check the room. */
 limits?: { contextWindow: number; maxTokens: number };
 /** Tokens of the system prompt (default 12,000, about the size of a real host's). Sized by the fixture's `text()`, which estimates to about 0.6 of the number, because its items are 13 characters and the estimator's length count assumes 24. */
 system?: number;
 /** Tokens of the system prompt, counted the way the guard counts them: text whose own estimate is the number given. A cell that names a setup uses this, so the setup a run carries is the setup the cell says it carries. */
 systemTokens?: number;
 /** The wording a request over the window comes back with, as the provider in question words its refusal. */
 rejectWith?: string | ((request: { prompt: number; maxTokens: number; window: number }) => string);
 /** The HTTP status the transport reports beside that wording (a gateway's bodyless 413 carries none). */
 rejectStatus?: number;
 /** A server that does not refuse an oversize request: it keeps the end of it and answers as if nothing had happened. 'stop' reports input usage
  * equal to the window; 'lengthZero' is the variant Pi lists for Xiaomi, a stop at length, no output, and the window reported as input. */
 truncateOverWindow?: 'stop' | 'lengthZero';
 /** A provider that enforces prompt + catalogue output cap, or emits a cap-sized reply clipped at the physical window end. */
 replyWindow?: 'refuse' | 'clip';
 /** A transient provider error (HTTP 503, not a context overflow) on these requests. */
 transientErrorAt?: (request: number) => boolean;
 /** Output attempted by the clipping provider on each final answer (defaults to the catalogue cap). */
 replyWindowOutput?: (request: number) => number;
 /** Tokens of the assistant reply's own text, per request. A tool call that carries a large body is a fresh message no cut can drop and no clip may
  * shrink, so it overflows the room in a different way from a fresh result: the cut that answers it has already happened. */
 /** A reply whose own text is this many tokens, on top of its tool call. */
 replyTokens?: (request: number) => number;
 /** The usage request N reports, overriding the density and the other usage options: a count that jumps for one reply, no input at all beside a
  * large cache read, or cached tokens counted twice. */
 usageAt?: (request: number, measured: number) => Partial<Usage>;
 /** Every tool a live session carries is active: Pi's read, bash, edit and write, and pi-tuck's own two, beside the fixture's `effect`. */
 liveTools?: boolean;
}

/** Pi's system prompt carries the session directory, so budgets pinned here assume a macOS-length $TMPDIR (48 characters). A shorter one,
 * such as Linux's /tmp, is padded to that length so the same pins hold on any runner; a longer one is used as it is. */
const REFERENCE_TMPDIR = 48;
function sessionBase() {
 const base = tmpdir();
 if (base.length >= REFERENCE_TMPDIR) return base;
 const padded = join(base, 'p'.repeat(REFERENCE_TMPDIR - base.length - 1));
 mkdirSync(padded, { recursive: true });
 return padded;
}

export async function harness(options: Options) {
 // Physical-window recovery compares replies with compaction timestamps. Keep Date deterministic for these cells, advancing at each
 // provider response; real timers still drive the prompt watchdog. Otherwise a fast retry can fall on either side of a millisecond boundary.
 const physicalClock = options.providerWindow !== undefined;
 if (physicalClock) { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-01-01T00:00:00.001Z')); }
 // A timestamp on an exact second is written 4 characters shorter (source-time.ts), which moves a summary by a token. Tests that walk a cut's edge
 // token by token must not depend on the clock, so a message is never stamped on an exact second here.
 const realNow = Date.now;
 Date.now = () => { const now = realNow(); return now % 1000 ? now : now + 1; };
 const dir = mkdtempSync(join(sessionBase(), 'pi-host-input-')); let session: AgentSession | undefined;
 const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw Error('Unexpected HTTP'); });
 const cleanup = async () => { Date.now = realNow; if (physicalClock) vi.useRealTimers(); if (session) { await session.abort(); session.dispose(); } network.mockRestore(); rmSync(dir, { recursive: true, force: true }); };
 try {
  const runtime = await scriptedModelRuntime(options.limits, options.model, options.trackRuntimeSpies), model = runtime.getModel(options.model?.provider ?? 'openai-codex', options.model?.id ?? 'gpt-6.1-sol');
  if (!model) throw Error('Required catalogue model unavailable');
  if (!options.limits && !options.model) expect(model.contextWindow - Math.max(32768, model.maxTokens)).toBe(ROOM);
  // A reopened session has to be a persisted one, so its entries reach a file and come back from it. `persist` stops short of the reopen: the file
  // exists, the run never leaves it.
  let manager = options.reopen || options.persist ? SessionManager.create(dir, dir) : SessionManager.inMemory(dir), faults: string[] = [], notices: string[] = [];
  if (options.branch) manager = SessionManager.inMemory(dir, undefined, [manager.getHeader()!, ...options.branch]);
  // A complete assistant message of this content. `replyOf` builds one without recording it, for measuring a reply that has not been sent yet.
  const replyOf = (content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage => ({ role: 'assistant', content, stopReason, api: model.api, provider: model.provider, model: model.id, timestamp: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } } });
  const answer = (content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage => { state.stops.push(stopReason); return replyOf(content, stopReason); };
  // Repeated text lets the compactor summarize almost everything away; unique text (oneTurn) makes the cut keep as much as the plan allows.
  let uniq = 0;
  const text = (n: number) => options.oneTurn ? Array.from({ length: Math.ceil(n * 4 / 24) }, () => `item ${(++uniq).toString(36)} data;`).join(' ').slice(0, n * 4) : 'Observed mechanical test data. '.repeat(Math.ceil(n * 4 / 31)).slice(0, n * 4);
  // A text whose tool-result message estimates to exactly n tokens by Pi's own estimator.
  const fit = (n: number) => { let k = Math.max(1, n); for (let i = 0; i < 4; i++) k = Math.max(1, Math.round(k * n / resultTokens(text(k)))); return text(k); };
  // Text whose own estimate is exactly `n` tokens: Pi counts a text-only message as ceil(characters / 4), so this is 4n characters of distinct
  // content. `text(n)` under-sizes a prompt to about 0.6n, because its items are 13 characters and the estimator's length count assumes 24.
  const sized = (n: number) => { const want = Math.max(0, Math.round(n) * 4); let s = ''; while (s.length < want) s += `item ${(++uniq).toString(36)} data; `; return s.slice(0, want); };
  const resultTokens = (t: string) => estimateTokens({ role: 'toolResult', toolCallId: 'x', toolName: 'effect', isError: false, timestamp: 0, content: [{ type: 'text', text: t }] });
  let turns = 0;
  // One long user turn: only tool rounds after the opening request, so a cut has no earlier turn to drop and must cut inside the turn.
  const round = (n: number) => {
   const id = `history-${++turns}`;
   manager.appendMessage(answer([{ type: 'toolCall', id, name: 'effect', arguments: {} }], 'toolUse'));
   manager.appendMessage({ role: 'toolResult', toolCallId: id, toolName: 'effect', isError: false, timestamp: 0, content: [{ type: 'text', text: fit(n) }] });
  };
  const cycle = (n: number) => {
   manager.appendMessage({ role: 'user', content: `Earlier request ${turns + 1}`, timestamp: 0 });
   round(n);
   manager.appendMessage(answer([{ type: 'text', text: 'Observed prior result' }]));
  };
  const saved = () => manager.buildSessionProjection().messages;
  const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: options.guardOnly ? false : options.compactionEnabled ?? true, reserveTokens: options.reserveTokens ?? 32768, keepRecentTokens: options.keepRecent ?? 0 } });
  // stops records the stop reason of every reply the scripted model handed back, in order, so a caller can tell what one of its own prompts got.
  // counts records, per request, what the provider's tokenizer makes of it and whether a reply before it had reported usage (so density was known);
  // overflows counts the requests the provider refused for size; vetoes the cuts another extension cancelled.
  // clips counts the requests that went out with a clipped fresh result in them, which is pi-tuck's own doing and visible nowhere but on the wire;
  // cutCounts records, per request, the compactions saved by then, so a caller can see which request a cut answered and whether the next one cut too;
  // assistantSizes is each reply's own content by request number, since a fresh assistant message is a size no cut and no clip can reach.
  let nativeSummarizing = false, nativeBefore = 0, nativeReason = '';
  const providerRequests: { summary: boolean; measuredPrompt: number; prompt: number; maxTokens: number; availableOutput: number; output: number; refused: boolean; length: boolean }[] = [];
  const state = { nativeSummaries: [] as Awaited<ReturnType<typeof providerRequest>>[], nativeCuts: [] as { afterRequest: number; reason: string; before: number; after: number; freed: number }[], requestFingerprints: [] as string[], clampEvents: [] as { request: number; wanted: number; cap: number }[], requestOptions: [] as Awaited<ReturnType<typeof providerRequest>>[], clampStops: 0, requestStates: [] as string[], requests: 0, effects: 0, delivered: false, hostCalls: 0, aborts: 0, stops: [] as string[], results: [] as number[], resultAt: [] as number[], replies: [] as number[], counts: [] as { count: number; known: boolean }[], reports: 0, nonFinite: 0, overflows: 0, truncations: 0, compacts: 0, vetoes: 0, clips: 0, cutCounts: [] as number[], assistantSizes: [] as number[], answers: [] as AssistantMessage[] };
  let bigResult = 1, bigText = 'x', host = options.host;
  const wholePrompt: boolean[] = [];
  const guard: number[] = [], cutsAtRequest: number[] = [], cutsAtProbe: number[] = [];
  const note = 'Queued operator note. ';
  const systemPrompt = 'Host input contact. ' + (options.systemTokens !== undefined ? sized(options.systemTokens) : text(options.system ?? 12000)) + 'p'.repeat(options.pad ?? 0);
  // The host's view can grow during a run (attempt effects are recorded in it).
  const exact = (n: number) => sized(n);
  const hostTexts = new Map<number, string>();
  let latestHostInput: { role: 'custom'; customType: string; content: string; display: boolean; timestamp: number } | undefined;
  const hostInput = () => {
   if (options.stableHost && !hostTexts.has(host)) hostTexts.set(host, exact(host));
   return latestHostInput = { role: 'custom' as const, customType: 'host.view', content: options.stableHost ? hostTexts.get(host)! : exact(host), display: false, timestamp: 0 };
  };
  // The request as Pi would build it, measured before the compactor is asked anything (these hooks are registered before the compactor's), with
  // the number of requests already answered. A case that needs "the request before any cut" reads this, not the guard's post-cut measure.
  const probes: { after: number; at: string; complete: number; queued: number }[] = [];
  let atRunEnd: { hostCalls: number; kept: number } | undefined;
  let extension: ExtensionAPI | undefined;
  const activeToolsJson = () => JSON.stringify(extension!.getAllTools().filter(t => extension!.getActiveTools().includes(t.name)).map(t => ({ name: t.name, description: t.description, parameters: t.parameters })));
  let install = installCompaction;
  const extensionObservers: ((pi: ExtensionAPI) => void)[] = [];
  // These counters belong to the scripted host, whose remaining scenario must be identical on both sides of a resume.
  let sectionRun = 0, sectionText: string | undefined, decisions = 0;
  const makeLoader = () => new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings, noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true, systemPrompt, extensionFactories: [async pi => {
   extension = pi;
   if (options.cancelCompact) pi.on('session_before_compact', () => { state.vetoes++; return { cancel: true }; });
   // Another extension at the turn boundary: it appends entries that carry no content, as a plugin writing its own boundaries does.
   const addSection = () => {
    pi.on('before_agent_start', event => {
     const size = options.systemSection!(sectionRun++);
     if (size === null) sectionText = undefined; else if (size !== undefined) sectionText = sized(size);
     if (sectionText) event.systemPromptOptions.sections = { ...event.systemPromptOptions.sections, standoff: sectionText };
     else if (event.systemPromptOptions.sections) delete event.systemPromptOptions.sections.standoff;
    });
   };
   if (options.systemSection && !options.systemSectionLate) addSection();
   if (options.turnEndEntries) pi.on('turn_end', () => { for (let i = 0; i < options.turnEndEntries!; i++) pi.appendEntry(`stress-boundary-${i}`, { at: state.requests }); });
   const nativeComplete = (ctx: ExtensionContext) => referenceSystemPart(saved(), ctx.getSystemPrompt(), activeToolsJson()) + nonSystem([hostInput()]) + nonSystem(saved());
   pi.on('session_before_compact', (event, ctx) => {
    state.compacts++;
    if (options.plainPi) { nativeSummarizing = true; nativeBefore = nativeComplete(ctx); nativeReason = event.reason; }
    options.onBeforeCompact?.(event, ctx);
   });
   pi.on('session_compact', (_event, ctx) => {
    if (!options.plainPi) return;
    const after = nativeComplete(ctx);
    state.nativeCuts.push({ afterRequest: state.requests, reason: nativeReason, before: nativeBefore, after, freed: nativeBefore - after });
    nativeSummarizing = false;
   });
   pi.on('session_compact_failed', () => { nativeSummarizing = false; });
   // The host's per-request view: present in every request, never in the saved conversation.
   pi.on('context', event => ({ messages: [hostInput(), ...event.messages.filter(m => !(m.role === 'custom' && m.customType === 'host.view'))] }));
   // Probes only (registered before the compactor's hooks): the complete request as the guard will count it, from Pi's own functions.
   const toolsJson = () => JSON.stringify(pi.getAllTools().filter(t => pi.getActiveTools().includes(t.name)).map(t => ({ name: t.name, description: t.description, parameters: t.parameters })));
   const hostTokens = () => nonSystem([hostInput()]);
   // A prompt's decision is made on `input`, while the session is idle (Pi 1.4 counts the run as started at before_agent_start).
   let starting = false; // as the compactor does: a message sent while a run starts joins it (Pi 1.1 still reports idle then)
   pi.on('before_agent_start', () => { starting = true; }); pi.on('agent_start', () => { starting = false; }); pi.on('agent_settled', () => { starting = false; });
   pi.on('input', (event, ctx) => { if (!ctx.isIdle() || starting) return; options.onPrompt?.(ctx); cutsAtProbe.push(manager.getEntries().filter(e => e.type === 'compaction').length); const messages = saved(); probes.push({ after: state.requests, at: 'prompt', queued: 0, complete: estimateTokens({ role: 'user', content: event.text, timestamp: 0 }) + referenceSystemPart(messages, ctx.getSystemPrompt(), toolsJson(), ctx.getSystemPrompt()) + hostTokens() + nonSystem(messages) }); });
   pi.on('turn_end', (event, ctx) => { if (event.toolResults.length) options.onBoundary?.(event, ctx); });
   // The run's own measures, taken before the compactor's run-end cut (agent_before_settle), which `runEnd` reports apart.
   pi.on('agent_end', () => { atRunEnd = { hostCalls: state.hostCalls, kept: nonSystem(saved()) }; });
   pi.on('turn_end', (event, ctx) => { if (event.toolResults.length) cutsAtProbe.push(manager.getEntries().filter(e => e.type === 'compaction').length); if (event.toolResults.length) probes.push({ after: state.requests, at: 'tool', queued: nonSystem(event.context.pendingMessages as Messages), complete: referenceSystemPart(event.context.contextMessages, ctx.getSystemPrompt(), toolsJson()) + hostTokens() + nonSystem(event.context.contextMessages) }); });
   // The trigger and guard tests pin the band at cutAt 1 (the room less the margin); a test of another cut point sets it in `compaction`,
   // and `cutAtDefault` leaves it to the compactor's default.
   const plannerEvents = new Set(['input', 'before_agent_start', 'agent_start', 'turn_end', 'agent_before_settle']);
   const compactorAPI = options.guardOnly ? { ...pi, on: ((name: string, handler: any) => { if (!plannerEvents.has(name)) (pi.on as any)(name, handler); }) as ExtensionAPI['on'] } : pi;
   if (!options.plainPi) await install(compactorAPI, {
    // The response reserve is Pi's setting, which is what the session actually holds; a case that needs an exact reserve passes its own below.
    requestReserve: () => ({ response: options.reserveTokens ?? 32768 }),
    hostMessages: () => { state.hostCalls++; return [hostInput()]; },
    fail: e => { faults.push(String(e) + (process.env.BUDGET_TRACE ? ' @ ' + String((e as Error).stack).split('\n').slice(1, 4).join(' | ') : '')); options.onFailure?.(e); },
    settings: options.guardOnly ? SettingsManager.inMemory({ compaction: { ...settings.getCompactionSettings(model), enabled: true } }) : settings,
    ...options.compaction,
    ...(options.cutAtDefault ? { cutAt: undefined } : { cutAt: options.compaction?.cutAt ?? 1 }),
   });
   if (options.systemSection && options.systemSectionLate) addSection(); // registered after the compactor: its patch is the last one
   // Unseen growth: after the compactor has decided, before the next request is made.
   if (options.afterDecision) {
    const unseen: Unseen = { growHost: tokens => { host += tokens; }, setTools: dormant => { pi.setActiveTools(dormant ? ['effect', 'dormant'] : ['effect']); }, steer: async tokens => { await session!.steer(note + exact(tokens - 6)); } };
    pi.on('before_agent_start', () => { options.afterDecision!(decisions++, unseen); });
    pi.on('turn_end', event => { if (event.toolResults.length) options.afterDecision!(decisions++, unseen); });
   }
   // The guard's number for every request, computed independently (registered after the compactor's hook).
   pi.on('context_with_system', (event, ctx) => { wholePrompt.push(JSON.stringify(event.messages).includes(promptText)); guard.push(referenceGuardSystem(event.messages, ctx.getSystemPrompt()) + nonSystem(event.messages)); cutsAtRequest.push(manager.getEntries().filter(e => e.type === 'compaction').length); state.cutCounts.push(cutsAtRequest.at(-1)!); if (event.messages.some(m => m.role === 'toolResult' && JSON.stringify((m as { content?: unknown }).content ?? '').includes('[pi-tuck: characters'))) state.clips++; });
   for (const observe of extensionObservers) observe(pi);
  }] });
  let loader = makeLoader();
  await loader.reload(); expect(loader.getExtensions().errors).toEqual([]);
  const newSession = async (m: SessionManager) => (await createAgentSession({ cwd: dir, modelRuntime: runtime, model, thinkingLevel: 'low', sessionManager: m, settingsManager: settings, resourceLoader: loader, tools: options.ballast ? ['effect', 'ballast'] : options.liveTools ? ['effect', 'read', 'bash', 'edit', 'write', 'tuck_recall', 'tuck_search'] : ['effect'], customTools: [...(options.dormant ? [{ name: 'dormant', label: 'Dormant', description: 'Dormant tool. ' + text(options.dormant), parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) }] : []), ...(options.ballast ? [{ name: 'ballast', label: 'Ballast', description: 'Ballast tool. ' + text(options.ballast), parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }) }] : []), {
   name: 'effect', label: 'Effect', description: 'Local effect witness', parameters: Type.Object({}),
   execute: async () => {
    state.effects++;
    if (options.ballast && state.effects === 1) extension!.setActiveTools(['effect']);
    if (options.queued) await session!.steer(note + exact(options.queued - 6)); // the note's 22 characters are 6 tokens: the message is exactly `queued` tokens
    // The tool-boundary scenarios grow the conversation by the amount that lands the next request exactly where the case asks.
    if (options.toolResultTokens) bigText = fit(options.toolResultTokens(state.effects)); // a run that grows by amounts the caller chose
    else if (options.at === 'tool' && state.effects === 1) {
     const have = referenceSystemPart(saved(), session!.systemPrompt, activeToolsJson()) + nonSystem([hostInput()]) + nonSystem(saved());
     bigResult = Math.max(1, options.complete - have); bigText = fit(bigResult);
    }
    state.results.push(resultTokens(bigText)); state.resultAt.push(state.requests); // what this round lands in the conversation, so a caller can weigh a turn of its own
    return { content: [{ type: 'text', text: bigText }], details: {} };
   },
  }] })).session;
  session = await newSession(manager);
  // Notices to the operator (a warning when a cut cannot be made, advice on a capacity failure); every other UI call is a no-op.
  const ui = new Proxy({ notify: (message: string) => { notices.push(message); } }, { get: (target, key) => key in target ? (target as never)[key] : () => undefined });
  // ctx.abort() reaches Pi through this handler, so a test can see whether the compactor aborted the run.
  await session.bindExtensions({ uiContext: ui as never, abortHandler: () => { state.aborts++; void session!.abort(); } });
  const initialTools = JSON.parse(activeToolsJson());
  const mandatory = estimateTokens({ role: 'system', content: session.systemPrompt, ...(initialTools.length ? { toolsAdded: initialTools } : {}), timestamp: 0 });
  // A session that opens with its own first prompt (a long spec, say) has no seeded opening turn before it.
  const opening = options.noOpening ? '' : manager.appendMessage({ role: 'user', content: 'Opening task', timestamp: 0 });
  // A previous compaction: the saved conversation starts with a summary message that Pi wraps when it converts it for the model.
  if (options.summary) {
   const records: Parameters<typeof serializeTranscript>[0] = [{ kind: 'omission', reason: 'Earlier work, summarized. ' + text(options.summaryTokens ?? 800) }];
   if (options.omitted) records.unshift({ kind: 'excerpt', role: 'user', sourceIndex: 0, text: 'o'.repeat(options.omitted) });
   manager.appendCompaction(options.foreign ? '## Goal\nA default Pi summary written by a model. ' + text(800) : serializeTranscript(records) + DIALOGUE_SUFFIX, options.summaryOnly ? '' : opening, 1000, { compactor: 'pi-tuck', version: 2, adapter: 'standalone', keptUserTurns: 0 }, true);
   if (options.omitted) manager.appendContextEdit(opening, null);
  }
  if (options.seededTail) {
   const { summary, tail, cycle: cycleTokens } = options.seededTail;
   manager.appendCompaction(serializeTranscript([{ kind: 'omission', reason: 'Earlier work, summarized. ' + sized(summary) }]) + DIALOGUE_SUFFIX, '', 1000, { compactor: 'pi-tuck', version: 2, adapter: 'standalone', keptUserTurns: 0 }, true);
   for (let left = tail; left > 0; left -= cycleTokens) cycle(Math.min(left, cycleTokens));
  }
  // History up to the request the case asks for. At the tool boundary the last tool result is sized when the tool runs.
  let promptText = 'Continue';
  const promptTokens = () => estimateTokens({ role: 'user', content: promptText, timestamp: 0 });
  const target = options.at === 'prompt' ? options.complete : options.at === 'tool' ? options.complete - (options.fresh ?? 3000) : 20000;
  const historyComplete = () => promptTokens() + referenceSystemPart(saved(), session!.systemPrompt, activeToolsJson()) + nonSystem([hostInput()]) + nonSystem(saved());
  const sizeFor = options.oneTurn ? 1000 : options.cycleSize ?? 6000, slack = sizeFor + 500;
  if (options.at === 'tool' && options.history !== undefined) for (let left = options.history; left > 0; left -= sizeFor) options.oneTurn ? round(Math.min(sizeFor, left)) : cycle(Math.min(sizeFor, left));
  else if (!(options.at === 'prompt' && (options.history !== undefined || options.summaryOnly)) && !options.noHistory) while (historyComplete() + slack < target) options.oneTurn ? round(sizeFor) : cycle(sizeFor);
  if (options.noHistory) { /* the caller drives the session: no history is built and no prompt is sized */ }
  else if (options.at === 'prompt' && options.compactedLast) {
   // The compaction keeps everything after the opening request, so the saved conversation is large and the last saved entry is the compaction.
   manager.appendCompaction(serializeTranscript([{ kind: 'omission', reason: 'Earlier work, summarized.' }]) + DIALOGUE_SUFFIX, opening, 1000, { compactor: 'pi-tuck', version: 2, adapter: 'standalone', keptUserTurns: 0 }, true);
   // The prompt carries the rest, so the last saved entry stays the compaction.
   const rest = options.complete - historyComplete();
   expect(rest).toBeGreaterThanOrEqual(0);
   promptText = 'Continue' + 'q'.repeat(rest * 4);
   expect(historyComplete()).toBe(options.complete);
  } else if (options.at === 'prompt' && (options.history !== undefined || options.summaryOnly)) {
   if (options.history !== undefined) for (let left = options.history; left > 0; left -= sizeFor) cycle(Math.min(sizeFor, left));
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
  // A reopened session: the file is closed and opened again, as Pi does when a saved session is resumed. Everything the caller does next runs on the loaded session.
  // The old session is left alone rather than disposed: disposing it marks the shared extension runtime stale, and Pi's own reopen builds a fresh
  // runtime, which this fixture does not. The loaded session and its file are what the case is about.
  if (options.reopen) {
   const file = manager.getSessionFile();
   if (!file) throw Error('A reopened session needs a persisted one');
   manager = SessionManager.open(file, dir);
   session = await newSession(manager);
   await session.bindExtensions({ uiContext: ui as never, abortHandler: () => { state.aborts++; void session!.abort(); } });
  }
  const cutsBefore = manager.getEntries().filter(e => e.type === 'compaction').length;
  const rounds = options.rounds ?? 1;
  const providerWindow = options.providerWindow ?? model.contextWindow;
  const density = Number.isFinite(options.usageRatio) && (options.usageRatio ?? 0) > 0 ? options.usageRatio! : 1;
  const overflowText = (prompt: number, maxTokens: number) => typeof options.rejectWith === 'function'
   ? options.rejectWith({ prompt, maxTokens, window: providerWindow }) : options.rejectWith ?? OVERFLOW_TEXT;
  const responseTime = () => {
   const newest = manager.getEntries().reduce((latest, e) => e.type === 'compaction' ? Math.max(latest, Date.parse(e.timestamp)) : latest, 0);
   const at = Math.max(Date.now(), newest + 1);
   if (physicalClock) { vi.setSystemTime(at + 10); return Date.now(); }
   return at;
  };
  // A provider's refusal of an oversized request: the overflow error a real transport returns. Pi ignores a reply no newer than the last cut, so
  // the refusal is stamped after it.
  const refuse = (wording = OVERFLOW_TEXT, status?: number) => {
   const failed = answer([], 'error');
   failed.errorMessage = wording;
   // A gateway that answers with a bare 413 carries no wording at all, which is the case Pi's second rule is written for.
   if (status !== undefined) (failed as unknown as { status?: number }).status = status;
   failed.timestamp = responseTime();
   return failed;
  };
  session.agent.streamFunction = async (_m, _ctx, streamOptions) => {
   // No provider request went out when the already-aborted signal short-circuited it. Keep request-indexed answers aligned.
   if (streamOptions?.signal?.aborted) { const m = answer([], 'aborted'); const s = createAssistantMessageEventStream(); s.push({ type: 'error', reason: 'aborted', error: m }); s.end(m); return s; }
   if (options.plainPi && nativeSummarizing) {
    // Pi chooses the boundary, kept tail and summary prompt. The same scripted model's normal
    // final answer ("Finished") answers its summary call; summary calls are not tool-work requests.
    const request = await providerRequest(_m, _ctx, streamOptions);
    state.nativeSummaries.push(request);
    const message = replyOf([{ type: 'text', text: 'Finished' }]);
    message.timestamp = physicalClock ? responseTime() : Date.now();
    message.usage.input = estimateContextTokens(_ctx).tokens;
    message.usage.output = est(message); message.usage.totalTokens = message.usage.input + message.usage.output;
    const stream = createAssistantMessageEventStream();
    const measuredPrompt = _ctx.messages.reduce((sum, m) => sum + est(m), 0);
    const count = Math.ceil(measuredPrompt * density);
    const availableOutput = Math.min(request.maxTokens, Math.max(0, providerWindow - count));
    const refused = Boolean(options.rejectOverWindow && count > providerWindow ||
     options.providerWindow !== undefined && options.replyWindow === 'refuse' && count + request.maxTokens > providerWindow);
    const length = !refused && options.providerWindow !== undefined && options.replyWindow === 'clip' && message.usage.output > availableOutput;
    if (options.providerWindow !== undefined) {
     providerRequests.push({ summary: true, measuredPrompt, prompt: count, maxTokens: request.maxTokens, availableOutput, output: refused ? 0 : length ? availableOutput : message.usage.output, refused, length });
     message.usage.input = count;
     message.usage.totalTokens = count + message.usage.output;
    }
    if (refused) {
     message.content = []; message.stopReason = 'error'; message.errorMessage = overflowText(count, request.maxTokens);
     if (options.rejectStatus !== undefined) (message as unknown as { status?: number }).status = options.rejectStatus;
     stream.push({ type: 'error', reason: 'error', error: message });
    } else if (length) {
     message.content = [{ type: 'text', text: sized(availableOutput) }]; message.stopReason = 'length';
     message.usage.output = availableOutput; message.usage.totalTokens = count + availableOutput;
     stream.push({ type: 'done', reason: 'length', message });
    } else stream.push({ type: 'done', reason: 'stop', message });
    stream.end(message); return stream;
   }
   options.onWire?.(_ctx);
   const request = options.piRequestPath ? await providerRequest(_m, _ctx, streamOptions) : undefined;
   if (request) state.requestOptions.push(request);
   state.requestStates.push(createHash('sha256').update(JSON.stringify({ ..._ctx, messages: _ctx.messages.filter(m => m.role !== 'assistant' || !['error', 'aborted'].includes(m.stopReason)) }, (key, value) => key === 'timestamp' ? undefined : value)).digest('hex'));
   if (options.fingerprintWire) state.requestFingerprints.push(createHash('sha256').update(JSON.stringify(_ctx, (key, value) => key === 'timestamp' ? undefined : value).replaceAll(dir, '<session>')).digest('hex'));
   state.requests++;
   if (state.requests === 2) state.delivered = JSON.stringify(_ctx.messages).includes(note);
   options.onRequest?.(state.requests, { setHost: tokens => { host = tokens; }, pi: extension! });
   // After the first round the host view outgrows the room by itself: no cut can help from then on.
   if (options.at === 'tool-impossible' && state.requests === 1) host = ROOM + 20000;
   const toolRound = options.toolCalls ? options.toolCalls(state.requests) : (options.at === 'tool' || options.at === 'tool-impossible') && state.requests <= rounds;
   if (toolRound && state.requests > 1 && !options.toolResultTokens) { bigText = text(options.laterResult ?? 100); }
   const stream = createAssistantMessageEventStream();
   // What the provider's tokenizer makes of this request: the guard's measure of it times the density the case declares. A ratio that is not a
   // finite number above 0 is no observation of density at all, so the count is the measure. `known` says a reply before this one reported a
   // finite input, which is what makes the provider's density a fact of the session rather than a guess.
   const count = guard.length ? Math.ceil(guard.at(-1)! * density) : 0;
   state.counts.push({ count, known: state.reports > 0 });
   const maxTokens = request?.maxTokens ?? model.maxTokens;
   const providerRefused = Boolean(options.providerOverflowAt?.(state.requests) ||
    options.replyWindow === 'refuse' && count + maxTokens > providerWindow ||
    options.rejectOverWindow && options.truncateOverWindow === undefined && count > providerWindow);
   const observed = { summary: false, measuredPrompt: guard.at(-1) ?? 0, prompt: count, maxTokens, availableOutput: Math.min(maxTokens, Math.max(0, providerWindow - count)), output: 0, refused: providerRefused, length: false };
   if (options.providerWindow !== undefined) providerRequests.push(observed);
   // A provider that enforces its own window refuses the request rather than answering it, and Pi runs its one compact-and-retry on the error.
   // A server that keeps the end of an oversize request instead (`truncateOverWindow`) answers it, and the reply below carries its usage.
   const truncated = options.truncateOverWindow !== undefined && count > model.contextWindow;
   if (options.transientErrorAt?.(state.requests)) {
    state.assistantSizes[state.requests - 1] = 0;
    const failed = refuse('503 Service Unavailable: the upstream is temporarily overloaded', 503);
    state.answers.push(failed);
    stream.push({ type: 'error', reason: 'error', error: failed }); stream.end(failed); return stream;
   }
   if (providerRefused) {
    state.overflows++;
    state.assistantSizes[state.requests - 1] = 0; // the model sent no content at all for this request
    const failed = refuse(overflowText(count, maxTokens), options.rejectStatus);
    state.answers.push(failed);
    stream.push({ type: 'error', reason: 'error', error: failed }); stream.end(failed); return stream;
   }
   // A request that never answers: nothing arrives until the turn is aborted, which is when a transport closes.
   if (options.neverEnds?.(state.requests)) {
    const stalled = answer([], 'aborted'); stalled.errorMessage = 'The stream never ended.'; state.answers.push(stalled);
    const streamed = options.stallChars?.(state.requests);
    // What did arrive is on the message the abort settles with, which is the message the session keeps.
    if (streamed) { stalled.content = [{ type: 'text', text: sized(streamed) }]; stream.push({ type: 'start', partial: { ...stalled, content: [], stopReason: 'stop' } }); stream.push({ type: 'text_delta', contentIndex: 0, delta: (stalled.content[0] as { text: string }).text, partial: stalled }); }
    const close = () => { stream.push({ type: 'error', reason: 'aborted', error: stalled }); stream.end(stalled); };
    const signal = streamOptions?.signal;
    if (!signal) close(); else if (signal.aborted) close(); else signal.addEventListener('abort', close, { once: true });
    return stream;
   }
   const failing = options.replies?.[state.requests - 1];
   if (failing) {
    // Pi ignores a reply that is not newer than the last cut.
    const cutAt = manager.getEntries().reduce((latest, e) => e.type === 'compaction' ? Math.max(latest, Date.parse(e.timestamp)) : latest, 0);
    const failed = failing === 'length' ? answer([{ type: 'text', text: 'A reply cut short' }], 'length') : answer([], 'error');
    if (failing === 'overflow') failed.errorMessage = OVERFLOW_TEXT; else failed.usage.output = failed.usage.totalTokens = 2048;
    failed.timestamp = Math.max(Date.now(), cutAt + 1);
    state.answers.push(failed);
    if (failing === 'length') stream.push({ type: 'done', reason: 'length', message: failed }); else stream.push({ type: 'error', reason: 'error', error: failed });
    stream.end(failed); return stream;
   }
   const reply: AssistantMessage['content'] = toolRound ? [{ type: 'toolCall', id: `boundary-effect-${state.requests}`, name: 'effect', arguments: {} }] : [{ type: 'text', text: 'Finished' }];
   // Exercise actual output exhaustion, distinct from the existing input-truncation fake. Tool rounds stay small; final answers try the cap.
   const outputRoom = Math.min(request?.maxTokens ?? Infinity, Math.max(0, providerWindow - count));
   const output = Math.min(model.maxTokens, options.replyWindowOutput?.(state.requests) ?? model.maxTokens);
   const clippedReply = options.replyWindow === 'clip' && !toolRound && output > outputRoom;
   if (options.replyWindow === 'clip' && !toolRound) reply.splice(0, reply.length, { type: 'text', text: sized(Math.min(output, outputRoom)) });
   // A reply whose own body is large arrives with the round, so it is in the next request before any cut can reach it.
   if (options.replyTokens && toolRound) reply.unshift({ type: 'text', text: sized(Math.max(0, Math.round(options.replyTokens(state.requests)))) });
   state.assistantSizes[state.requests - 1] = est(replyOf(reply, toolRound ? 'toolUse' : 'stop'));
   // A model that replays its reasoning sends the thinking text back on the next request, so it counts against the window.
   const thinking = options.thinkingChars?.(state.requests);
   const thinkingStop = options.thinkingOnlyLength?.(state.requests) ?? false;
   const message = answer(thinkingStop ? [{ type: 'thinking', thinking: sized(request?.maxTokens ?? model.maxTokens) }] :
    thinking ? [{ type: 'thinking', thinking: sized(Math.max(1, Math.round(thinking / 4))) }, ...reply] : reply,
    thinkingStop || clippedReply ? 'length' : toolRound ? 'toolUse' : 'stop');
   if (thinkingStop) state.assistantSizes[state.requests - 1] = est(message);
   const wanted = options.replyWindow === 'clip' && !toolRound ? output : options.outputTokens ?? est(message);
   const clampStop = request !== undefined && wanted > request.maxTokens && request.maxTokens < request.requestedMaxTokens;
   if (clampStop) { state.clampStops++; state.clampEvents.push({ request: state.requests, wanted, cap: request.maxTokens }); }
   if (!thinkingStop && request && wanted > request.maxTokens) {
    const emitted = options.providerWindow !== undefined && options.replyWindow === 'clip' ? Math.min(request.maxTokens, outputRoom) : request.maxTokens;
    message.content = [{ type: 'text', text: sized(emitted) }];
    message.stopReason = 'length';
    state.stops[state.stops.length - 1] = 'length';
    state.assistantSizes[state.requests - 1] = emitted;
   }
   if (options.replyWindow) { message.usage.input = count; message.usage.output = est(replyOf(reply)); message.usage.totalTokens = count + message.usage.output; }
   if (clippedReply) state.truncations++;
   if (options.usageFirst !== undefined && state.requests === 1) { message.usage.input = options.usageFirst; message.usage.totalTokens = options.usageFirst; }
   if (options.usageRatio !== undefined && guard.length) { message.usage.input = Math.ceil(guard.at(-1)! * options.usageRatio); message.usage.totalTokens = message.usage.input; }
   if (options.outputTokens !== undefined) { message.usage.output = options.outputTokens; message.usage.totalTokens += options.outputTokens; }
   // The server that took an oversize request reports its own window as the input it read, and nothing of what it dropped. The Xiaomi variant
   // stops at length with no output at all, which is what makes Pi call it a recoverable length rather than an answer.
   if (truncated) {
    state.truncations++;
    message.usage.input = model.contextWindow; message.usage.totalTokens = model.contextWindow + message.usage.output;
    if (options.truncateOverWindow === 'lengthZero') { message.content = [{ type: 'text', text: 'The server stopped here.' }]; message.stopReason = 'length'; message.usage.output = 0; message.usage.totalTokens = model.contextWindow; }
   }
   if (options.usageAt) Object.assign(message.usage, options.usageAt(state.requests, guard.at(-1) ?? 0));
   if (thinkingStop || request && wanted > request.maxTokens) {
    message.usage.output = options.providerWindow !== undefined && options.replyWindow === 'clip' ? Math.min(maxTokens, outputRoom) : maxTokens;
    message.usage.totalTokens = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite + message.usage.output;
   }
   if (options.noUsage) delete (message as { usage?: unknown }).usage;
   if (options.providerWindow !== undefined) {
    message.timestamp = responseTime();
    observed.length = message.stopReason === 'length';
    observed.output = message.usage.output;
    // The physical-window cells report the complete usage, including output beside the factored input.
    message.usage.totalTokens = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite + message.usage.output;
   }
   // A reply that reports a finite input is the session's first proof of the provider's density; NaN, Infinity and no usage object report nothing.
   if (Number.isFinite((message as { usage?: { input?: number } }).usage?.input)) state.reports++; else state.nonFinite++;
   // Every reply is measured as pi-tuck measures it, so a caller can weigh the assistant content a run just added to the session.
   state.replies.push(estimateTokens(message));
   state.answers.push(message);
   stream.push({ type: 'done', reason: message.stopReason as 'toolUse' | 'stop' | 'length', message }); stream.end(message); return stream;
  };
  const allCompactions = () => manager.getEntries().filter((e): e is Extract<SessionEntry, { type: 'compaction' }> => e.type === 'compaction').slice(cutsBefore);
  const isRunEnd = (e: { details?: unknown }) => (e.details as { diagnosticReceipt?: { reason?: string } } | undefined)?.diagnosticReceipt?.reason === 'run-end';
  const runEnd = () => allCompactions().filter(isRunEnd);
  const compactions = () => allCompactions().filter(e => !isRunEnd(e));
  return {
   dir, get manager() { return manager; }, get session() { return session!; }, settings, state, providerRequests, faults, notices, probes, guard, saved, promptTokens, cleanup, compactions, answer, text, sized, fit, cycle, round, setHost: (tokens: number) => { host = tokens; }, hostInput, hostSnapshot: () => { if (!latestHostInput) throw Error('No host input observed'); return latestHostInput; }, extension: () => extension!, mandatory,
   observeExtension: (observe: (pi: ExtensionAPI) => void) => { extensionObservers.push(observe); observe(extension!); },
   /** End every old hook/runtime, open the same file, and import pi-tuck cold. */
   async coldResume() {
    const file = manager.getSessionFile();
    if (!file) throw Error('Cold resume needs a file-backed SessionManager');
    const old = session!, oldInstall = install, oldExtension = extension, activeTools = extension!.getActiveTools();
    await old.abort();
    await old.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
    old.dispose();
    session = undefined; extension = undefined;
    vi.resetModules();
    install = (await import('../src/compaction')).installCompaction;
    expect(install).not.toBe(oldInstall);
    manager = SessionManager.open(file, dir);
    loader = makeLoader();
    await loader.reload(); expect(loader.getExtensions().errors).toEqual([]);
    session = await newSession(manager);
    session.agent.streamFunction = old.agent.streamFunction; // scripted server state belongs to the scenario
    expect(extension).not.toBe(oldExtension);
    await session.bindExtensions({ uiContext: ui as never, abortHandler: () => { state.aborts++; void session!.abort(); } });
    extension!.setActiveTools(activeTools);
    expect(network).not.toHaveBeenCalled();
    return { file, entries: manager.getEntries().length };
   },
   // Open the session's file again the way Pi does when a saved session is resumed, and report how many messages came back. The run's own session is
   // left alone: this reads what reached the disk, which is all the operator has if the run ends where it stands.
   reopenFile: () => {
    const file = manager.getSessionFile();
    if (!file) throw Error('Reading the saved session back needs a persisted one');
    return nonSystemCount(SessionManager.open(file, dir).buildSessionProjection().messages);
   },
   async run() {
    atRunEnd = undefined;
    await session!.prompt(promptText);
    const end = atRunEnd as { hostCalls: number; kept: number } | undefined; // set by the agent_end handler during the prompt
    const cuts = compactions().length, kept = end?.kept ?? nonSystem(saved());
    state.hostCalls = end?.hostCalls ?? state.hostCalls;
    const measured = probes.find(p => p.at === (options.at === 'tool' ? 'tool' : 'prompt'));
    expect(network).not.toHaveBeenCalled();
    return { wholePrompt, cuts, requests: state.requests, effects: state.effects, faults, measured, delivered: state.delivered, kept, hostCalls: state.hostCalls, guard, entries: compactions(), runEnd: runEnd(), notices, probes, cutsAtRequest, cutsAtProbe, system: mandatory, aborts: state.aborts, last: session!.messages.findLast(m => m.role === 'assistant') as AssistantMessage | undefined,
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
 const details = entry.details as { tokensAfter: number; view: string; mode: string; diagnosticReceipt: { reason: string; settings: { draftReservedTokens: number; hostInputTokens?: number; mandatoryInputTokens?: number; target?: 'band' | 'room'; triggerMarginTokens?: number; cutAt?: number; responseReserveTokens?: number; calibrationFactor?: number; calibrationWindow?: number[]; calibrationIdentity?: string } } };
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
  // The first request made after the cut. A prompt's cut is carried by its run's first request and saved at that run's first boundary.
  const first = receiptOf(entries[0]!).reason === 'prompt' ? 0 : cutsAtRequest.findIndex(n => n >= 1);
  expect(first, probe).toBeGreaterThanOrEqual(0);
  // The trigger's system part is the larger of two formulas that round differently, so it may exceed the guard's by a token or two, never fall short.
  const planned = receiptOf(entries[0]!).tokensAfter + expected;
  expect(planned - guard[first]!, probe + ` planned ${planned}`).toBeGreaterThanOrEqual(0);
  expect(planned - guard[first]!, probe + ` planned ${planned}`).toBeLessThanOrEqual(2);
 }
}
