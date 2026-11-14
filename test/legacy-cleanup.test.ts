import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { execFile, spawn, type ExecFileOptions } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { cleanupLegacyFiles } from '../src/legacy-cleanup';

vi.mock('node:child_process', { spy: true });
vi.mock('node:fs/promises', { spy: true });

const nativePlatform = process.platform;
let home: string, agent: string, root: string, marker: string, notices: string[], ctx: ExtensionContext;
beforeEach(async () => {
    // Keep Unix socket paths within the OS limit even when the system temp folder has a long name.
    home = mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'pi-tuck-clean-'));
    agent = join(home, '.pi', 'agent');
    root = join(agent, 'pi-tuck');
    marker = join(agent, 'pi-tuck-semantic-removed');
    mkdirSync(agent, { recursive: true });
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('PI_CODING_AGENT_DIR', agent);
    // Ordinary deletion tests isolate process inspection; one integration test below uses the real lsof.
    const { execFile: actual } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    vi.mocked(execFile).mockImplementation(((file: string, args: string[], options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
        if (file === 'lsof') { callback(Object.assign(new Error('no matches'), { code: 1 }), '', ''); return {}; }
        return actual(file, args, { ...options as ExecFileOptions, encoding: 'utf8' }, callback);
    }) as typeof execFile);
    vi.stubGlobal('process', new Proxy(process, { get: (target, key) => key === 'platform' ? 'darwin' : Reflect.get(target, key) }));
    notices = [];
    ctx = { hasUI: true, ui: { notify: (message: string) => notices.push(message) } } as unknown as ExtensionContext;
});
afterEach(() => {
    vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
});

// The fields in v1.1.2 src/assets.ts, copied into pins.json by setup.ts and scripts/provision-eg2.py.
const pins = {
    embedding: { model: 'google/embeddinggemma-2', revision: '914f7f89142e33e77833254d9c9b90c3cef7303b', dimensions: 768, maxTokens: 8192,
        queryInstruction: 'task: search result | query: ', documentInstruction: 'title: none | text: ',
        pooling: 'mask-aware mean including prompt, projected token states, then float32 L2', dtype: 'Q8_0', textOnly: true },
    runtime: { tokenizers: '0.23.2', python: '3.13' },
    backend: { name: 'llama.cpp', commit: '988190680d5a89fce97de3c20df2c2813731fd61', artifact: 'Q8_0', computePrecision: 'float32', gpuLayers: 0,
        compute: 'CPU float32 with f32 KV; quantized weights where selected', modelRepository: 'unsloth/embeddinggemma-2-GGUF',
        modelRevision: '0'.repeat(40), modelSHA256: '0'.repeat(64) },
};

function directory(name: string) {
    const path = join(root, name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'original'), name);
    return path;
}
function runtime(value = JSON.stringify(pins)) {
    const path = directory('runtime'), child = join(path, 'old-release');
    mkdirSync(child);
    writeFileSync(join(child, 'pins.json'), value);
    return path;
}
const clean = () => cleanupLegacyFiles(ctx);
const withoutSize = () => `pi-tuck removed its old semantic search files from ${root}. Removed: index.`;

