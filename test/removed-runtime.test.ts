import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { execFile } from 'node:child_process';
import { showRemovedRuntimeNotice } from '../src/removed-runtime';
import { installCompaction } from '../src/compaction';

vi.mock('node:child_process', { spy: true });
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(present = true, hasUI = true) {
    const agent = mkdtempSync(join(tmpdir(), 'pi-tuck-removed-'));
    roots.push(agent);
    const root = join(agent, 'pi-tuck'), notices: string[] = [];
    if (present) {
        for (const part of ['index', 'python', 'runtime']) {
            mkdirSync(join(root, part), { recursive: true });
            writeFileSync(join(root, part, 'original'), part);
        }
    }
    const ctx = { hasUI, ui: { notify: (message: string) => notices.push(message) } } as unknown as ExtensionContext;
    const notice = () => showRemovedRuntimeNotice(ctx, root);
    return { agent, root, notices, ctx, notice, marker: join(agent, 'pi-tuck.notice-shown') };
}

test('an existing runtime is announced once across concurrent starts and module reloads, with nothing deleted', async () => {
    const f = fixture();
    await Promise.all([f.notice(), f.notice()]);
    expect(f.notices).toHaveLength(1);
    expect(isAbsolute(f.root)).toBe(true);
    if (process.platform === 'win32') expect(f.notices[0]).toBe(`pi-tuck no longer uses semantic search; its runtime folder ${f.root} can be deleted.`);
    else expect(f.notices[0]).toMatch(new RegExp(`^pi-tuck no longer uses semantic search; its runtime folder .+ \\(about \\d+ MB\\) can be deleted\\.$`));
    expect(f.notices[0]).toContain(f.root);
    expect(existsSync(f.marker)).toBe(true);
    await f.notice();
    vi.resetModules();
    const reloaded = await import('../src/removed-runtime');
    await reloaded.showRemovedRuntimeNotice(f.ctx, f.root);
    expect(f.notices).toHaveLength(1);
    expect(readdirSync(f.root).sort()).toEqual(['index', 'python', 'runtime']);
    for (const part of ['index', 'python', 'runtime']) expect(readFileSync(join(f.root, part, 'original'), 'utf8')).toBe(part);
});

test('an absent folder produces no notice or marker', async () => {
    const f = fixture(false);
    await f.notice();
    expect(f.notices).toEqual([]);
    expect(readdirSync(f.agent)).toEqual([]);
});

test('a preexisting marker suppresses the notice', async () => {
    const f = fixture();
    writeFileSync(f.marker, 'already shown');
    await f.notice();
    expect(f.notices).toEqual([]);
    expect(readFileSync(f.marker, 'utf8')).toBe('already shown');
});

test('no-UI delivery uses stderr and still writes the marker once', async () => {
    const f = fixture(true, false), written: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { written.push(String(chunk)); return true; });
    await f.notice(); await f.notice();
    expect(f.notices).toEqual([]);
    expect(written).toHaveLength(1);
    expect(written[0]).toContain(`its runtime folder ${f.root}`);
    expect(existsSync(f.marker)).toBe(true);
});

test('an ended UI leaves no marker and can retry delivery', async () => {
    const f = fixture();
    const send = vi.spyOn(f.ctx.ui, 'notify').mockImplementationOnce(() => { throw new Error('ended'); });
    await f.notice();
    expect(existsSync(f.marker)).toBe(false);
    await f.notice();
    expect(send).toHaveBeenCalledTimes(2);
    expect(existsSync(f.marker)).toBe(true);
});

test.each(['failed', 'timeout'] as const)('a %s size estimate omits the size and preserves the folder', async mode => {
    // Exercise the POSIX branch on every host; execFile itself is fully mocked.
    vi.stubGlobal('process', new Proxy(process, { get: (target, key) => key === 'platform' ? 'darwin' : Reflect.get(target, key) }));
    const f = fixture();
    const clock = vi.spyOn(performance, 'now');
    if (mode === 'timeout') clock.mockReturnValueOnce(0).mockReturnValue(1001);
    const spawn = vi.mocked(execFile).mockImplementation(((_file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
        callback(mode === 'failed' ? new Error('du unavailable') : null, '471040\troot\n');
        return {};
    }) as typeof execFile);
    await f.notice();
    expect(spawn).toHaveBeenCalledWith('du', ['-sk', f.root], expect.objectContaining({ timeout: 1000 }), expect.any(Function));
    expect(f.notices).toEqual([`pi-tuck no longer uses semantic search; its runtime folder ${f.root} can be deleted.`]);
    expect(existsSync(join(f.root, 'runtime', 'original'))).toBe(true);
});

test('on Windows the notice never invokes du, including when a leftover directory exists', async () => {
    const f = fixture();
    vi.stubGlobal('process', new Proxy(process, { get: (target, key) => key === 'platform' ? 'win32' : Reflect.get(target, key) }));
    const spawn = vi.mocked(execFile).mockClear();
    await f.notice();
    expect(spawn).not.toHaveBeenCalled();
    expect(f.notices).toEqual([`pi-tuck no longer uses semantic search; its runtime folder ${f.root} can be deleted.`]);
    expect(existsSync(f.marker)).toBe(true);
});

test('extension startup resolves the old root under the configured agent directory', async () => {
    const f = fixture();
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = f.agent;
    try {
        const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
        const tools: string[] = [], commands: string[] = [];
        const pi = { on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, [...handlers.get(name) ?? [], handler]),
            registerTool: (tool: { name: string }) => tools.push(tool.name), registerCommand: (name: string) => commands.push(name),
        } as unknown as ExtensionAPI;
        Object.assign(f.ctx, { cwd: f.agent, sessionManager: SessionManager.inMemory(f.agent) });
        Object.assign(pi, { getAllTools: () => tools.map(name => ({ name })), getActiveTools: () => [], setActiveTools: () => {} });
        const { default: extension } = await import('../index');
        await extension(pi);
        for (const handler of handlers.get('session_start') ?? []) await handler({}, f.ctx);
        expect(f.notices).toHaveLength(1);
        expect(f.notices[0]).toContain(f.root);
        expect(tools).toEqual(['tuck_recall']);
        expect(commands).toContain('tuck-semantic');
    } finally {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    }
});

test.each([true, false])('/tuck-semantic explains the removal with a folder present=%s, without changing any files', async present => {
    const f = fixture(present), previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = f.agent;
    try {
        const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
        const pi = { on: () => {}, registerTool: () => {}, registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => commands.set(name, command.handler) } as unknown as ExtensionAPI;
        const handle = await installCompaction(pi);
        try {
            const before = readdirSync(f.agent);
            for (const args of ['', 'on', 'off', 'status', 'anything']) await commands.get('tuck-semantic')!(args, f.ctx);
            expect(f.notices).toHaveLength(5);
            for (const message of f.notices) {
                expect(message).toContain('Semantic search was removed from pi-tuck.');
                expect(message).toContain(f.root);
                expect(message).toContain(present ? 'can be deleted by hand' : 'No runtime folder exists');
            }
            const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
            await commands.get('tuck-semantic')!('on', { ...f.ctx, hasUI: false });
            expect(stderr).toHaveBeenCalledWith(f.notices[0] + '\n');
            expect(readdirSync(f.agent)).toEqual(before);
            expect(existsSync(f.marker)).toBe(false);
            if (present) for (const part of ['index', 'python', 'runtime']) expect(readFileSync(join(f.root, part, 'original'), 'utf8')).toBe(part);
        } finally { await handle.close(); }
    } finally {
        if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    }
});
