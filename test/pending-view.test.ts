import { expect, test, vi } from 'vitest';
import { convertToLlm, SessionManager, SettingsManager, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { installCompaction } from '../src/compaction';
import { PendingCut, StartingPrompt, createRun } from '../src/run';
import { createSemanticRecall } from '../src/semantic-recall';
import { projectedMessages } from '../src/omissions';
import { carriesPrompt } from '../src/request-capacity';
import { scriptedModelRuntime } from './model-fixture';

const bands = vi.hoisted(() => [] as { tokensAfter: number }[]);
vi.mock('../src/budget', async original => {
  const real = await original<typeof import('../src/budget')>();
  return { ...real, bandOf: (...args: Parameters<typeof real.bandOf>) => { if (args[2]) bands.push(args[2]); return real.bandOf(...args); } };
});

async function fixture(compactAll = false) {
  const manager = SessionManager.inMemory('/virtual/pi-tuck-test/pending-view');
  const runtime = await scriptedModelRuntime({ contextWindow: 32768, maxTokens: 4096 });
  const model = runtime.getModel('openai-codex', 'gpt-6.1-sol')!;
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  for (let i = 0; i < 12; i++) {
    manager.appendMessage({ role: 'user', content: `task ${i}: ` + 'context '.repeat(400), timestamp: i });
    manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: compactAll && i === 11 ? 'word '.repeat(53000) : `done ${i}: ` + 'answer '.repeat(400) }],
      api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: i, usage });
  }
  const handlers = new Map<string, ((event: any, ctx: ExtensionContext) => any)[]>(), tools = new Map<string, any>(), commands = new Map<string, any>();
  const notices: string[] = [], faults: unknown[] = []; let active: string[] = [];
  const pi = { on: (name: string, handler: any) => { handlers.set(name, [...handlers.get(name) ?? [], handler]); },
    registerTool: (tool: any) => { tools.set(tool.name, tool); }, registerCommand: (name: string, command: any) => { commands.set(name, command); },
    getAllTools: () => [...tools.values()], getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; },
    appendEntry: (type: string, data: unknown) => manager.appendCustomEntry(type, data),
  } as unknown as ExtensionAPI;
  const ctx = { cwd: '/virtual/pi-tuck-test/pending-view', sessionManager: manager, model, signal: new AbortController().signal,
    isIdle: () => true, getSystemPrompt: () => 'Follow the current task.', abort: () => {}, ui: { notify: (message: string) => { notices.push(message); } },
  } as unknown as ExtensionContext;
  const semantic = createSemanticRecall();
  const search = vi.spyOn(semantic, 'search').mockImplementation(async (_query, provider) => {
    const snapshot = provider(); return { status: 'disabled', notice: '', coverage: { ...semantic.status(), snapshotId: snapshot.id, window: null }, groups: [] };
  });
  const handle = await installCompaction(pi, { settings: SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 4096, keepRecentTokens: 0 } }),
    requestReserve: () => ({ response: 4096, responseExact: true }), semanticRecall: semantic, fail: error => faults.push(error) });
  const emit = async (name: string, event: any = {}) => {
    let result: any;
    for (const handler of handlers.get(name) ?? []) { const value = await handler(event, ctx); if (value !== undefined) result = value; }
    return result;
  };
  const prompt = 'STARTING-PROMPT ' + 'prompt text '.repeat(50);
  await emit('input', { text: prompt });
  await commands.get('tuck').handler('', ctx);
  expect(notices.at(-1)).toContain('A cut is pending');
  expect(faults).toEqual([]);
  return { manager, ctx, emit, pi, tools, commands, notices, faults, prompt, handle, search };
}
const plain = (messages: any[]) => convertToLlm(messages).map(({ timestamp: _timestamp, ...message }) => message);

test('switching to an unknown window discards a pending cut and preserves the native request', async () => {
  const h = await fixture();
  try {
    h.ctx.model = { ...h.ctx.model!, contextWindow: 0 };
    const messages = h.manager.buildSessionProjection().messages;
    expect(await h.emit('context', { messages })).toBeUndefined();
    expect(await h.emit('context_with_system', { messages })).toBeUndefined();
    expect(await h.emit('agent_before_settle', { outcome: 'completed', entries: [],
      context: { contextMessages: messages, pendingMessages: [], canContinue: false } })).toBeUndefined();
    expect(h.manager.getBranch().some(entry => entry.type === 'compaction')).toBe(false);
    expect(h.faults).toEqual([]);
  } finally { await h.handle.close(); }
});