test('startup removes the full old tree, including an abandoned socket, then writes a marker and stays silent', { timeout: 120_000 }, async () => {
    runtime();
    for (const name of ['python', 'index', 'downloads', 'staging-123', '.pi-semantic-AbC123']) directory(name);
    const server = nativePlatform === 'win32' ? undefined : createServer();
    try {
        if (server) await new Promise<void>((done, reject) => {
            server.once('error', reject);
            server.listen(join(root, '.pi-semantic-AbC123', 'worker.sock'), done);
        });
        if (server) {
            renameSync(join(root, '.pi-semantic-AbC123', 'worker.sock'), join(root, '.pi-semantic-AbC123', 'abandoned.sock'));
            await new Promise<void>(done => server.close(() => done()));
            expect(lstatSync(join(root, '.pi-semantic-AbC123', 'abandoned.sock')).isSocket()).toBe(true);
        }
        const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
        const tools: string[] = [], commands: string[] = [];
        const pi = { on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, [...handlers.get(name) ?? [], handler]),
            registerTool: (tool: { name: string }) => tools.push(tool.name), registerCommand: (name: string) => commands.push(name),
            getAllTools: () => tools.map(name => ({ name })), getActiveTools: () => [], setActiveTools: () => {},
        } as unknown as ExtensionAPI;
        Object.assign(ctx, { cwd: home, sessionManager: SessionManager.inMemory(home) });
        const { default: extension } = await import('../index');
        await extension(pi);
        for (const handler of handlers.get('session_start') ?? []) await handler({}, ctx);
        expect(existsSync(root)).toBe(false);
        expect(readdirSync(agent)).toEqual(['pi-tuck-semantic-removed']);
        expect(notices).toHaveLength(1);
        expect(notices[0]).toContain('Removed: runtime, python, index, downloads, .pi-semantic-AbC123, staging-123.');
        expect(notices[0]).toContain(root);
        expect(tools).toEqual(['tuck_recall']);
        expect(commands.sort()).toEqual(['tuck', 'tuck-incident']);
        for (const handler of handlers.get('session_start') ?? []) await handler({}, ctx);
        await (await import('../src/legacy-cleanup')).cleanupLegacyFiles(ctx);
        expect(notices).toHaveLength(1);
    } finally {
        if (server?.listening) await new Promise<void>(done => server.close(() => done()));
    }
});

test('concurrent starts share cleanup and announce it once', async () => {
    directory('index');
    await Promise.all([clean(), clean(), clean()]);
    expect(existsSync(root)).toBe(false);
    expect(notices).toHaveLength(1);
});

test('a recreated runtime is left alone across a module reload after cleanup', async () => {
    runtime();
    await clean();
    expect(readFileSync(marker, 'utf8')).toBe('');
    const recreated = runtime();
    vi.resetModules();
    await (await import('../src/legacy-cleanup')).cleanupLegacyFiles(ctx);
    expect(readFileSync(join(recreated, 'old-release', 'pins.json'), 'utf8')).toBe(JSON.stringify(pins));
    expect(notices).toHaveLength(1);
});

test('an existing home marker wins over another agent folder before any root inspection or sizing', async () => {
    runtime();
    writeFileSync(marker, '');
    const otherAgent = join(home, 'benchmark-arm');
    mkdirSync(otherAgent);
    vi.stubEnv('PI_CODING_AGENT_DIR', otherAgent);
    const stat = vi.mocked(fs.lstat).mockClear(), spawn = vi.mocked(execFile).mockClear();
    await clean();
    expect(stat.mock.calls).toEqual([[marker]]);
    expect(fs.readdir).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(existsSync(join(root, 'runtime'))).toBe(true);
    expect(readdirSync(otherAgent)).toEqual([]);
    expect(notices).toEqual([]);
});

test('a different agent folder cannot redirect cleanup or its wx marker', async () => {
    const otherAgent = join(home, 'benchmark-arm');
    mkdirSync(join(otherAgent, 'pi-tuck', 'index'), { recursive: true });
    vi.stubEnv('PI_CODING_AGENT_DIR', otherAgent);
    directory('index');
    await clean();
    expect(existsSync(root)).toBe(false);
    expect(existsSync(join(otherAgent, 'pi-tuck', 'index'))).toBe(true);
    expect(fs.writeFile).toHaveBeenCalledWith(marker, '', { flag: 'wx' });
    expect(existsSync(join(otherAgent, 'pi-tuck-semantic-removed'))).toBe(false);
});

test('no agent folder is needed when nothing remains to clean', async () => {
    rmSync(join(home, '.pi'), { recursive: true });
    await clean();
    expect(readFileSync(marker, 'utf8')).toBe('');
    expect(notices).toEqual([]);
});

