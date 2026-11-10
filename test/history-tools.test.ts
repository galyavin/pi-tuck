import { expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage, type Context } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { installCompaction, type CompactionOptions } from '../src/compaction';
import * as historyTools from '../src/history-tools';
import { serializeTranscript } from '../src/tuck/core/transcript';
import { DIALOGUE_SUFFIX } from '../src/tuck/core/format';
import { scriptedModelRuntime } from './model-fixture';
import { harness, receiptOf } from './budget-fixture';

const own = ['tuck_recall', 'tuck_search'];
const names = (ctx: Context) => getCurrentTools(ctx.messages).map(tool => tool.name);
const summary = serializeTranscript([{ kind: 'omission', reason: 'Earlier conversation is out of view.' }]) + DIALOGUE_SUFFIX;
const cut = (manager: SessionManager, native = false) => manager.appendCompaction(summary, '', 10000,
    native ? { readFiles: [], modifiedFiles: [] } : { compactor: 'pi-tuck', version: 2, adapter: 'standalone' }, !native);

async function fixture(dir: string, manager: SessionManager, installed = true, search = true, options: CompactionOptions = {}, result = 'foreign result') {
    const runtime = await scriptedModelRuntime({ contextWindow: 32768, maxTokens: 4096 });
    const model = runtime.getModel('openai-codex', 'gpt-6.1-sol')!;
    const settings = options.settings ?? SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: true, reserveTokens: 4096, keepRecentTokens: 0 } });
    let pi: ExtensionAPI | undefined, handle: Awaited<ReturnType<typeof installCompaction>> | undefined;
    const faults: string[] = [], requests: Context[] = [];
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings, noExtensions: true, noSkills: true,
        noContextFiles: true, noPromptTemplates: true, noThemes: true, systemPrompt: 'Follow the current task.', extensionFactories: [async api => {
            pi = api;
            api.registerTool({ name: 'foreign', label: 'Foreign', description: 'Another extension tool.', parameters: Type.Object({}),
                execute: async () => ({ content: [{ type: 'text', text: result }], details: {} }) });
            if (installed) handle = await installCompaction(api, { search, settings, cutAt: 1, fail: error => faults.push(String(error)), ...options });
        }] });
    await loader.reload();
    const { session } = await createAgentSession({ cwd: dir, modelRuntime: runtime, model, thinkingLevel: 'low', sessionManager: manager,
        settingsManager: settings, resourceLoader: loader, tools: ['alpha', 'omega', 'foreign', ...own], customTools: ['alpha', 'omega'].map(name => ({
            name, label: name, description: `${name} host tool.`, parameters: Type.Object({}), execute: async () => ({ content: [], details: {} }),
        })) });
    await session.bindExtensions({ onError: event => faults.push(event.error) });
    const answer = (text = 'Done'): AssistantMessage => ({ role: 'assistant', content: [{ type: 'text', text }], api: model.api,
        provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    session.agent.streamFunction = (_model, ctx) => {
        requests.push(structuredClone(ctx));
        const stream = createAssistantMessageEventStream(), message = answer();
        stream.push({ type: 'done', reason: 'stop', message }); stream.end(message); return stream;
    };
    return { session, pi: pi!, faults, requests, answer, close: async () => { await session.abort(); await handle?.close(); session.dispose(); } };
}

test('before any cut every request is byte-identical to Pi without pi-tuck, across multiple prompts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tuck-tools-parity-'));
    const time = vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    try {
        const captured: Context[][] = [];
        for (const installed of [false, true]) {
            const f = await fixture(dir, SessionManager.inMemory(dir), installed);
            try {
                await f.session.prompt('First task'); await f.session.prompt('Continue exactly');
                expect(f.faults).toEqual([]);
                expect(f.session.sessionManager.getBranch().some(entry => entry.type === 'compaction')).toBe(false);
                captured.push(f.requests);
            } finally { await f.close(); }
        }
        // Pi times each reply with a clock the Date.now mock does not fix, so `durationMs` is zeroed on both sides; every other byte is compared.
        const stable = (requests: Context[]) => JSON.stringify(requests, (key, value) => key === 'durationMs' ? 0 : value);
        expect(JSON.parse(stable(captured[1]!))).toEqual(JSON.parse(stable(captured[0]!)));
        expect(stable(captured[1]!)).toBe(stable(captured[0]!));
    } finally { time.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
});

