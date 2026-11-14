import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, normalizeContext, type Context, type Model } from '@earendil-works/pi-ai';
import {
  convertToLlm, createAgentSession, DefaultResourceLoader, SessionManager, sessionEntryToContextMessages,
  type CompactionEntry, type SessionEntry,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { harness } from './budget-fixture';
import { SEMANTIC_SETUP_TRANSITIONS, type SemanticSetup } from '../src/semantic-recall';

// Only Pi's public APIs and the existing scripted-provider fixture are used here.
// Request/view expectations do not use receipts/details or pi-tuck's planner. The
// additional impossible-state checks observe a read-only compactor snapshot.
export type Event = {
  kind: 'prompt' | 'handled' | 'custom' | 'tools' | 'tree' | 'new' | 'compact' | 'abort' | 'semantic' | 'resume' | 'model' | 'refusal';
  tokens?: number;
  rounds?: number;
  resultTokens?: number;
  target?: number;
  enabled?: boolean;
  switched?: boolean;
  scenario?: 'handled-custom' | 'handled-tree-custom';
};
export type Finding = { invariant: number | 'harness'; check: string; at: number; message: string; scenario?: Event['scenario'] };
type View = { kept: string | null; key: string | null; summary: string; summaryChars: number };
type Request = { context: Context; view: View; hasSavedCut: boolean; search: string[]; searchCall?: string };
export type Coverage = {
  requests: number; promptCuts: number; boundaryCuts: number; fresh: number; searches: number;
  modelSearches: number; searchBoundaries: number; disabledSearches: number; noCutRequests: number; savedViews: number;
  quotedPrompts: number;
  aborts: number; handled: number; sessions: number; treeMoves: number; manual: number; semantic: number; semanticNotices: number;
  resumes: number; modelSwitches: number; stateChecks: number; failedRuns: number; pendingResets: number;
};
export const emptyCoverage = (): Coverage => ({ requests: 0, promptCuts: 0, boundaryCuts: 0, fresh: 0,
  searches: 0, modelSearches: 0, searchBoundaries: 0, disabledSearches: 0, noCutRequests: 0, savedViews: 0, quotedPrompts: 0,
  aborts: 0, handled: 0, sessions: 0, treeMoves: 0, manual: 0, semantic: 0, semanticNotices: 0,
  resumes: 0, modelSwitches: 0, stateChecks: 0, failedRuns: 0, pendingResets: 0 });
export const emptyAppendOnlyCoverage = () => ({ checked: 0,
  exempt: { new: 0, tree: 0, manual: 0, abort: 0, model: 0, resume: 0, summary: 0, historyTools: 0 } });
type AppendOnlyExemption = keyof ReturnType<typeof emptyAppendOnlyCoverage>['exempt'];

const textOf = (content: unknown): string => typeof content === 'string' ? content : Array.isArray(content)
  ? content.map(c => c.type === 'text' ? c.text : '').join('') : '';
const keyOf = (message: { role: string; content?: unknown; toolCallId?: string }): string | null => {
  if (message.role === 'toolResult') return `tool:${message.toolCallId}`;
  const marker = /^SEQ-[\w-]+/.exec(textOf(message.content))?.[0];
  if (marker) return `${message.role}:${marker}`;
  if (Array.isArray(message.content)) {
    const call = message.content.find(c => c.type === 'toolCall');
    if (call) return `call:${call.id}`;
  }
  return null;
};
const SUMMARY_PREFIX = 'The conversation history before this point was compacted into the following summary:\n\n<summary>\n';
const SUMMARY_SUFFIX = '\n</summary>';

const requestText = (content: unknown): string => typeof content === 'string' ? content : Array.isArray(content)
  ? content.filter(block => block.type === 'text').map(block => block.text).join('\n') : '';
const summaryOf = (text: string): string | undefined => text.startsWith(SUMMARY_PREFIX) && text.endsWith(SUMMARY_SUFFIX)
  ? text.slice(SUMMARY_PREFIX.length, -SUMMARY_SUFFIX.length) : undefined;

function providerInput(context: Context) {
  const { messages } = normalizeContext(context), tools = getCurrentTools(messages);
  return { tools,
    summaries: messages.flatMap(message => {
      const summary = summaryOf(requestText(message.content));
      return summary === undefined ? [] : [summary];
    }),
    // Replay Pi's system/tool deltas as the provider sees them, then compare
    // every conversation message. Only the message metadata timestamp is
    // omitted: a tool argument or schema property named timestamp is still data.
    items: [JSON.stringify(getCurrentSystemPrompt(messages)), JSON.stringify(tools),
      ...messages.filter(message => message.role !== 'system').map(({ timestamp: _timestamp, ...message }) => JSON.stringify(message))],
  };
}

export function appendOnlyPair(previous: Context, current: Context): { exempt?: 'summary' | 'historyTools'; difference?: string } {
  const a = providerInput(previous), b = providerInput(current);
  if (b.summaries.length && JSON.stringify(a.summaries) !== JSON.stringify(b.summaries)) return { exempt: 'summary' };
  const changed = a.items.findIndex((item, index) => item !== b.items[index]);
  if (changed < 0) return {};
  const history = ['tuck_recall', 'tuck_search'];
  // The first pending cut can declare history tools one request before its
  // summary appears. Exempt exactly that addition, preserving all other items.
  if (!a.summaries.length && !b.summaries.length && changed === 1
    && !a.tools.some(tool => history.includes(tool.name)) && b.tools.length === a.tools.length + 2
    && JSON.stringify(b.tools.slice(0, a.tools.length)) === JSON.stringify(a.tools)
    && JSON.stringify(b.tools.slice(a.tools.length).map(tool => tool.name).sort()) === JSON.stringify(history)
    && a.items.every((item, index) => index === 1 || item === b.items[index])) return { exempt: 'historyTools' };
  const label = changed === 0 ? 'system prompt' : changed === 1 ? 'tools' : `message ${changed - 1}`;
  const before = a.items[changed], after = b.items[changed];
  let offset = 0;
  while (after !== undefined && offset < before.length && before[offset] === after[offset]) offset++;
  return { difference: `${label} changed at character ${offset}: ${before.slice(offset, offset + 120)} -> ${after?.slice(offset, offset + 120) ?? '(missing item)'}` };
}

// Decode the model-facing transcript format locally: no planner, guard, or
// transcript parser from the product is used as the expected answer.
function quotedInputs(summary: string, role: 'user' | 'custom'): string[] {
  const header = /^(TUCK-TRANSCRIPT\/[12]|VCC-TRANSCRIPT\/1)\n/.exec(summary);
  const end = summary.indexOf('\n\n---\n\n');
  if (!header || end < header[0].length) return [];
  return summary.slice(header[0].length, end).split('\n').flatMap(line => {
    if (header[1].endsWith('/1')) {
      try {
        const record = JSON.parse(line);
        return record.kind === 'excerpt' && record.role === role && typeof record.text === 'string'
          ? [record.text] : [];
      } catch { return []; }
    }
    const quote = /^(?:#\d+ )?(user|custom)(?: "(?:[^"\\]|\\.)*")?(?: @(?:unknown|(?:journal:)?\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z))?(?: \[chars \d+-\d+ of \d+\])?: ?(.*)$/.exec(line);
    if (!quote || quote[1] !== role || /\\(?:[^\\nr]|$)/.test(quote[2].replace(/\\\\/g, ''))) return [];
    return [quote[2].replace(/\\([\\nr])/g, (_match, escape: string) => escape === 'n' ? '\n' : escape === 'r' ? '\r' : '\\')];
  });
}

export function inputPresence(context: Context, prompt: string, role: 'user' | 'custom' = 'user'): 'original' | 'quote' | undefined {
  if (!prompt.length) return 'original';
  for (const message of context.messages) {
    const text = requestText(message.content), summary = summaryOf(text);
    if (summary !== undefined) {
      if (quotedInputs(summary, role).some(quote => quote.includes(prompt))) return 'quote';
    } else if (message.role === 'user' && text.includes(prompt)) return 'original';
  }
  return undefined;
}

function viewOf(context: Context, branch: SessionEntry[]): View {
  const byKey = new Map<string, string>();
  for (const entry of branch) for (const message of convertToLlm(sessionEntryToContextMessages(entry))) {
    const key = keyOf(message);
    if (key) byKey.set(key, entry.id);
  }
  let summary = '';
  for (const message of context.messages) {
    const text = textOf(message.content);
    if (text.startsWith(SUMMARY_PREFIX)) summary = text.slice(SUMMARY_PREFIX.length, -SUMMARY_SUFFIX.length);
    const key = keyOf(message);
    if (key && byKey.has(key)) return { kept: byKey.get(key)!, key, summary, summaryChars: summary.length };
  }
  return { kept: null, key: null, summary, summaryChars: summary.length };
}

// Distinct first and last witnesses make a partial quote fail preservation.
function body(marker: string, tokens: number): string {
  return `${marker} ` + 'recorded context data '.repeat(Math.ceil(tokens * 4 / 22)) + ` END-${marker}`;
}

async function open(branch?: SessionEntry[], cwd?: string, selectedModel?: Model<any>) {
  let refuse = false;
  const h = await harness({ at: 'prompt', complete: 0, host: 0, noHistory: true, noOpening: true,
    persist: !branch, trackRuntimeSpies: false,
    systemTokens: 200, stableHost: true, liveTools: true, reserveTokens: 4096, keepRecent: 0,
    toolResultTokens: () => effectTokens,
    limits: { contextWindow: 32768, maxTokens: 4096 }, cutAtDefault: true,
    compaction: { requestReserve: () => ({ response: refuse ? 32768 : 4096 }) } });
  let session = h.session;
  session.modelRuntime.checkAuth = async () => ({ type: 'api_key', source: 'scripted test' });
  // Load a genuinely separate, later extension. The loader's public extension
  // list is shared with Pi's runner; this extension needs no runtime actions.
  const loadHandled = async () => {
   const handled = new DefaultResourceLoader({ cwd: h.dir, agentDir: h.dir, settingsManager: h.settings,
    noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [pi => { pi.on('input', event => event.text.startsWith('SEQ-handled-') ? { action: 'handled' } : undefined); }] });
  await handled.reload();
  h.session.resourceLoader.getExtensions().extensions.push(...handled.getExtensions().extensions);
  };
  await loadHandled();
  if (branch) {
    // A new in-memory manager preserves IDs and timestamps, but has only this
    // branch. The new harness above installed a completely fresh pi-tuck instance.
    const manager = SessionManager.inMemory(cwd ?? h.dir, undefined, structuredClone(branch));
    session = (await createAgentSession({ cwd: cwd ?? h.dir, modelRuntime: h.session.modelRuntime,
      model: selectedModel ?? h.session.model, thinkingLevel: 'low', sessionManager: manager, settingsManager: h.settings,
      resourceLoader: h.session.resourceLoader, tools: ['effect', 'read', 'bash', 'edit', 'write', 'tuck_recall', 'tuck_search'], customTools: [{
        name: 'effect', label: 'Effect', description: 'Local effect witness', parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: 'text' as const, text: 'oracle unused effect' }], details: {} }),
      }] })).session;
    await session.bindExtensions({ uiContext: new Proxy({ notify: (message: string) => h.notices.push(message) },
      { get: (target, key) => key in target ? target[key as keyof typeof target] : () => undefined }) as never,
      onError: event => h.faults.push(event.error), abortHandler: () => { void session.abort(); } });
  }
  h.extension().setActiveTools(['effect']);
  return { h, get session() { return session; }, get manager() { return session.sessionManager; },
    setRefusal(value: boolean) { refuse = value; },
    async coldResume() {
      if (branch) throw new Error('Fresh branch comparison cannot resume');
      const before = JSON.stringify(session.sessionManager.buildSessionProjection().messages);
      const file = session.sessionManager.getSessionFile();
      if (!file) throw new Error('Cold resume needs a saved session file');
      // Pi's unsummarized /tree only moves an in-memory leaf pointer. Reopening
      // selects the last saved leaf until a new entry has persisted that branch.
      const saved = JSON.stringify(SessionManager.open(file, h.dir).buildSessionProjection().messages);
      const result = await h.coldResume();
      session = h.session;
      await loadHandled();
      if (JSON.stringify(session.sessionManager.buildSessionProjection().messages) !== saved) throw new Error('Cold resume changed the saved projection');
      return { ...result, changedBranch: saved !== before };
    }, async close() {
    try {
      await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      if (session !== h.session) { await session.abort(); session.dispose(); }
    } finally { await h.cleanup(); }
  } };
}
type Rig = Awaited<ReturnType<typeof open>>;

