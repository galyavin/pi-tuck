import { pythonFlags, testPython, testNativeOwner } from './python-fixture';
import { afterEach, expect, test, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createSemanticRecall, semanticEligibleSources } from '../src/semantic-recall';
const owned: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of owned.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
 const root = mkdtempSync(join(tmpdir(), 'pi-semantic-path-')); owned.push(root);
 const project = join(root, 'project'); mkdirSync(project);
 const config = { pythonPath: join(root, 'missing-python'), runtimeRoot: join(root, 'runtime'), indexDirectory: join(root, 'cache') };
 return { root, project, config };
}
test('configuration checks physical and lexical containment without confusing dot-dot names or sibling directories', async () => {
 const f = fixture(), inside = join(f.project, '..config'); mkdirSync(inside);
 const file = join(inside, 'semantic.json'); writeFileSync(file, JSON.stringify(f.config));
 const alias = join(f.root, 'selected.json'); symlinkSync(file, alias);
 const projectAlias = join(f.root, 'project-alias'); symlinkSync(f.project, projectAlias, process.platform === "win32" ? "junction" : "dir");
 const c = createSemanticRecall();
 for (const [project, path] of [[f.project, file], [f.project, alias], [projectAlias, file]]) {
  await expect(c.configureExternal(project!, path!)).rejects.toThrow('outside project');
  expect(c.status().configured).toBe(false);
 }
 const outside = join(f.root, 'project-settings.json'); writeFileSync(outside, JSON.stringify(f.config));
 await c.configureExternal(f.project, outside); expect(c.status()).toMatchObject({ configured: true, enabled: false });
 await c.close();
});
test.each(['..cache', 'alias'])('forbidden %s index storage is rejected before worker startup and does not block close', async name => {
 const f = fixture(), inside = join(f.project, '..cache'); mkdirSync(inside);
 const alias = join(f.root, 'outside-looking-cache'); symlinkSync(inside, alias, process.platform === "win32" ? "junction" : "dir");
 const c = createSemanticRecall({ ...f.config, indexDirectory: name === 'alias' ? alias : inside });
 const sessionManager = SessionManager.inMemory(f.project); sessionManager.appendMessage({ role: 'user', content: 'permitted original evidence', timestamp: 1 }); sessionManager.appendCompaction('summary of what was cut', 'no-such-entry', 100, undefined, true); // out of view: a search waits for the source
 c.enable(); const page = await c.search('evidence', () => semanticEligibleSources({ cwd: f.project, sessionManager }, {}, () => {}));
 expect(page.status).toBe('unavailable'); expect(c.status().lastError).toContain('index must be outside project');
 expect(existsSync(join(f.config.runtimeRoot, 'scratch'))).toBe(false);
 await c.close(); expect(c.status()).toMatchObject({ enabled: false, cleanupError: null });
 expect(existsSync(inside)).toBe(true); // The controller never owned this caller directory.
});
test.each(['runtime', 'runtime-alias', 'scratch-alias'])('project-contained %s is rejected before native startup or scratch creation', async kind => {
 const f = fixture(), inside = join(f.project, 'native'); mkdirSync(inside);
 let runtimeRoot = inside;
 if (kind === 'runtime-alias') { runtimeRoot = join(f.root, 'alias'); symlinkSync(inside, runtimeRoot, process.platform === "win32" ? "junction" : "dir"); }
 let scratchDirectory: string | undefined;
 if (kind === 'scratch-alias') { runtimeRoot = f.config.runtimeRoot; scratchDirectory = join(f.root, 'scratch'); symlinkSync(inside, scratchDirectory, process.platform === "win32" ? "junction" : "dir"); }
 const c = createSemanticRecall({ ...f.config, runtimeRoot, scratchDirectory });
 const sessionManager = SessionManager.inMemory(f.project); sessionManager.appendMessage({ role: 'user', content: 'evidence', timestamp: 1 }); sessionManager.appendCompaction('summary of what was cut', 'no-such-entry', 100, undefined, true); // out of view: a search waits for the source
 try {
  c.enable(); const page = await c.search('evidence', () => semanticEligibleSources({ cwd: f.project, sessionManager }, {}, () => {}));
  expect(page.status).toBe('unavailable'); expect(c.status().lastError).toContain((kind === 'scratch-alias' ? 'scratch' : 'runtime') + ' must be outside project');
  expect(readdirSync(inside)).toEqual([]);
 } finally { await c.close(); }
});
test('scratch and index cannot overlap immutable runtime, including physical aliases; explicit scratch must be absolute', () => {
 const f = fixture(); mkdirSync(f.config.runtimeRoot);
 const alias = join(f.root, 'runtime-alias'); symlinkSync(f.config.runtimeRoot, alias, process.platform === "win32" ? "junction" : "dir");
 for (const scratchDirectory of ['', 'relative', join(f.config.runtimeRoot, 'scratch'), join(alias, 'scratch')]) {
  expect(() => createSemanticRecall({ ...f.config, scratchDirectory })).toThrow();
 }
 for (const indexDirectory of [f.config.runtimeRoot, join(alias, 'cache')]) {
  expect(() => createSemanticRecall({ ...f.config, indexDirectory })).toThrow('index must be outside immutable runtime');
 }
});
test.each([false, true])('real worker readiness and cleanup retain caller storage and never write immutable runtime (explicit scratch %s)', async explicit => {
 const f = fixture();
 mkdirSync(f.config.runtimeRoot); writeFileSync(join(f.config.runtimeRoot, 'immutable'), 'verified software');
 const scratchDirectory = explicit ? join(f.root, 'scratch') : undefined;
 if (scratchDirectory) { mkdirSync(scratchDirectory); writeFileSync(join(scratchDirectory, 'caller'), 'keep'); }
 const pythonPath = execFileSync(testPython, [...pythonFlags, '-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();
 const c = createSemanticRecall({ ...f.config, scratchDirectory, pythonPath, ...testNativeOwner, queryWaitMs: 2000, workerPath: fileURLToPath(new URL('./semantic-ready-fixture.py', import.meta.url)) });
 const internal = c as unknown as { runtime(project: string): Promise<unknown>; identity: string };
 try {
  c.enable();
  // A failed native launch must not pass merely because its scratch vanished.
  await expect(internal.runtime(f.project)).resolves.toBeDefined();expect(internal.identity).toMatch(/^[a-f0-9]{64}$/);
 }
 finally { await c.close(); }
 expect(readdirSync(f.config.runtimeRoot)).toEqual(['immutable']);
 expect(readdirSync(scratchDirectory ?? f.root).filter(name => name.startsWith('.pi-semantic-'))).toEqual([]);
 if (scratchDirectory) expect(readdirSync(scratchDirectory)).toEqual(['caller']);
});
test('configuration replacement requires joined disable and invalidates only owned derived state', async () => {
 const f = fixture(), sessionManager = SessionManager.inMemory(f.project);
 const id = sessionManager.appendMessage({ role: 'user', content: 'unchanged original evidence', timestamp: 1 });
 const provider = () => semanticEligibleSources({ cwd: f.project, sessionManager }, {}, () => {});
 const original = provider(); mkdirSync(f.config.indexDirectory);
 const c = createSemanticRecall(f.config) as any;
 // Supply only the worker RPC; production controller owns config admission and disk deletion.
 c.runtime = async () => ({ call: async (_op: string, input: { path: string }) => { writeFileSync(input.path, 'derived vector'); return {}; } });
 c.enable(); await c.index('upsert', original, { rows: [] }); c.current = { ...original, complete: true }; c.identity = 'Q8 identity';
 const replacement = { ...f.config, runtimeRoot: join(f.root, 'q4-runtime'), scratchDirectory: join(f.root, 'mutable') };
 expect(() => c.configure(replacement)).toThrow('Disable before changing');
 expect(readdirSync(f.config.indexDirectory)).toHaveLength(1);
 await c.disable(); c.configure(replacement);
 expect(readdirSync(f.config.indexDirectory)).toEqual([]); expect(c.identity).toBe(''); expect(c.current).toBeUndefined();
 expect(c.status()).toMatchObject({ enabled: false, configured: true, indexingComplete: false });
 expect(provider().id).toBe(original.id); expect(provider().sources[0]!.entry.id).toBe(id);
 await c.close();
});
test('close removes every admitted owner index even when the current source view is absent', async () => {
 const f = fixture(); mkdirSync(f.config.indexDirectory);
 const c = createSemanticRecall(f.config) as any;
 // Substitute only the worker RPC; exercise the controller admission and real file cleanup.
 c.runtime = async () => ({ call: async (_op: string, input: { path: string }) => { writeFileSync(input.path, 'owned index'); return {}; } });
 c.enable();
 for (const session of ['first', 'second']) await c.index('upsert', { session, project: f.project }, { rows: [] });
 expect(readdirSync(f.config.indexDirectory)).toHaveLength(2);
 await c.close(); expect(readdirSync(f.config.indexDirectory)).toEqual([]);
});
test('real worker stdin EPIPE settles the pending RPC, cleans owned scratch, and leaves the host alive', async () => {
 const f = fixture(), sessionManager = SessionManager.inMemory(f.project);
 sessionManager.appendMessage({ role: 'user', content: 'permitted original evidence', timestamp: 1 }); sessionManager.appendCompaction('summary of what was cut', 'no-such-entry', 100, undefined, true); // out of view: a search waits for the source
 const pythonPath = execFileSync(testPython, [...pythonFlags, '-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();
 const c = createSemanticRecall({ ...f.config, pythonPath, ...testNativeOwner, queryWaitMs: 2000, workerPath: fileURLToPath(new URL('./semantic-worker-fixture.py', import.meta.url)) });
 try {
  c.enable();
  const page = await c.search('evidence', () => semanticEligibleSources({ cwd: f.project, sessionManager }, {}, () => {}));
  expect(page.status).toBe('unavailable');
  expect(page.coverage.lastError).toBe('Local worker closed');
 } finally { await c.close(); }
 expect(existsSync(f.config.runtimeRoot)).toBe(false);
 expect(readdirSync(f.root).filter(name => name.startsWith('.pi-semantic-'))).toEqual([]);
 expect(c.status()).toMatchObject({ enabled: false, cleanupError: null });
}, 10000);