test.each(['home', 'root'])('an unreadable %s prevents a start and allows the next load to retry', async part => {
    directory('index');
    const { readdir: actual } = await vi.importActual<typeof fs>('node:fs/promises');
    vi.mocked(fs.readdir).mockImplementation(((path: string) => {
        if (path === (part === 'home' ? home : root)) return Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' }));
        return actual(path);
    }) as typeof fs.readdir);
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await clean();
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(root, 'index'))).toBe(true);
    expect(stderr).toHaveBeenCalledTimes(1);
    vi.mocked(fs.readdir).mockImplementation(actual);
    await clean();
    expect(existsSync(root)).toBe(false);
    expect(existsSync(marker)).toBe(true);
    expect(notices).toHaveLength(1);
});

test.each(['pids', 'failed', 'missing', 'timeout', 'stderr', 'thrown'] as const)('a %s lsof result retains the candidate permanently', async mode => {
    const index = directory('index');
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const spawn = vi.mocked(execFile).mockImplementation(((file: string, args: string[], options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
        expect(file).toBe('lsof');
        expect(args).toEqual(['-t', '+D', index]);
        expect(options).toMatchObject({ timeout: 3000, killSignal: 'SIGKILL' });
        if (mode === 'thrown') throw new Error('spawn failed');
        const error = mode === 'failed' ? { code: 2 } : mode === 'missing' ? { code: 'ENOENT' } : mode === 'timeout' ? { code: 1, killed: true, signal: 'SIGKILL' } : undefined;
        callback(error ? Object.assign(new Error(mode), error) : null, mode === 'pids' ? '123\n456\n' : '', mode === 'stderr' ? 'cannot inspect' : '');
        return {};
    }) as typeof execFile);
    await clean();
    expect(existsSync(index)).toBe(true);
    expect(existsSync(marker)).toBe(true);
    expect(notices).toEqual([]);
    expect(fs.rm).not.toHaveBeenCalled();
    spawn.mockClear();
    await clean();
    expect(spawn).not.toHaveBeenCalled();
});

test.skipIf(nativePlatform === 'win32')('a candidate held open by a live child stays while an idle candidate goes', { timeout: 120_000 }, async () => {
    const index = directory('index');
    directory('python');
    const { execFile: actual } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    vi.mocked(execFile).mockImplementation(actual);
    const child = spawn(process.execPath, ['-e', "process.stdout.write('ready'); setInterval(() => {}, 1000)"], { cwd: index, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
        await once(child.stdout!, 'data');
        await clean();
        expect(readdirSync(root)).toEqual(['index']);
        expect(readFileSync(marker, 'utf8')).toBe('');
        expect(notices).toHaveLength(1);
        expect(notices[0]).toMatch(/\. Removed: python\.$/);
        expect(notices[0]).not.toContain('Removed: index');
    } finally {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
    }
    await clean();
    expect(existsSync(index)).toBe(true);
    expect(notices).toHaveLength(1);
});

test('an absent root still completes the one-time attempt', async () => {
    await clean();
    expect(notices).toEqual([]);
    expect(readdirSync(agent)).toEqual(['pi-tuck-semantic-removed']);
});

test('an empty root is removed and creates a marker', async () => {
    mkdirSync(root);
    await clean();
    expect(readdirSync(agent)).toEqual(['pi-tuck-semantic-removed']);
    expect(notices).toHaveLength(1);
});

test('a symlinked root and its target are left alone', async () => {
    const outside = join(home, 'outside');
    mkdirSync(join(outside, 'index'), { recursive: true });
    writeFileSync(join(outside, 'index', 'evidence'), 'keep');
    symlinkSync(outside, root, 'junction');
    await clean();
    expect(lstatSync(root).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(outside, 'index', 'evidence'), 'utf8')).toBe('keep');
    expect(notices).toEqual([]);
});

test('a file at the root is left alone', async () => {
    writeFileSync(root, 'keep');
    await clean();
    expect(readFileSync(root, 'utf8')).toBe('keep');
    expect(notices).toEqual([]);
});