test.each([false, true])('an uncut length retry checks whether its pending cut was committed (saved=%s)', async saved => {
  const h = await fixture();
  try {
    await h.emit('before_agent_start', { messageType: 'user', prompt: h.prompt, systemPrompt: h.ctx.getSystemPrompt(), systemPromptOptions: { selectedTools: [] } });
    await h.emit('agent_start');
    h.manager.appendMessage({ role: 'user', content: h.prompt, timestamp: 123 });
    const message = { role: 'assistant' as const, content: [{ type: 'thinking' as const, thinking: 'unfinished' }],
      api: h.ctx.model!.api, provider: h.ctx.model!.provider, model: h.ctx.model!.id, stopReason: 'length' as const, timestamp: 124,
      usage: { input: 0, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const messageEntryId = h.manager.appendMessage(message);
    const context = { contextMessages: h.manager.buildSessionProjection().messages, pendingMessages: [], canContinue: true };
    const retry = await h.emit('turn_end', { message, messageEntryId, entries: [], toolResults: [], outcome: 'completed', context });
    expect(retry.continue).toBe(true);
    expect(retry.entries.find((entry: any) => entry.customType === 'pi-tuck-capacity')?.data.cut).toBe(false);
    const cut = retry.entries.find((entry: any) => entry.type === 'compaction');
    expect(cut).toBeDefined();
    if (saved) h.manager.appendCompaction(cut.summary, cut.firstKeptEntryId, 0, cut.details, true);
    // A failed native boundary may have saved the cut before failing on a later draft.
    await h.emit('agent_before_settle', { outcome: 'error', entries: [], context });
    if (saved) expect(h.faults).toEqual([]);
    else expect(h.faults.map(String).join(' ')).toContain('Native tool-loop boundary cut was not saved in the session file');
  } finally { await h.handle.close(); }
});

test('pending request, semantic snapshot, executable tools, status and boundary save share one resolved view', async () => {
  const h = await fixture();
  try {
    expect(h.manager.getBranch().some(entry => entry.type === 'compaction')).toBe(false);
    expect(h.pi.getActiveTools()).toEqual(['tuck_recall', 'tuck_search']);
    await h.emit('before_agent_start', { messageType: 'user', prompt: h.prompt, systemPrompt: h.ctx.getSystemPrompt(), systemPromptOptions: { selectedTools: [] } });
    await h.emit('agent_start');
    const promptId = h.manager.appendMessage({ role: 'user', content: h.prompt, timestamp: 123 });
    const saved = h.manager.buildSessionProjection().messages;
    const request = await h.emit('context', { messages: saved });
    expect(carriesPrompt(request.messages, h.prompt)).toBe(true);
    await h.tools.get('tuck_search').execute('search', { query: 'context' }, undefined, undefined, h.ctx);
    const provider = h.search.mock.calls.at(-1)![1], snapshot = provider();
    const summary = request.messages.find((message: any) => message.role === 'compactionSummary');
    expect(summary).toBeDefined();
    const oldBandCalls = bands.length;
    const boundary = await h.emit('agent_before_settle', { entries: [], outcome: 'completed', context: { contextMessages: saved, pendingMessages: [], canContinue: false } });
    const cut = boundary.entries[0];
    const expectedStart = h.manager.getBranch().findIndex(entry => entry.id === cut.firstKeptEntryId);
    expect(snapshot.viewStart).toBe(expectedStart < 0 ? h.manager.getBranch().length : expectedStart);
    expect(bands.slice(oldBandCalls)).toContainEqual(expect.objectContaining({ tokensAfter: cut.details.tokensAfter }));
    expect(cut.summary).toBe(summary.summary);
    h.manager.appendCompaction(cut.summary, cut.firstKeptEntryId, 0, cut.details, true);
    expect(plain(projectedMessages(h.manager.buildSessionProjection().messages, h.ctx))).toEqual(plain(request.messages));
    expect(h.manager.getBranch().some(entry => entry.id === promptId)).toBe(true);
    await h.commands.get('tuck').handler('', h.ctx);
    expect(h.notices.at(-1)).not.toContain('A cut is pending');
    expect(h.faults).toEqual([]);
  } finally { await h.handle.close(); }
});

test('threshold uses the resolved kept entry when the prompt already exists', async () => {
  const h = await fixture(true);
  try {
    h.manager.appendCustomEntry('pi-tuck-capacity', {});
    const promptId = h.manager.appendMessage({ role: 'user', content: h.prompt, timestamp: 123 });
    const request = await h.emit('context', { messages: h.manager.buildSessionProjection().messages });
    const threshold = await h.emit('session_before_compact', { reason: 'threshold', signal: new AbortController().signal });
    const cut = threshold.compaction;
    expect(cut).toBeDefined();
    expect(cut.firstKeptEntryId).toBe(promptId);
    h.manager.appendCompaction(cut.summary, cut.firstKeptEntryId, cut.tokensBefore, cut.details, true);
    expect(plain(projectedMessages(h.manager.buildSessionProjection().messages, h.ctx))).toEqual(plain(request.messages));
    expect(carriesPrompt(request.messages, h.prompt)).toBe(true);
    expect(h.manager.getBranch().some(entry => entry.id === promptId)).toBe(true);
  } finally { await h.handle.close(); }
});

test('compact-all resolves at the plan boundary, before later steering and after capacity receipts', () => {
  const manager = SessionManager.inMemory('/virtual/pi-tuck-test/pending-owner'), pending = new PendingCut(), ctx = { cwd: '/virtual/pi-tuck-test/pending-owner', sessionManager: manager };
  manager.appendMessage({ role: 'user', content: 'old', timestamp: 0 });
  const length = manager.getBranch().length;
  pending.plan({ type: 'compaction', summary: 'summary', firstKeptEntryId: '', tokensBefore: 10, details: { compactor: 'pi-tuck' } }, length);
  expect(pending.view(ctx)).toMatchObject({ keptFromId: '', viewStart: length, pending: true, hasTuckCut: true });
  manager.appendCustomEntry('pi-tuck-capacity', {});
  const promptId = manager.appendMessage({ role: 'user', content: 'prompt', timestamp: 1 });
  manager.appendMessage({ role: 'user', content: 'steering', timestamp: 2 });
  expect(pending.view(ctx).keptFromId).toBe(promptId);
  expect(pending.take()).toBeDefined(); expect(pending.take()).toBeUndefined(); expect(pending.view(ctx).pending).toBe(false);
  pending.plan({ type: 'compaction', summary: 'summary', firstKeptEntryId: promptId, tokensBefore: 1 }, length);
  pending.clear(); expect(pending.view(ctx).pending).toBe(false);
});

test('starting prompt binds once to its entry, including repeated text in steering', () => {
  const manager = SessionManager.inMemory('/virtual/pi-tuck-test/prompt-owner'), prompt = new StartingPrompt('start', 0);
  expect(prompt.id(manager.getBranch())).toBeUndefined();
  const id = manager.appendMessage({ role: 'user', content: 'start', timestamp: 1 });
  expect(prompt.id(manager.getBranch())).toBe(id);
  manager.appendMessage({ role: 'user', content: 'steer start', timestamp: 2 });
  expect(prompt.id(manager.getBranch())).toBe(id); expect(prompt.text(manager.getBranch())).toBe('start');
  expect(createRun('decided')).toMatchObject({ phase: 'decided', pendingBoundaryReceipts: [] });
});

test('a custom starting prompt binds by role and entry id before later identical custom text', () => {
  const manager = SessionManager.inMemory('/virtual/pi-tuck-test/custom-prompt-owner');
  manager.appendCustomMessageEntry('old', 'start', false);
  const prompt = new StartingPrompt('start', manager.getBranch().length, 'custom');
  manager.appendMessage({ role: 'user', content: 'start', timestamp: 0 });
  expect(prompt.id(manager.getBranch())).toBeUndefined();
  const id = manager.appendCustomMessageEntry('starting', [{ type: 'text', text: 'start' }], false);
  expect(prompt.id(manager.getBranch())).toBe(id);
  manager.appendCustomMessageEntry('steering', 'start', false);
  expect(prompt.id(manager.getBranch())).toBe(id);
  expect(prompt.text(manager.getBranch())).toBe('start');
  expect(prompt.role).toBe('custom');
});

test('retry boundary drafts use the same view as their committed session', () => {
  const manager = SessionManager.inMemory('/virtual/pi-tuck-test/retry-view'), cut = new PendingCut();
  const ctx = { cwd: '/virtual/pi-tuck-test/retry-view', sessionManager: manager };
  const id = manager.appendMessage({ role: 'user', content: 'omitted failed reply witness', timestamp: 0 });
  const entries = [
    { type: 'context_edit' as const, targetId: id, replacement: null },
    { type: 'custom_message' as const, customType: 'retry', content: 'continue', display: false },
    { type: 'custom' as const, customType: 'pi-tuck-capacity', data: { kind: 'retry' } },
  ];
  const preview = cut.view(ctx, entries);
  expect(preview.session.buildSessionProjection().messages.some(message => carriesPrompt([message], 'omitted failed reply witness'))).toBe(false);
  expect(cut.view(ctx).session).toBe(manager); // hypothetical drafts never poison the live view cache
  manager.appendContextEdit(id, null);
  manager.appendCustomMessageEntry('retry', 'continue', false);
  manager.appendCustomEntry('pi-tuck-capacity', { kind: 'retry' });
  expect(plain(preview.session.buildSessionProjection().messages)).toEqual(plain(manager.buildSessionProjection().messages));
  expect(cut.view(ctx).viewStart).toBe(preview.viewStart);
});


test('the normal pre-append threshold keeps the compact-all boundary empty', async () => {
  const h = await fixture(true);
  try {
    const threshold = await h.emit('session_before_compact', { reason: 'threshold', signal: new AbortController().signal });
    expect(threshold.compaction.firstKeptEntryId).toBe('');
    h.manager.appendCompaction(threshold.compaction.summary, '', threshold.compaction.tokensBefore, threshold.compaction.details, true);
    h.manager.appendMessage({ role: 'user', content: h.prompt, timestamp: 123 });
    expect(carriesPrompt(h.manager.buildSessionProjection().messages, h.prompt)).toBe(true);
    expect(h.faults).toEqual([]);
  } finally { await h.handle.close(); }
});

test('an expired user decision still carries its original cut into its own run', async () => {
  const h = await fixture();
  try {
    const length = h.manager.getBranch().length;
    h.manager.appendMessage({ role: 'user', content: h.prompt, timestamp: 123 });
    const before = await h.emit('context', { messages: h.manager.buildSessionProjection().messages });
    // Return to the actual before_agent_start ordering by using the branch before the prompt was appended.
    h.manager.branch(h.manager.getBranch()[length - 1]!.id);
    await new Promise<void>(resolve => setImmediate(resolve));
    await h.emit('before_agent_start', { messageType: 'user', prompt: h.prompt, systemPrompt: h.ctx.getSystemPrompt(), systemPromptOptions: { selectedTools: [] } });
    h.manager.appendMessage({ role: 'user', content: h.prompt, timestamp: 123 });
    const after = await h.emit('context', { messages: h.manager.buildSessionProjection().messages });
    expect(plain(after.messages)).toEqual(plain(before.messages));
    expect(h.faults).toEqual([]);
  } finally { await h.handle.close(); }
});


for (const event of ['agent_settled', 'session_start', 'session_tree']) test(`${event} drops the run and all its pending state`, async () => {
  const h = await fixture();
  try {
    await h.emit(event);
    await h.commands.get('tuck').handler('', h.ctx);
    expect(h.notices.at(-1)).not.toContain('A cut is pending');
    expect(h.pi.getActiveTools()).toEqual([]);
    const saved = h.manager.buildSessionProjection().messages;
    expect(await h.emit('context', { messages: saved })).toBeUndefined();
    expect(h.faults).toEqual([]);
  } finally { await h.handle.close(); }
});

test('fail drops a pending cut and keeps the failed attempt blocked until settlement', async () => {
  const h = await fixture();
  try {
    await h.emit('context', { messages: [{ role: 'user', content: 'not the saved conversation', timestamp: 0 }] });
    expect(h.faults).toHaveLength(1);
    await h.commands.get('tuck').handler('', h.ctx);
    expect(h.notices.at(-1)).not.toContain('A cut is pending');
    await h.emit('agent_start');
    await h.emit('context_with_system', { messages: h.manager.buildSessionProjection().messages });
    expect(h.faults).toHaveLength(2); // a fresh native controller still cannot submit this failed attempt
    await h.emit('agent_settled');
    await h.emit('context_with_system', { messages: h.manager.buildSessionProjection().messages });
    expect(h.faults).toHaveLength(2);
  } finally { await h.handle.close(); }
});


test('the live view follows saved cuts and tree moves after a pending cut is consumed', () => {
  const manager = SessionManager.inMemory('/virtual/pi-tuck-test/live-view'), cut = new PendingCut();
  const ctx = { cwd: '/virtual/pi-tuck-test/live-view', sessionManager: manager };
  const first = manager.appendMessage({ role: 'user', content: 'first', timestamp: 0 });
  expect(cut.view(ctx)).toMatchObject({ session: manager, hasTuckCut: false, viewStart: 0 });
  const kept = manager.appendMessage({ role: 'user', content: 'kept', timestamp: 1 });
  cut.plan({ type: 'compaction', summary: 'summary', firstKeptEntryId: kept, tokensBefore: 1, details: { compactor: 'pi-tuck' } }, 2);
  const pending = cut.view(ctx), entry = cut.take()!;
  manager.appendCompaction(entry.summary, entry.firstKeptEntryId, entry.tokensBefore, entry.details, true);
  expect(cut.view(ctx)).toMatchObject({ keptFromId: kept, viewStart: pending.viewStart, hasTuckCut: true, pending: false });
  manager.branch(first);
  expect(cut.view(ctx)).toMatchObject({ keptFromId: undefined, viewStart: 0, hasTuckCut: false });
});