test('both request hooks return undefined and preserve every pre-cut request object, including a native summary', async () => {
    const handlers: Record<string, ((event: { messages: unknown[] }, ctx: unknown) => unknown)[]> = {};
    const tools: { name: string }[] = [];
    const pi = { on: (name: string, handler: (event: { messages: unknown[] }, ctx: unknown) => unknown) => { (handlers[name] ??= []).push(handler); },
        registerCommand: () => {}, registerTool: (tool: { name: string }) => tools.push(tool), getAllTools: () => tools, getActiveTools: () => [] } as unknown as ExtensionAPI;
    const handle = await installCompaction(pi, { requestReserve: () => ({ response: 16384, responseExact: true }) });
    try {
        for (const native of [false, true]) {
            const manager = SessionManager.inMemory('/unchanged-request');
            manager.appendMessage({ role: 'user', content: 'Earlier task', timestamp: 1 });
            if (native) manager.appendCompaction('A native Pi summary with its own format.', '', 10, { readFiles: [], modifiedFiles: [] });
            const messages = [{ role: 'system', content: 'Original system', timestamp: 123, sections: { original: 'Keep this section' } },
                ...manager.buildSessionProjection().messages];
            const event = { messages }, original = structuredClone(messages), serialized = JSON.stringify(messages);
            const ctx = { sessionManager: manager, cwd: '/unchanged-request', model: { provider: 'test', id: 'test', contextWindow: 32768, maxTokens: 16384 },
                getSystemPrompt: () => 'Original system', abort: () => { throw Error('Unexpected refusal'); } };
            for (const hook of ['context', 'context_with_system']) for (const handler of handlers[hook] ?? []) {
                expect(await handler(event, ctx), hook).toBeUndefined();
                expect(event.messages).toBe(messages);
                expect(messages, hook).toEqual(original);
                expect(JSON.stringify(messages), hook).toBe(serialized);
                expect(messages[0]).toHaveProperty('timestamp', 123);
            }
        }
    } finally { await handle.close(); }
});

