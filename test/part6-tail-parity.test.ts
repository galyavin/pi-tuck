import { afterAll, beforeAll, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { SessionManager, type ExtensionContext, type SessionEntry } from '@earendil-works/pi-coding-agent';
import { conversationTokens } from '../src/budget';
import { tuck, tuckObservedDraft } from '../src/tuck';

const root = fileURLToPath(new URL('..', import.meta.url));
let directory: string, part6: Pick<typeof import('../src/tuck'), 'tuck' | 'tuckObservedDraft'>;

beforeAll(async () => {
  // Read the owner's pinned reference; never check out, stage, build in, or
  // modify another worktree. The exported compiler exists only for this test.
  directory = mkdtempSync(join(tmpdir(), 'pi-part6-tail-'));
  const archive = execFileSync('git', ['archive', '5934daf', 'src'], { cwd: root });
  execFileSync('tar', ['-x', '-C', directory], { input: archive });
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
  symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'));
  const compile = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) compile(path);
      else if (entry.name.endsWith('.ts')) {
        const js = ts.transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText
          .replace(/(\bfrom\s*["']|\bimport\s*\(\s*["'])(\.[^"']+)(["'])/g,
            (_, prefix, path: string, quote) => prefix + (/\.\w+$/u.test(path) ? path : path + '.js') + quote);
        writeFileSync(path.replace(/\.ts$/u, '.js'), js);
      }
    }
  };
  compile(join(directory, 'src'));
  part6 = await import(/* @vite-ignore */ pathToFileURL(join(directory, 'src/tuck.js')).href);
});
afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

test('Part 6 tail boundaries agree near capacity edges', () => {
  const rows = readFileSync(new URL('./fixtures/regression/prose-heavy.jsonl', import.meta.url), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const manager = SessionManager.inMemory('/part6-tail-edges', undefined, [rows[0]]);
  for (const row of rows.filter(e => e.type === 'message').slice(0, 120)) manager.appendMessage(row.message);
  const ctx = { sessionManager: manager, cwd: '/part6-tail-edges', model: { contextWindow: 32768, maxTokens: 16384 } } as unknown as ExtensionContext;
  const input = { branchEntries: manager.getBranch(), tokensBefore: conversationTokens(manager.buildSessionProjection().messages) };
  const boundaries = new Set<string | undefined>();
  for (let reserve = 12000; reserve < 22000; reserve += 10) {
    const expected = part6.tuckObservedDraft(part6.tuck, input, ctx, reserve, conversationTokens);
    const actual = tuckObservedDraft(tuck, input, ctx, reserve, conversationTokens);
    expect(actual.compaction?.firstKeptEntryId, `reserve ${reserve}`).toBe(expected.compaction?.firstKeptEntryId);
    boundaries.add(expected.compaction?.firstKeptEntryId);
  }
  expect(boundaries.size).toBeGreaterThan(1);
});

for (const name of ['prose-heavy', 'low-prose', 'large-tool-output']) {
  test(`${name}: every scheduled cut keeps exactly Part 6's firstKeptEntryId, including the tail's older end`, () => {
    const recording = readFileSync(new URL(`./fixtures/regression/${name}.jsonl`, import.meta.url), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const header = recording[0] as NonNullable<ReturnType<SessionManager['getHeader']>>;
    const messages = recording.filter((entry: SessionEntry) => entry.type === 'message' && entry.message.role !== 'system') as SessionEntry[];
    let checked = 0, extended = 0;
    for (const window of [32768, 81920, 131072]) {
      const manager = SessionManager.inMemory('/part6-tail-parity', undefined, [header]);
      for (let at = 0; at < messages.length; at++) {
        const entry = messages[at]!;
        if (entry.type !== 'message') continue;
        manager.appendMessage(entry.message as Parameters<typeof manager.appendMessage>[0]);
        if (at < 40 || at % 10 !== 0) continue;
        const ctx = { sessionManager: manager, cwd: '/part6-tail-parity', model: { contextWindow: window, maxTokens: 16384 } } as unknown as ExtensionContext;
        const input = { branchEntries: manager.getBranch(), tokensBefore: conversationTokens(manager.buildSessionProjection().messages) };
        for (const reserve of [16384, Math.floor(window * 0.6)]) {
          const expected = part6.tuckObservedDraft(part6.tuck, input, ctx, reserve, conversationTokens);
          let compiledThrough: string | undefined;
          const observing = { ...tuck, compileDialogue: (input: Parameters<typeof tuck.compileDialogue>[0]) => {
            compiledThrough = input.sourceEntryIds?.at(-1);
            return tuck.compileDialogue(input);
          } };
          const actual = tuckObservedDraft(observing, input, ctx, reserve, conversationTokens);
          const label = `${name}, window ${window}, reserve ${reserve}, cut after message ${at}`;
          expect(Boolean(actual.compaction), label).toBe(Boolean(expected.compaction));
          if (!expected.compaction || !actual.compaction) continue;
          expect(actual.compaction.firstKeptEntryId, label).toBe(expected.compaction.firstKeptEntryId);
          const branch = manager.getBranch();
          const from = branch.findIndex(e => e.id === actual.compaction!.firstKeptEntryId);
          const compiledEnd = branch.findIndex(e => e.id === compiledThrough);
          if (from >= 0 && from <= compiledEnd) extended++;
          expect(actual.after, label).toBeLessThanOrEqual((actual.compaction.details as { carriedTarget: number }).carriedTarget);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(30);
    expect(extended).toBeGreaterThan(0);
  });

  test(`${name}: successive 81,920-window cuts match Part 6 at the same cut point and input`, () => {
    const recording = readFileSync(new URL(`./fixtures/regression/${name}.jsonl`, import.meta.url), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const header = recording[0] as NonNullable<ReturnType<SessionManager['getHeader']>>;
    const messages = recording.filter((entry: SessionEntry) => entry.type === 'message' && entry.message.role !== 'system') as SessionEntry[];
    const branch: SessionEntry[] = [];
    let nextCut = 40, checked = 0;
    for (const [at, entry] of messages.entries()) {
      branch.push({ ...entry, parentId: branch.at(-1)?.id ?? null });
      if (at < nextCut || entry.type !== 'message' || entry.message.role !== 'assistant') continue;
      nextCut = at + 40;
      // Both compilers see the same request at each cut. Persist the arm's
      // result, so later comparisons include its actual earlier observations.
      const manager = SessionManager.inMemory('/part6-tail-sequence', undefined, [header, ...branch]);
      const ctx = { sessionManager: manager, cwd: '/part6-tail-sequence', model: { contextWindow: 81920, maxTokens: 16384 } } as unknown as ExtensionContext;
      const saved = manager.buildSessionProjection().messages;
      const input = { branchEntries: manager.getBranch(), tokensBefore: conversationTokens(saved),
        previousSummary: saved.find(message => message.role === 'compactionSummary')?.summary };
      const expected = part6.tuckObservedDraft(part6.tuck, input, ctx, 16384, conversationTokens);
      const actual = tuckObservedDraft(tuck, input, ctx, 16384, conversationTokens);
      expect(expected.compaction).toBeDefined();
      expect(actual.compaction?.firstKeptEntryId, `${name}: scheduled cut ${checked + 1} after message ${at}`)
        .toBe(expected.compaction?.firstKeptEntryId);
      if (actual.compaction) {
        manager.appendCompaction(actual.compaction.summary, actual.compaction.firstKeptEntryId, actual.compaction.tokensBefore, actual.compaction.details, true);
        branch.push(manager.getBranch().at(-1)!);
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(2);
  });
}