test.each(['runtime', 'python', 'index', 'downloads', 'staging-123', '.pi-semantic-AbC123'])('a symlinked candidate %s and its outside target are left alone', async name => {
    const outside = join(home, 'outside');
    mkdirSync(outside); mkdirSync(root);
    writeFileSync(join(outside, 'evidence'), 'keep');
    symlinkSync(outside, join(root, name), 'junction');
    await clean();
    expect(lstatSync(join(root, name)).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(outside, 'evidence'), 'utf8')).toBe('keep');
    expect(notices).toEqual([]);
});

test('files at candidate paths and foreign files are retained while owned directories are removed', async () => {
    directory('index');
    for (const name of ['notes.txt', 'python', 'runtime', 'downloads', 'staging-123', '.pi-semantic-AbC123']) writeFileSync(join(root, name), 'keep');
    await clean();
    expect(readdirSync(root).sort()).toEqual(['.pi-semantic-AbC123', 'downloads', 'notes.txt', 'python', 'runtime', 'staging-123']);
    for (const name of readdirSync(root)) expect(readFileSync(join(root, name), 'utf8')).toBe('keep');
    expect(notices).toHaveLength(1);
    await clean();
    expect(notices).toHaveLength(1);
});

test('similarly named directories are not cleanup candidates', async () => {
    const names = ['runtime-other', 'indexes', 'staging-', 'staging-123.lock', 'staging-123-extra', '.pi-semantic-AbC12', '.pi-semantic-AbC1234', '.pi-semantic-!!!!!!'];
    if (process.platform !== 'win32') names.push('staging-123\n', '.pi-semantic-AbC123\n');
    for (const name of names) directory(name);
    await clean();
    expect(readdirSync(root).sort()).toEqual(names.sort());
    expect(notices).toEqual([]);
});

test.each([undefined, '{}', 'not json', 'null', '[]', JSON.stringify({ ...pins, embedding: { model: 'foreign' } }), JSON.stringify({ ...pins, backend: {} })])('runtime without valid ownership pins is retained (%s)', async value => {
    if (value === undefined) directory('runtime'); else runtime(value);
    directory('index');
    await clean();
    expect(readdirSync(root)).toEqual(['runtime']);
    expect(readFileSync(join(root, 'runtime', 'original'), 'utf8')).toBe('runtime');
    expect(notices).toHaveLength(1);
    await clean();
    expect(notices).toHaveLength(1);
});

test('runtime ownership is recognized in any child after an invalid one', async () => {
    runtime('not json');
    mkdirSync(join(root, 'runtime', 'another-release'));
    writeFileSync(join(root, 'runtime', 'another-release', 'pins.json'), JSON.stringify(pins));
    await clean();
    expect(existsSync(root)).toBe(false);
});

test.each(['child', 'pins'])('runtime ownership does not follow a symlinked %s', async part => {
    directory('runtime');
    const outside = join(home, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'pins.json'), JSON.stringify(pins));
    const child = join(root, 'runtime', 'release');
    if (part === 'child') symlinkSync(outside, child, 'junction');
    else { mkdirSync(child); symlinkSync(join(outside, 'pins.json'), join(child, 'pins.json'), 'file'); }
    await clean();
    expect(existsSync(join(root, 'runtime'))).toBe(true);
    expect(readFileSync(join(outside, 'pins.json'), 'utf8')).toBe(JSON.stringify(pins));
    expect(notices).toEqual([]);
});

test('rm unlinks a link inside index without following its outside target', async () => {
    directory('index');
    const outside = join(home, 'outside.txt');
    writeFileSync(outside, 'keep');
    symlinkSync(outside, join(root, 'index', 'linked.txt'), 'file');
    await clean();
    expect(existsSync(root)).toBe(false);
    expect(readFileSync(outside, 'utf8')).toBe('keep');
});

test('without a UI the removal notice goes to stderr once', async () => {
    directory('index');
    Object.assign(ctx, { hasUI: false });
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await clean(); await clean();
    expect(notices).toEqual([]);
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stderr.mock.calls[0]![0]).toContain(`pi-tuck removed its old semantic search files from ${root}`);
});