function seedHistory(rig: Rig, epoch: string) {
  for (let i = 0; i < 12; i++) {
    rig.manager.appendMessage({ role: 'user', content: body(`SEQ-history-${epoch}-${i}-user`, 800), timestamp: 1700000000001 + i * 2 });
    rig.manager.appendMessage({ ...rig.h.answer([{ type: 'text', text: body(`SEQ-history-${epoch}-${i}-answer`, 700) }]), timestamp: 1700000000002 + i * 2 });
  }
  rig.session.agent.state.messages = rig.manager.buildSessionProjection().messages;
}

async function search(rig: Rig, id: string): Promise<string[]> {
  const tool = rig.session.extensionRunner.getToolDefinition('tuck_search');
  if (!tool) throw new Error('Pi did not register tuck_search');
  const result = await tool.execute(id, { query: 'recorded context' }, undefined, undefined,
    rig.session.extensionRunner.createToolContext(id, undefined));
  return result.content.filter(c => c.type === 'text').map(c => c.text);
}

function provider(rig: Rig, event: Event, marker: string, requests: Request[], inspectSearch: boolean, observeRequest?: (context: Context) => void) {
  let round = 0;
  let searched = false;
  let reached!: () => void;
  const ready = new Promise<void>(resolve => { reached = resolve; });
  rig.session.agent.streamFunction = async (_model, context, options) => {
    // Like the stress transport, an already-aborted attempt never sends a request.
    if (options?.signal?.aborted) {
      const stream = createAssistantMessageEventStream(), message = rig.h.answer([], 'aborted');
      stream.push({ type: 'error', reason: 'aborted', error: message }); stream.end(message);
      return stream;
    }
    // Isolate the received request from Pi's live state, including test faults.
    context = structuredClone(context);
    observeRequest?.(context);
    const branch = structuredClone(rig.manager.getBranch());
    const request: Request = { context, view: viewOf(context, branch),
      hasSavedCut: branch.some(entry => entry.type === 'compaction'), search: [] };
    requests.push(request);
    if (inspectSearch && getCurrentTools(context.messages).some(tool => tool.name === 'tuck_search')) {
      request.search = await search(rig, `${marker}-observe-${round}`);
    }
    const stream = createAssistantMessageEventStream();
    if (event.kind === 'abort') {
      const aborted = rig.h.answer([{ type: 'text', text: `${marker}-partial` }], 'aborted');
      stream.push({ type: 'start', partial: { ...aborted, content: [], stopReason: 'stop' } });
      stream.push({ type: 'text_delta', contentIndex: 0, delta: `${marker}-partial`, partial: aborted });
      const close = () => { stream.push({ type: 'error', reason: 'aborted', error: aborted }); stream.end(aborted); };
      if (options?.signal?.aborted) close(); else options?.signal?.addEventListener('abort', close, { once: true });
      reached();
      return stream;
    }
    const toolRound = round < (event.rounds ?? 0);
    // Use a real model-issued tuck_search as soon as it is declared. The other
    // rounds exercise the harness's effect, producing large tool results.
    const searchAvailable = getCurrentTools(context.messages).some(t => t.name === 'tuck_search');
    const name = !searched && searchAvailable ? 'tuck_search' : 'effect';
    if (toolRound && name === 'tuck_search') searched = true;
    if (toolRound && name === 'tuck_search') request.searchCall = `${marker}-call-${round}`;
    const message = rig.h.answer(toolRound
      ? [{ type: 'toolCall', id: `${marker}-call-${round}`, name, arguments: name === 'tuck_search' ? { query: 'recorded context' } : {} }]
      : [{ type: 'text', text: body(`${marker}-answer`, 500) }], toolRound ? 'toolUse' : 'stop');
    message.timestamp = Date.now();
    Object.assign(message, { provider: rig.session.model!.provider, api: rig.session.model!.api, model: rig.session.model!.id });
    round++;
    stream.push({ type: 'done', reason: toolRound ? 'toolUse' : 'stop', message }); stream.end(message);
    reached();
    return stream;
  };
  return ready;
}

