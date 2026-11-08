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
import { parseRecords, splitSummary } from '../src/tuck/core/transcript';

const root = fileURLToPath(new URL('..', import.meta.url));
type Compiler = Pick<typeof import('../src/tuck'), 'tuck' | 'tuckObservedDraft'>;
let directory: string, part6: Compiler;

function observe(compiler: Compiler, input: Parameters<typeof tuckObservedDraft>[1], ctx: ExtensionContext, reserve: number) {
  let compiledIds: readonly string[] | undefined;
  const observing = { ...compiler.tuck, compileDialogue: (input: Parameters<typeof tuck.compileDialogue>[0]) => {
    compiledIds = input.sourceEntryIds;
    return compiler.tuck.compileDialogue(input);
  } };
  const draft = compiler.tuckObservedDraft(observing, input, ctx, reserve, conversationTokens);
  return { draft, compiledIds };
}

/** Compilation stops at the pinned native boundary, before observations and
 * older-tail extension. Only that extension may differ from the reference. */
function assertPinned(input: Parameters<typeof tuckObservedDraft>[1], ctx: ExtensionContext, reserve: number, label: string) {
  const expected = observe(part6, input, ctx, reserve);
  const actual = observe({ tuck, tuckObservedDraft }, input, ctx, reserve);
  expect(Boolean(actual.draft.compaction), label).toBe(Boolean(expected.draft.compaction));
  if (!expected.draft.compaction || !actual.draft.compaction) return;
  expect(expected.compiledIds, label).toBeDefined();
  expect(actual.compiledIds, `${label}: pinned boundary`).toEqual(expected.compiledIds);
  const branch = ctx.sessionManager.getBranch();
  const positions = new Map(branch.map((entry, at) => [entry.id, at]));
  const pinned = (positions.get(expected.compiledIds!.at(-1)!) ?? -1) + 1;
  const from = (id: string) => id ? positions.get(id)! : branch.length;
  const expectedFrom = from(expected.draft.compaction.firstKeptEntryId), actualFrom = from(actual.draft.compaction.firstKeptEntryId);
  expect(expectedFrom, label).toBeLessThanOrEqual(pinned);
  expect(actualFrom, `${label}: no pinned source displaced`).toBeLessThanOrEqual(pinned);
  expect(actualFrom, `${label}: only older extension may shrink`).toBeGreaterThanOrEqual(expectedFrom);
  const indices = tuck.buildGlobalIndexById(ctx.sessionManager.getEntries());
  const nativeIndices = new Set(branch.slice(actualFrom).map(entry => indices.get(entry.id)));
  for (const record of parseRecords(splitSummary(actual.draft.compaction.summary)!.body)) if (record.kind === 'section' && record.title === 'Thinking')
    expect(nativeIndices.has(record.sourceIndex), `${label}: thinking stays outside the native tail`).toBe(false);
  const pinnedProjection = (draft: NonNullable<typeof actual.draft.compaction>) => {
    const manager = SessionManager.inMemory(ctx.cwd, undefined, [ctx.sessionManager.getHeader()!, ...branch]);
    manager.appendCompaction(draft.summary, draft.firstKeptEntryId, draft.tokensBefore, draft.details, true);
    return manager.buildSessionProjection().entries.filter(entry => entry.sourceEntry.type !== 'compaction' &&
      (positions.get(entry.sourceEntry.id) ?? -1) >= pinned && entry.messages.length)
      .map(entry => ({ entryId: entry.sourceEntry.id, messages: entry.messages }));
  };
  expect(pinnedProjection(actual.draft.compaction), `${label}: pinned messages`).toEqual(pinnedProjection(expected.draft.compaction));
  expect(actual.draft.after, label).toBeLessThanOrEqual((actual.draft.compaction.details as { carriedTarget: number }).carriedTarget);
  return { draft: actual.draft, pinned, actualFrom, expectedFrom };
}

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

