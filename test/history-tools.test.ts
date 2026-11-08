import { expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage, type Context } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { installCompaction } from '../src/compaction';
import { serializeTranscript } from '../src/tuck/core/transcript';
import { DIALOGUE_SUFFIX } from '../src/tuck/core/format';
import { scriptedModelRuntime } from './model-fixture';
import { harness, receiptOf } from './budget-fixture';

const own = ['tuck_recall', 'tuck_search'];
const names = (ctx: Context) => getCurrentTools(ctx.messages).map(tool => tool.name);
const summary = serializeTranscript([{ kind: 'omission', reason: 'Earlier conversation is out of view.' }]) + DIALOGUE_SUFFIX;
const cut = (manager: SessionManager, native = false) => manager.appendCompaction(summary, '', 10000,
    native ? { readFiles: [], modifiedFiles: [] } : { compactor: 'pi-tuck', version: 2, adapter: 'standalone' }, !native);

async function fixture(dir: string, manager: SessionManager, installed = true, search = true) {
    const runtime = await scriptedModelRuntime({ contextWindow: 32768, maxTokens: 4096 });
    const model = runtime.getModel('openai-codex', 'gpt-6.1-sol')!;
    const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: true, reserveTokens: 4096, keepRecentTokens: 0 } });
    let pi: ExtensionAPI | undefined, handle: Awaited<ReturnType<typeof installCompaction>> | undefined;
    const faults: string[] = [], requests: Context[] = [];
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings, noExtensions: true, noSkills: true,
        noContextFiles: true, noPromptTemplates: true, noThemes: true, systemPrompt: 'Follow the current task.', extensionFactories: [async api => {
            pi = api;
            api.registerTool({ name: 'foreign', label: 'Foreign', description: 'Another extension tool.', parameters: Type.Object({}),
                execute: async () => ({ content: [{ type: 'text', text: 'foreign result' }], details: {} }) });
            if (installed) handle = await installCompaction(api, { search, settings, cutAt: 1, fail: error => faults.push(String(error)) });
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
        const captured: string[][] = [];
        for (const installed of [false, true]) {
            const f = await fixture(dir, SessionManager.inMemory(dir), installed);
            try {
                await f.session.prompt('First task'); await f.session.prompt('Continue exactly');
                expect(f.faults).toEqual([]);
                expect(f.session.sessionManager.getBranch().some(entry => entry.type === 'compaction')).toBe(false);
                captured.push(f.requests.map(request => JSON.stringify(request)));
            } finally { await f.close(); }
        }
        expect(captured[1]).toEqual(captured[0]);
    } finally { time.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
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