async function start(rig: Rig, event: Event, marker: string, requests: Request[], inspectSearch = true, observeRequest?: (context: Context) => void) {
  const ready = provider(rig, event, marker, requests, inspectSearch, observeRequest);
  const content = body(marker, event.tokens ?? 200);
  const run = event.kind === 'custom'
    ? rig.session.sendCustomMessage({ customType: 'sequence', content, display: false }, { triggerTurn: true })
    : rig.session.prompt(content);
  if (event.kind === 'abort') {
    // Wait for the actual transport to stream before aborting; no timer race.
    await Promise.race([ready, run.then(() => { throw new Error('Abort run ended before reaching the provider'); })]);
    await rig.session.abort();
  }
  await run;
  return content;
}

function compareFresh(actual: Request, expected: Request | undefined, report: (n: number, message: string) => void) {
  if (!expected) { report(4, 'fresh install made no request'); return; }
  if (actual.view.key !== expected.view.key) report(4,
    `kept ${actual.view.key}, fresh install kept ${expected.view.key}; summary characters ${actual.view.summaryChars}/${expected.view.summaryChars}`);
  if (Math.abs(actual.view.summaryChars - expected.view.summaryChars) > expected.view.summaryChars * 0.01) report(4,
    `summary characters ${actual.view.summaryChars}, fresh install ${expected.view.summaryChars} (difference exceeds 1%)`);
}