for (const legacy of [false, true]) for (const cutAt of [undefined, 1])
test(`cut positions and complete post-cut requests equal the always-declared tools protocol (cutAt=${cutAt ?? 'adaptive'}, legacy=${legacy})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tuck-tools-cut-parity-'));
    vi.useFakeTimers({ toFake: ['Date', 'performance'] }); vi.setSystemTime(1700000000000);
    const fullNames = historyTools.historyToolNames;
    try {
        let seed: Parameters<typeof SessionManager.inMemory>[2];
        if (legacy) {
            const apply = vi.spyOn(historyTools, 'applyHistoryTools').mockImplementation(() => {});
            const names = vi.spyOn(historyTools, 'historyToolNames').mockImplementation((pi, selected) => fullNames(pi, selected, true));
            const manager = SessionManager.inMemory(dir), f = await fixture(dir, manager);
            try {
                await f.session.prompt('Earlier task'); cut(manager);
                seed = structuredClone([manager.getHeader()!, ...manager.getEntries()]);
            } finally { await f.close(); names.mockRestore(); apply.mockRestore(); }
        }
        const runs: { cutRequests: number[]; cuts: unknown[]; requests: Context[] }[] = [];
        for (const alwaysDeclared of [true, false]) {
            vi.setSystemTime(1700000000000);
            // The reference keeps the pre-change protocol: our tools stay declared from the first request. The planner, Pi runtime,
            // messages and settings are otherwise identical, so this detects a split between trigger and post-cut accounting.
            const apply = alwaysDeclared ? vi.spyOn(historyTools, 'applyHistoryTools').mockImplementation(() => {}) : undefined;
            const names = alwaysDeclared ? vi.spyOn(historyTools, 'historyToolNames').mockImplementation((pi, selected) => fullNames(pi, selected, true)) : undefined;
            const f = await fixture(dir, SessionManager.inMemory(dir, undefined, seed && structuredClone(seed)), true, true,
                { cutAt, requestReserve: () => ({ response: 16384, responseExact: true }),
                    settings: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 0 } }) },
                'Observed result. '.repeat(450));
            let request = 0;
            const requests: Context[] = [], cutRequests: number[] = [];
            f.session.agent.streamFunction = (_model, ctx) => {
                request++;
                vi.setSystemTime(1700000000000 + request * 1000);
                const hasSummary = f.session.sessionManager.getBranch().some(entry => entry.type === 'compaction');
                if (hasSummary) { requests.push(structuredClone(ctx)); cutRequests.push(request); }
                // Cross Pi's no-usage threshold on the final reply too: it runs before agent_before_settle and supplies a different
                // density estimate than a tool-loop/run-end draft, even though both must use the same budget.
                const message = { ...f.answer('Final recorded observation. '.repeat(1600)), ...(request <= 18 ? { content: [{ type: 'toolCall' as const, id: `result-${request}`, name: 'foreign', arguments: {} }], stopReason: 'toolUse' as const } : {}) };
                const stream = createAssistantMessageEventStream(); stream.push({ type: 'done', reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop', message }); stream.end(message); return stream;
            };
            try {
                await f.session.prompt('Inspect all observations and report the outcome.');
                expect(f.faults).toEqual([]);
                const manager = f.session.sessionManager;
                const sourceMessages = manager.getEntries().filter(entry => entry.type === 'message' && entry.message.role !== 'system');
                const cuts = manager.getBranch().filter(entry => entry.type === 'compaction').map(entry => ({
                    summary: entry.summary, firstKept: sourceMessages.findIndex(source => source.id === entry.firstKeptEntryId),
                }));
                expect(cuts.length).toBeGreaterThan(1); expect(requests.length).toBeGreaterThan(0);
                runs.push({ cutRequests, cuts, requests });
            } finally { await f.close(); names?.mockRestore(); apply?.mockRestore(); }
        }
        expect(runs[1]!.cutRequests).toEqual(runs[0]!.cutRequests);
        expect(runs[1]!.cuts).toEqual(runs[0]!.cuts);
        // As above: `durationMs` comes from a clock the fake timers do not fix; every other byte is compared.
        const stable = (requests: unknown) => JSON.stringify(requests, (key, value) => key === 'durationMs' ? 0 : value);
        expect(JSON.parse(stable(runs[1]!.requests))).toEqual(JSON.parse(stable(runs[0]!.requests)));
        expect(stable(runs[1]!.requests)).toBe(stable(runs[0]!.requests));
    } finally { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); }
});

for (const native of [false, true]) for (const search of [false, true])
test(`resume derives tools from the branch marker (native=${native}, search=${search})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tuck-tools-resume-'));
    let f: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
        const manager = SessionManager.create(dir, dir);
        manager.appendMessage({ role: 'user', content: 'Old task', timestamp: 0 });
        // An assistant flushes Pi's lazily-created session file.
        f = await fixture(dir, manager, false); await f.session.prompt('Finish old task'); await f.close(); f = undefined;
        cut(manager, native);
        f = await fixture(dir, SessionManager.open(manager.getSessionFile()!, dir), true, search);
        await f.session.prompt('Resume');
        expect(names(f.requests[0]!).filter(name => own.includes(name))).toEqual(native ? [] : search ? own : own.slice(0, 1));
        expect(f.faults).toEqual([]);
    } finally { await f?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('/tree before the first cut disables tools, and returning to its branch enables them again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tuck-tools-tree-')), manager = SessionManager.inMemory(dir);
    const f = await fixture(dir, manager);
    try {
        await f.session.prompt('Before the cut');
        const before = manager.getLeafId()!, compacted = cut(manager);
        await f.session.prompt('After the cut');
        await f.session.navigateTree(before); await f.session.prompt('Alternate branch before any cut');
        await f.session.navigateTree(compacted); await f.session.prompt('Return to the cut');
        expect(f.requests.map(request => names(request).filter(name => own.includes(name)))).toEqual([[], own, [], own]);
        expect(f.faults).toEqual([]);
    } finally { await f.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('forked session files before and after the first cut restore the corresponding tools', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tuck-tools-fork-')), manager = SessionManager.create(dir, dir);
    let f = await fixture(dir, manager);
    try {
        await f.session.prompt('Before the cut'); const before = manager.getLeafId()!;
        const compacted = cut(manager); await f.close();
        for (const [leaf, expected] of [[before, []], [compacted, own]] as const) {
            // The SessionManager operation used by Pi's /fork, including its new file and retained path.
            const source = SessionManager.open(manager.getSessionFile()!, dir);
            const path = source.createBranchedSession(leaf)!;
            f = await fixture(dir, SessionManager.open(path, dir)); await f.session.prompt('Continue fork');
            expect(names(f.requests[0]!).filter(name => own.includes(name))).toEqual(expected);
            expect(f.faults).toEqual([]); await f.close();
        }
    } finally { await f.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('host and other extensions keep their active tools, schemas and order on both sides of a cut', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tuck-tools-others-')), manager = SessionManager.inMemory(dir);
    const f = await fixture(dir, manager);
    try {
        f.pi.setActiveTools(['omega', 'tuck_recall', 'foreign', 'alpha', 'tuck_search']);
        // Pi 1.5 preserves the prior order when a caller asks to reorder tools. Use the host's actual set as the contract.
        const host = f.pi.getActiveTools().filter(name => !own.includes(name));
        await f.session.prompt('No cut');
        expect(f.pi.getActiveTools()).toEqual(host);
        const before = getCurrentTools(f.requests[0]!.messages);
        cut(manager); await f.session.prompt('A cut exists');
        expect(f.pi.getActiveTools()).toEqual([...host, ...own]);
        expect(getCurrentTools(f.requests[1]!.messages).filter(tool => !own.includes(tool.name))).toEqual(before);
        f.pi.setActiveTools(['foreign', 'omega']);
        const changed = f.pi.getActiveTools().filter(name => !own.includes(name));
        await f.session.prompt('Host changes its loadout');
        expect(f.pi.getActiveTools()).toEqual([...changed, ...own]);
        // Pi replays declarations by name, retaining the order of tools already declared.
        expect(getCurrentTools(f.requests[2]!.messages).filter(tool => !own.includes(tool.name))).toEqual(before.filter(tool => changed.includes(tool.name)));
        expect(f.faults).toEqual([]);
    } finally { await f.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('the first request carrying an unsaved prompt cut declares tools and reserves their schemas', async () => {
    const h = await harness({ at: 'prompt', complete: 144100, host: 0, liveTools: true });
    const requests: { tools: string[]; saved: number }[] = [];
    h.extension().on('context_with_system', event => { requests.push({ tools: getCurrentTools(event.messages as never).map(tool => tool.name), saved: h.compactions().length }); });
    try {
        const result = await h.run();
        expect(result.faults, result.probe).toEqual([]);
        expect(requests[0]!.saved).toBe(0);
        expect(requests[0]!.tools).toEqual(expect.arrayContaining(own));
        const receipt = receiptOf(result.entries[0]!);
        expect(receipt.reason).toBe('prompt');
        expect(receipt.mandatoryInputTokens).toBeGreaterThan(h.mandatory + h.promptTokens() + 1000);
        expect(result.guard[0]).toBeLessThan(144000);
    } finally { await h.cleanup(); }
});

test('the first request after an in-loop cut declares executable recall tools within the same run', async () => {
    const h = await harness({ at: 'tool', complete: 144100, host: 0, liveTools: true });
    const stream = h.session.agent.streamFunction!;
    const requests: Context[] = [];
    h.session.agent.streamFunction = (model, ctx, options) => {
        requests.push(structuredClone(ctx));
        if (requests.length === 2) {
            const message = h.answer([{ type: 'toolCall', id: 'immediate-recall', name: 'tuck_recall', arguments: { index: 0 } }], 'toolUse');
            const result = createAssistantMessageEventStream(); result.push({ type: 'done', reason: 'toolUse', message }); result.end(message); return result;
        }
        return stream(model, ctx, options);
    };
    try {
        const result = await h.run();
        expect(result.faults, result.probe).toEqual([]);
        expect(names(requests[0]!).filter(name => own.includes(name))).toEqual([]);
        expect(names(requests[1]!).filter(name => own.includes(name))).toEqual(own);
        expect(result.entries.map(entry => receiptOf(entry).reason)).toContain('tool-loop');
        expect(h.session.agent.state.tools.map(tool => tool.name)).toEqual(expect.arrayContaining(own));
        const recalled = h.session.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'immediate-recall');
        expect(recalled).toMatchObject({ role: 'toolResult', isError: false });
    } finally { await h.cleanup(); }
});

test('an in-loop prompt cut declares tools in its first request, before a boundary saves the cut', async () => {
    const h = await harness({ at: 'tool', complete: 90000, host: 0, queued: 4000, liveTools: true });
    let turns = 0;
    // The host grows after turn_end has decided. On message_end the queued steering prompt plans its cut inside this run,
    // after Pi has already prepared the request's tool declarations and before it snapshots executable tools.
    h.extension().on('turn_start', () => { if (++turns === 2) h.setHost(60000); });
    const requests: { tools: string[]; saved: number }[] = [];
    h.extension().on('context_with_system', event => { requests.push({ tools: getCurrentTools(event.messages as never).map(tool => tool.name), saved: h.compactions().length }); });
    const stream = h.session.agent.streamFunction!;
    let calls = 0;
    h.session.agent.streamFunction = (model, ctx, options) => {
        if (++calls === 2) {
            const message = h.answer([{ type: 'toolCall', id: 'prompt-cut-recall', name: 'tuck_recall', arguments: { index: 0 } }], 'toolUse');
            const result = createAssistantMessageEventStream(); result.push({ type: 'done', reason: 'toolUse', message }); result.end(message); return result;
        }
        return stream(model, ctx, options);
    };
    try {
        const result = await h.run();
        expect(result.faults, result.probe).toEqual([]);
        expect(requests).toHaveLength(3);
        expect(requests[0]!.tools.filter(name => own.includes(name))).toEqual([]);
        expect(requests[1]!.saved).toBe(0);
        expect(requests[1]!.tools.filter(name => own.includes(name))).toEqual(own);
        expect(result.entries.map(entry => receiptOf(entry).reason)).toContain('prompt');
        expect(result.guard[1]).toBeLessThan(144000);
        expect(h.session.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'prompt-cut-recall')).toMatchObject({ isError: false });
    } finally { await h.cleanup(); }
});

test('a first manual cut is refused if the newly declared history schemas would put its protected input over the room', async () => {
    const h = await harness({ at: 'tool', complete: 31300, history: 1000, fresh: 15000, host: 100, system: 1500, liveTools: true,
        limits: { contextWindow: 32768, maxTokens: 16384 }, reserveTokens: 16384, cutAtDefault: true,
        compaction: { requestReserve: () => ({ response: 16384, responseExact: true }) }, replyTokens: request => request === 1 ? 1000 : 0 });
    try {
        await h.run();
        await expect(h.session.compact()).rejects.toThrow('Compaction cancelled');
        expect(h.compactions()).toHaveLength(0);
        expect(h.notices.at(-1)).toContain('mandatory context cannot fit');
        expect(h.extension().getActiveTools().filter(name => own.includes(name))).toEqual([]);
    } finally { await h.cleanup(); }
});