test('an ended UI cannot fail cleanup or cause another removal notice', async () => {
    directory('index');
    const send = vi.spyOn(ctx.ui, 'notify').mockImplementation(() => { throw new Error('ended'); });
    await expect(clean()).resolves.toBeUndefined();
    await clean();
    expect(existsSync(root)).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
});

test.each(['failed', 'timeout', 'thrown'] as const)('a %s size estimate omits the size but still cleans up', async mode => {
    vi.stubGlobal('process', new Proxy(process, { get: (target, key) => key === 'platform' ? 'darwin' : Reflect.get(target, key) }));
    const index = directory('index');
    if (mode === 'timeout') vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(1001);
    const spawn = vi.mocked(execFile).mockImplementation(((file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
        if (file === 'lsof') { callback(null, '', ''); return {}; }
        if (mode === 'thrown') throw new Error('spawn failed');
        callback(mode === 'failed' ? new Error('unavailable') : null, `471040\t${index}\n`, '');
        return {};
    }) as typeof execFile);
    await clean();
    expect(spawn).toHaveBeenCalledWith('du', ['-sk', index], expect.objectContaining({ timeout: 1000 }), expect.any(Function));
    expect(notices).toEqual([withoutSize()]);
    expect(existsSync(root)).toBe(false);
});

test('size counts only removed directories, leaving a foreign file out', async () => {
    vi.stubGlobal('process', new Proxy(process, { get: (target, key) => key === 'platform' ? 'darwin' : Reflect.get(target, key) }));
    const index = directory('index');
    writeFileSync(join(root, 'notes.txt'), 'keep');
    vi.mocked(execFile).mockImplementation(((file: string, args: string[], _options: unknown, callback: (error: null, stdout: string, stderr: string) => void) => {
        if (file === 'lsof') { callback(null, '', ''); return {}; }
        expect(args).toEqual(['-sk', index]);
        callback(null, `2048\t${index}\n`, ''); return {};
    }) as typeof execFile);
    await clean();
    expect(notices).toEqual([`pi-tuck removed its old semantic search files from ${root} (about 2 MB freed). Removed: index.`]);
    expect(readdirSync(root)).toEqual(['notes.txt']);
});

test('Windows leaves every candidate alone and marks the attempt without running lsof or du', async () => {
    directory('index');
    vi.stubGlobal('process', new Proxy(process, { get: (target, key) => key === 'platform' ? 'win32' : Reflect.get(target, key) }));
    const spawn = vi.mocked(execFile).mockClear();
    await clean();
    expect(existsSync(root)).toBe(true);
    expect(existsSync(join(root, 'index'))).toBe(true);
    expect(existsSync(marker)).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
});

test('deletion failures report one stderr line, allow partial progress and mark it done for good', async () => {
    directory('python'); directory('index'); directory('downloads');
    const remove = vi.mocked(fs.rm), { rm: actual } = await vi.importActual<typeof fs>('node:fs/promises');
    remove.mockImplementation(async (path, options) => {
        if ([join(root, 'python'), join(root, 'downloads')].includes(String(path))) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return actual(path, options);
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    await expect(clean()).resolves.toBeUndefined();
    expect(readdirSync(root).sort()).toEqual(['downloads', 'python']);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/\. Removed: index\.$/);
    expect(stderr.mock.calls).toEqual([['pi-tuck could not finish removing its old search files: EACCES\n']]);
    expect(remove).toHaveBeenCalledWith(join(root, 'index'), { recursive: true, force: false });
    remove.mockImplementation(actual);
    await clean();
    expect(readdirSync(root).sort()).toEqual(['downloads', 'python']);
    expect(existsSync(marker)).toBe(true);
    expect(notices).toHaveLength(1);
});

test('an inaccessible root and closed stderr cannot throw into the session', async () => {
    vi.mocked(fs.lstat).mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => { throw new Error('closed'); });
    await expect(clean()).resolves.toBeUndefined();
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(notices).toEqual([]);
});