function checkSearch(request: Request, report: (n: number, message: string) => void, coverage: Coverage) {
  const offered = getCurrentTools(request.context.messages).some(tool => tool.name === 'tuck_search');
  const hasCut = request.hasSavedCut || Boolean(request.view.summary);
  if (!offered) {
    if (hasCut) report(1, 'request has a saved or pending cut but does not offer tuck_search');
    else coverage.noCutRequests++;
    return;
  }
  if (!hasCut) report(1, 'request offers tuck_search without a saved or pending cut');
  coverage.searches++;
  const output = request.search.join('\n');
  const pages = request.search.map(text => JSON.parse(text));
  const semantic = pages.find(page => page.coverage);
  // Disabled semantic search makes no out-of-view claim. Its declaration still
  // has to agree with cut existence; request/saved-cut agreement is checked below.
  if (semantic?.status === 'disabled') coverage.disabledSearches++;
  if (/nothing is out of view|whole history is in (?:your|the) context/i.test(output) && request.view.summary) {
    report(1, `tuck_search says nothing is out of view while the request starts at ${request.view.key}`);
  }
  // Compare a boundary when search supplies one. No synthetic boundary is
  // required of the disabled response, which only promises keyword results.
  const kept = pages.map(page => page.firstKeptEntryId ?? page.coverage?.firstKeptEntryId ?? page.coverage?.window?.firstKeptEntryId)
    .find(id => typeof id === 'string');
  if (kept !== undefined) {
    coverage.searchBoundaries++;
    if ((kept || null) !== request.view.kept) report(1, `tuck_search kept ${kept}, request kept ${request.view.kept}`);
  }
}