test('plain-thinking openings preserve the pinned Part 6 tail at every tested room', () => {
  const rows = readFileSync(new URL('./fixtures/regression/prose-heavy.jsonl', import.meta.url), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const manager = SessionManager.inMemory('/part6-plain-thinking', undefined, [rows[0]]);
  for (const [at, row] of rows.filter(e => e.type === 'message').slice(0, 120).entries()) {
    const message = row.message;
    manager.appendMessage(message.role === 'assistant' ? { ...message, content: [
      { type: 'thinking', thinking: `Plain plan ${at}: ` + 'Inspect the source before changing it. '.repeat(20) }, ...message.content,
    ] } : message);
  }
  const spare = SessionManager.inMemory('/part6-plain-spare');
  spare.appendMessage({ role: 'user', content: 'Preserve this opening.', timestamp: 0 });
  const answer = (content: unknown[]) => ({ role: 'assistant', content, api: 'openai-completions', provider: 'probe', model: 'probe',
    stopReason: 'stop', timestamp: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }) as never;
  spare.appendMessage(answer([{ type: 'thinking', thinking: 'Inspect the source before changing it. '.repeat(20) }]));
  for (let at = 0; at < 12; at++) spare.appendMessage(answer([{ type: 'text', text: `Old ${at}:` + 'x'.repeat(9000) }]));
  spare.appendMessage({ role: 'user', content: 'Continue the current task.', timestamp: 0 });
  spare.appendMessage(answer([{ type: 'text', text: 'Recent state is ready.' }]));
  let quoted = 0;
  for (const sessionManager of [manager, spare]) {
    const ctx = { sessionManager, cwd: '/part6-plain-thinking', model: { contextWindow: 81920, maxTokens: 16384 } } as unknown as ExtensionContext;
    const input = { branchEntries: sessionManager.getBranch(), tokensBefore: conversationTokens(sessionManager.buildSessionProjection().messages) };
    for (let room = 2000; room <= 20000; room += 250) {
      const checked = assertPinned(input, ctx, 81920 - room, `plain thinking, room ${room}`);
      if (checked) quoted += Number(checked.draft.compaction.summary.includes(' Thinking:'));
    }
  }
  expect(quoted).toBeGreaterThan(0);
});

test('the pinned Part 6 boundary agrees near capacity edges', () => {
  const rows = readFileSync(new URL('./fixtures/regression/prose-heavy.jsonl', import.meta.url), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const manager = SessionManager.inMemory('/part6-tail-edges', undefined, [rows[0]]);
  for (const row of rows.filter(e => e.type === 'message').slice(0, 120)) manager.appendMessage(row.message);
  const ctx = { sessionManager: manager, cwd: '/part6-tail-edges', model: { contextWindow: 32768, maxTokens: 16384 } } as unknown as ExtensionContext;
  const input = { branchEntries: manager.getBranch(), tokensBefore: conversationTokens(manager.buildSessionProjection().messages) };
  const boundaries = new Set<number>();
  for (let reserve = 12000; reserve < 22000; reserve += 10) {
    const checked = assertPinned(input, ctx, reserve, `capacity edge, reserve ${reserve}`);
    if (checked) boundaries.add(checked.pinned);
  }
  expect(boundaries.size).toBeGreaterThan(1);
});

for (const name of ['prose-heavy', 'low-prose', 'large-tool-output']) {
  test(`${name}: every scheduled cut preserves Part 6's pinned tail and can displace only its older extension`, () => {
    const recording = readFileSync(new URL(`./fixtures/regression/${name}.jsonl`, import.meta.url), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const header = recording[0] as NonNullable<ReturnType<SessionManager['getHeader']>>;
    const messages = recording.filter((entry: SessionEntry) => entry.type === 'message' && entry.message.role !== 'system') as SessionEntry[];
    let checked = 0, extended = 0, displaced = 0;
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
          const label = `${name}, window ${window}, reserve ${reserve}, cut after message ${at}`;
          const comparison = assertPinned(input, ctx, reserve, label);
          if (!comparison) continue;
          extended += Number(comparison.actualFrom < comparison.pinned);
          displaced += Number(comparison.actualFrom > comparison.expectedFrom);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(30);
    expect(extended).toBeGreaterThan(0);
    expect(displaced).toBeGreaterThan(0);
  });

  test(`${name}: successive 81,920-window cuts preserve Part 6's pinned part at the same cut point and input`, () => {
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
      const comparison = assertPinned(input, ctx, 16384, `${name}: scheduled cut ${checked + 1} after message ${at}`);
      expect(comparison).toBeDefined();
      if (comparison) {
        const actual = comparison.draft.compaction;
        manager.appendCompaction(actual.summary, actual.firstKeptEntryId, actual.tokensBefore, actual.details, true);
        branch.push(manager.getBranch().at(-1)!);
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(2);
  });
}