async function checkSemantic(rig: Rig, noticeStart: number, report: (n: number, message: string) => void, coverage: Coverage) {
  const before = rig.h.notices.length;
  await rig.session.prompt('/tuck');
  const status = rig.h.notices.slice(before).find(line => line.startsWith('pi-tuck '));
  const line = status?.split('\n').find(line => line.startsWith('Search:'));
  coverage.semantic++;
  if (!line || !/off|not (?:set up|installed)|needs macOS/i.test(line)) report(5, `/tuck has no unavailable/off semantic state: ${line ?? status ?? '(no notice)'}`);
  const state = (text: string) => /off in this session|"enabled":false/.test(text) ? 'off'
    : /not (?:set up|installed)|needs macOS|setup failed|ENOENT/i.test(text) ? 'not installed' : null;
  // Notices are checked at the time they are emitted, against that event's /tuck
  // output. Older notices belong to older states and must not be compared later.
  for (const notice of rig.h.notices.slice(noticeStart, before)) {
    let local: { state?: string; enabled?: boolean } | undefined;
    try { local = JSON.parse(notice).local; } catch { /* plain operator notice */ }
    if ((!local && !/semantic recall/i.test(notice)) || notice.startsWith('pi-tuck ') && notice.includes('\nCuts:')) continue;
    coverage.semanticNotices++;
    const noticed = local ? local.enabled === false || local.state === 'disabled' ? 'off' : 'enabled' : state(notice);
    const shown = state(line ?? '');
    if (noticed && shown && noticed !== shown) report(5, `semantic notice says ${noticed}, /tuck says ${shown}: ${notice}`);
  }
}

export async function runSequence(seed: number, events: Event[]) {
  const findings: Finding[] = [], coverage = emptyCoverage(), appendOnly = emptyAppendOnlyCoverage(), trace: string[] = [];
  const rig = await open();
  let at = -1;
  const report = (invariant: number | 'harness', message: string) => {
    const check = invariant === 1 ? message.startsWith('saved cut') ? 'saved-view' : 'search-view'
      : invariant === 2 && message.startsWith('empty') ? 'compact-all-sentinel' : String(invariant);
    if (!findings.some(f => f.invariant === invariant && f.at === at && f.message === message)) {
      findings.push({ invariant, check, at, message, scenario: events[at]?.scenario });
    }
  };
  const originalModel = rig.session.model!;
  const switchedModel = { ...originalModel, provider: 'sequence-provider', api: 'openai-completions', id: 'sequence-model' };
  const failedRuns = new WeakSet<object>();
  const setupMoves: { from: SemanticSetup; to: SemanticSetup }[] = [];
  const checkState = (reset = false) => {
    const ctx = rig.session.extensionRunner.createToolContext('sequence-state', undefined);
    const handle = rig.h.compactionHandle(), state = handle.inspectState(ctx);
    coverage.stateChecks++;
    if (state.run) {
      if (state.phase === 'admitted' && failedRuns.has(state.run)) report(7, 'failed run became admitted');
      if (state.phase === 'failed' || state.phase === 'commit-failed') {
        if (!failedRuns.has(state.run)) coverage.failedRuns++;
        failedRuns.add(state.run);
      }
    }
    const key = ctx.model ? JSON.stringify([ctx.model.provider, ctx.model.api, ctx.model.id]) : '';
    if (state.calibrationIdentity !== key) report(8, `calibration identity ${state.calibrationIdentity} differs from current model ${key}`);
    if (reset && state.pendingCut) report(9, 'pending cut survived a session/tree change');
    // Validate every observed D4 move, including intermediate starting/failed states.
    for (const { from, to } of setupMoves.splice(0)) if (!SEMANTIC_SETUP_TRANSITIONS[from].includes(to)) report(10, `unreachable D4 transition: ${from} -> ${to}`);
    const semantic = handle.semanticRecall.status();
    if (!(semantic.setup in SEMANTIC_SETUP_TRANSITIONS) || semantic.enabled !== (semantic.setup === 'ready') || semantic.setup === 'ready' && !semantic.configured)
      report(10, `unreachable D4 setup: ${JSON.stringify(semantic)}`);
  };
  rig.h.observeExtension(pi => {
    const semantic = rig.h.compactionHandle().semanticRecall, setSetup = semantic.setSetup.bind(semantic);
    semantic.setSetup = (...args) => {
      const from = semantic.status().setup;
      setSetup(...args);
      setupMoves.push({ from, to: semantic.status().setup });
    };
    // Observe intermediate phases too: settlement erases ordinary failed runs.
    pi.on('input', () => { checkState(); });
    pi.on('before_agent_start', () => { checkState(); });
    pi.on('agent_start', () => { checkState(); });
    pi.on('agent_settled', () => { checkState(); });
    pi.on('session_start', () => { checkState(true); });
    pi.on('session_tree', () => { checkState(true); });
  });
  let previousRequest: Context | undefined, previousAt = -1, requestNumber = 0, faultInjected = false;
  const boundaries = new Set<AppendOnlyExemption>();
  const observeRequest = (context: Context) => {
    requestNumber++;
    if (previousRequest) {
      // Count each exempt pair once. Completed public lifecycle actions take
      // precedence over summary/tool changes visible in the requests themselves.
      const boundary = (['new', 'tree', 'manual', 'abort', 'model', 'resume'] as const).find(reason => boundaries.has(reason));
      let pair = appendOnlyPair(previousRequest, context);
      if (!boundary && !pair.exempt && !pair.difference && !faultInjected && process.env.LIFECYCLE_FAULT === 'reorder') {
        const oldCount = previousRequest.messages.filter(message => message.role !== 'system'
          && summaryOf(requestText(message.content)) === undefined).length;
        const old = context.messages.map((message, index) => ({ message, index }))
          .filter(({ message }) => message.role !== 'system' && summaryOf(requestText(message.content)) === undefined).slice(0, oldCount);
        if (old.length >= 2) {
          const [left, right] = old.slice(-2).map(({ index }) => index);
          [context.messages[left], context.messages[right]] = [context.messages[right], context.messages[left]];
          faultInjected = true;
          pair = appendOnlyPair(previousRequest, context);
        }
      }
      const exemption = boundary ?? pair.exempt;
      if (exemption) appendOnly.exempt[exemption]++;
      else {
        appendOnly.checked++;
        if (pair.difference) report(6, `requests ${requestNumber - 1}->${requestNumber} (events ${previousAt + 1}->${at + 1}): ${pair.difference}`);
      }
    }
    previousRequest = context;
    previousAt = at;
    boundaries.clear();
  };
  try {
    seedHistory(rig, `${seed}-initial`);
    for (at = 0; at < events.length; at++) {
      const event = events[at];
      const marker = `SEQ-${event.kind}-${seed}-${at}`;
      trace.push(`${at + 1}:${event.kind === 'semantic' ? `semantic-${event.enabled ? 'on' : 'off'}` : event.kind}`
        + `${event.tokens ? `(${event.tokens}t)` : ''}${event.rounds ? `/${event.rounds} rounds` : ''}`);
      const oldFaults = rig.h.faults.length;
      const oldNotices = rig.h.notices.length;
      try {
        if (['new', 'tree', 'resume'].includes(event.kind)) {
          const ctx = rig.session.extensionRunner.createToolContext('sequence-before-reset', undefined);
          if (rig.h.compactionHandle().inspectState(ctx).pendingCut) coverage.pendingResets++;
        }
        if (event.kind === 'new') {
          await rig.session.abort();
          rig.manager.newSession();
          rig.session.agent.reset();
          // Pi's host owns /new. Its public manager, agent reset and real
          // session_start dispatch are sufficient for this in-memory host.
          await rig.session.extensionRunner.emit({ type: 'session_start', reason: 'new' });
          seedHistory(rig, `${seed}-${at}`);
          coverage.sessions++;
          boundaries.add('new');
        } else if (event.kind === 'tree') {
          const candidates = rig.manager.getEntries().filter(e => e.type === 'message' && e.message.role === 'assistant');
          if (!candidates.length) throw new Error('No earlier entry for tree move');
          const index = (event.target ?? 0) % Math.max(1, candidates.length - 1);
          const target = candidates[index];
          trace[at] += `->assistant[${index}]`;
          const result = await rig.session.navigateTree(target.id, { summarize: false });
          if (result.cancelled || result.aborted) throw new Error('Tree move was cancelled');
          coverage.treeMoves++;
          boundaries.add('tree');
        } else if (event.kind === 'resume') {
          if ((await rig.coldResume()).changedBranch) boundaries.add('resume');
          coverage.resumes++;
        } else if (event.kind === 'model') {
          await rig.session.setModel(event.switched ? switchedModel : originalModel);
          coverage.modelSwitches++;
          boundaries.add('model');
        } else if (event.kind === 'refusal') {
          const requests: Request[] = [];
          provider(rig, event, marker, requests, false, observeRequest);
          rig.setRefusal(true); // a real host reserve refusal; leave a normal-sized saved prompt
          try { await rig.session.prompt(body(marker, 200)); } finally { rig.setRefusal(false); }
          if (requests.length || rig.h.faults.length === oldFaults) report('harness', `capacity refusal did not block the provider: requests=${requests.length} faults=${JSON.stringify(rig.h.faults.slice(oldFaults))}`);
        } else if (event.kind === 'compact') {
          try { await rig.session.compact(); coverage.manual++; boundaries.add('manual'); }
          catch (error) { if (!/Already compacted|Nothing to compact/i.test(String(error))) throw error; }
        } else if (event.kind === 'semantic') {
          await rig.session.prompt(`/tuck-semantic ${event.enabled ? 'on' : 'off'}`);
        } else if (event.kind === 'handled') {
          const requests: Request[] = [];
          provider(rig, event, marker, requests, false, observeRequest);
          await rig.session.prompt(body(marker, event.tokens ?? 8000));
          if (requests.length) report('harness', 'the later extension failed to handle input');
          coverage.handled++;
        } else {
          const branch = structuredClone(rig.manager.getBranch());
          const requests: Request[] = [];
          // Retain the stress fixture's actual effect transport and large tool
          // results; change its callback through the supported option below.
          effectTokens = event.resultTokens ?? 7000;
          const content = await start(rig, event, marker, requests, true, observeRequest);
          coverage.requests += requests.length;
          if (event.kind === 'abort') { coverage.aborts++; boundaries.add('abort'); }
          if (!requests.length) report('harness', 'starting event reached no provider request');
          for (const [index, request] of requests.entries()) {
            const presence = inputPresence(request.context, content, event.kind === 'custom' ? 'custom' : 'user');
            if (!presence) report(3,
              `${marker} is absent as an original or whole verbatim summary quote in request ${index + 1}/${requests.length}; kept=${request.view.key}`);
            if (presence === 'quote') coverage.quotedPrompts++;
            checkSearch(request, (n, m) => report(n, m), coverage);
          }
          const previousSummary = branch.findLast(e => e.type === 'compaction') as CompactionEntry | undefined;
          if (requests[0]?.view.summary && (requests[0].view.summary !== previousSummary?.summary
            || previousSummary.firstKeptEntryId && requests[0].view.kept !== previousSummary.firstKeptEntryId)) {
            coverage.promptCuts++;
            const fresh = await open(branch, rig.manager.getCwd(), rig.session.model);
            try {
              const expected: Request[] = [];
              await start(fresh, { ...event, rounds: 0 }, marker, expected, false);
              compareFresh(requests[0], expected[0], (n, m) => report(n, m));
              for (const fault of fresh.h.faults) report('harness', `fresh install: ${fault}`);
              coverage.fresh++;
            } finally { await fresh.close(); }
          }
          for (let i = 1; i < requests.length; i++) if (requests[i].view.summary !== requests[i - 1].view.summary) coverage.boundaryCuts++;
          for (const request of requests) {
            // The pending first-turn cut may only be saved after this request.
            // Match its public summary to its eventual saved entry before comparing.
            const saved = rig.manager.getEntries().filter((e): e is CompactionEntry => e.type === 'compaction' && e.summary === request.view.summary);
            for (const cut of saved) {
              coverage.savedViews++;
              if (cut.firstKeptEntryId && cut.firstKeptEntryId !== request.view.kept) report(1,
                `saved cut keeps ${cut.firstKeptEntryId}, request keeps ${request.view.kept} (${request.view.key})`);
            }
          }
          for (const request of requests.filter(r => r.searchCall)) {
            const entry = rig.manager.getEntries().find(e => e.type === 'message' && e.message.role === 'toolResult'
              && e.message.toolCallId === request.searchCall);
            if (!entry || entry.type !== 'message' || entry.message.role !== 'toolResult' || entry.message.isError) {
              report('harness', `model-issued tuck_search ${request.searchCall} did not return a successful result: ${entry?.type === 'message' && entry.message.role === 'toolResult' ? textOf(entry.message.content) : '(no result)'}`);
            } else {
              coverage.modelSearches++;
              checkSearch({ ...request, search: entry.message.content.filter(c => c.type === 'text').map(c => c.text) },
                (n, m) => report(n, m), coverage);
            }
          }
        }
        for (const cut of rig.manager.getEntries().filter((e): e is CompactionEntry => e.type === 'compaction')) {
          // Preserve the brief's literal membership rule. Report Pi's empty
          // compact-all sentinel separately from a nonempty off-branch anchor.
          if (!rig.manager.getBranch(cut.id).some(e => e.id === cut.firstKeptEntryId)) report(2,
            cut.firstKeptEntryId ? `compaction's kept entry ${cut.firstKeptEntryId} is outside its own branch`
              : 'empty firstKeptEntryId (Pi compact-all sentinel) is not an entry on the compaction branch');
        }
        await checkSemantic(rig, oldNotices, (n, m) => report(n, m), coverage);
        for (const fault of rig.h.faults.slice(oldFaults)) if (event.kind !== 'refusal' || !/Incoming Pi prompt and response reserve cannot fit/.test(fault)) report('harness', fault);
      } catch (error) { report('harness', String(error)); }
      checkState(['new', 'tree', 'resume'].includes(event.kind));
    }
    return { seed, findings, coverage, appendOnly, trace };
  } finally { await rig.close(); }
}

// Passed to the existing harness's actual effect tool, not a pi-tuck hook.
let effectTokens = 7000;
