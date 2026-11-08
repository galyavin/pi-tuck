import { expect, test } from 'vitest';
import { SessionManager, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { definitionLines, fileObservations, outputTail } from '../src/content-observations';
import { actionItems, actionRecords, ledgerItems, ledgerRecords } from '../src/ledger';
import { conversationTokens } from '../src/budget';
import { tuck, tuckObservedDraft } from '../src/tuck';
import { buildGlobalIndexById } from '../src/tuck/core/global-indices';
import { parseRecords, serializeRecords, splitSummary } from '../src/tuck/core/transcript';
import { CLOSING_INSTRUCTION } from '../src/tuck/core/format';

const assistant = (content: unknown[]) => ({ role: 'assistant' as const, content, stopReason: 'toolUse',
  api: 'openai-responses', provider: 'openai', model: 'm', timestamp: 0,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });

function fixture() {
  const manager = SessionManager.inMemory('/content-arm');
  let nextCall = 0;
  const call = (name: string, args: Record<string, unknown>) => {
    const id = `c${nextCall++}`;
    manager.appendMessage(assistant([{ type: 'toolCall', id, name, arguments: args }]) as never);
    return id;
  };
  const result = (toolCallId: string, toolName: string, text: string, isError = false) => manager.appendMessage({
    role: 'toolResult', toolCallId, toolName, timestamp: 0, isError, content: [{ type: 'text', text }],
  });
  const run = (name: string, args: Record<string, unknown>, text = 'ok', isError = false) => result(call(name, args), name, text, isError);
  const observations = (paths: string[]) => {
    const entries = manager.getBranch();
    return fileObservations(new Set(paths), entries, buildGlobalIndexById(entries), new Set(entries.flatMap(e =>
      e.type === 'message' && e.message.role === 'toolResult' && e.message.isError ? [e.message.toolCallId] : [])));
  };
  return { manager, call, result, run, observations };
}

test('command tails retain the last three nonempty lines, cut at the start within 200 characters, and keep the result pointer', () => {
  const f = fixture();
  const output = 'old log\n'.repeat(1000) + 'x'.repeat(250) + '\n\nTests: 128 passed\n  \nErrors: 0\n';
  f.run('bash', { command: 'npm test' }, output);
  const entries = f.manager.getBranch(), indices = buildGlobalIndexById(entries);
  const items = actionItems(entries, indices, () => true, new Set());
  expect(items[0]!.outputTail).toBe('…' + 'x'.repeat(171) + '\nTests: 128 passed\nErrors: 0');
  expect(items[0]!.outputTail!.length).toBe(200);
  expect(items[0]!.outputTail!.split('\n')).toHaveLength(3);
  const rows = actionRecords(items, items.length, new Set(items));
  expect(rows[1]!.text).toContain('(output: tuck_recall {"index":1}) (output tail):\n…');
  expect(parseRecords(serializeRecords(rows))).toEqual(rows);
  expect(outputTail('\n \n')).toBeUndefined();
  expect(outputTail('one\n\ntwo\n')).toBe('one\ntwo');
  expect(outputTail('old\na\nb\nc')).toBe('…a\nb\nc');
  expect(outputTail('😊'.repeat(200))).not.toMatch(/…[\uDC00-\uDFFF]/u);
});

test('Go writes and Python reads supply exact numbered definition lines with their content source', () => {
  const f = fixture();
  f.run('write', { path: 'engine.go', content: 'package engine\n\ntype Engine struct {\n}\nfunc New() *Engine {\n}\nvar (\n  Count = 0\n)' });
  f.run('read', { path: 'worker.py', offset: 20, limit: 5 }, '# worker\nclass Worker:\n    async def run(self):\n        pass\ndef main():');
  const known = f.observations(['engine.go', 'worker.py']);
  expect(known.get('engine.go')).toEqual({ sourceIndex: 0, text: '3: type Engine struct {\n5: func New() *Engine {\n7: var (' });
  expect(known.get('worker.py')).toEqual({ sourceIndex: 3, text: '21: class Worker:\n22:     async def run(self):\n24: def main():' });
  const entries = f.manager.getBranch(), items = ledgerItems(entries, buildGlobalIndexById(entries), () => true, new Set());
  for (const item of items) item.definitions = known.get(item.path);
  const rows = ledgerRecords(items, items.length, new Set(items));
  expect(rows[1]!.text).toBe('- read worker.py (tuck_recall {"index":2}) (definitions as of #3):\n21: class Worker:\n22:     async def run(self):\n24: def main():');
  expect(parseRecords(serializeRecords(rows))).toEqual(rows);
  expect(definitionLines('export const one = 1;\nexport let two = 2;\ninterface Three {}\nstruct Four {}\nfunction five() {}')).toBe(
    '1: export const one = 1;\n2: export let two = 2;\n3: interface Three {}\n4: struct Four {}\n5: function five() {}');
});

test('an edit invalidates older content until a later read or write; delayed reads cannot revive it', () => {
  const f = fixture();
  f.run('read', { path: 'a.py' }, 'def old():');
  f.run('edit', { path: 'a.py', oldText: 'old', newText: 'new' });
  expect(f.observations(['a.py']).has('a.py')).toBe(false);
  f.run('read', { path: 'a.py' }, 'def new():');
  expect(f.observations(['a.py']).get('a.py')?.text).toBe('1: def new():');
  const delayed = f.call('read', { path: 'a.py' });
  f.run('write', { path: 'a.py', content: 'def newest():' });
  f.result(delayed, 'read', 'def stale():');
  expect(f.observations(['a.py']).get('a.py')?.text).toBe('1: def newest():');
  f.run('edit', { path: 'a.py' }, 'failed', true);
  expect(f.observations(['a.py']).get('a.py')?.text).toBe('1: def newest():');
  f.run('read', { path: 'a.py' }, '# no definitions in newest content');
  expect(f.observations(['a.py']).has('a.py')).toBe(false);
  f.run('write', { path: 'a.py' });
  expect(f.observations(['a.py']).has('a.py')).toBe(false);
  expect(f.observations(['unknown.py']).size).toBe(0);
});

test('definition maps obey both per-file caps without clipping source lines', () => {
  const many = Array.from({ length: 100 }, () => 'def f():').join('\n');
  expect(definitionLines(many)!.split('\n')).toHaveLength(40);
  const wide = Array.from({ length: 100 }, (_, i) => `def function_${i}_${'x'.repeat(100)}():`).join('\n');
  const map = definitionLines(wide)!;
  expect(map.length).toBeLessThanOrEqual(800);
  expect(map.split('\n').length).toBeGreaterThan(1);
  expect(map.split('\n').every(line => line.endsWith('():'))).toBe(true);
});

function rankedFixture(laterEdit = false, olderItems = false) {
  const f = fixture();
  const opening = 'FIRST_PROMPT: ' + 'Keep this exact opening. '.repeat(8);
  f.manager.appendMessage({ role: 'user', content: opening, timestamp: 0 });
  if (olderItems) {
    f.run('write', { path: 'older.py', content: Array.from({ length: 12 }, (_, i) => `def older_${i}():`).join('\n') });
    f.run('bash', { command: 'older-command' }, 'OLD_OUTPUT: ' + 'x'.repeat(220));
  }
  f.run('write', { path: 'engine.go', content: Array.from({ length: 3 }, (_, i) => `func Engine${i}() {}`).join('\n') });
  f.run('bash', { command: 'npm test' }, 'old log\n'.repeat(1000) + 'Tests: 128 passed\nErrors: 0\nDuration: 1s');
  for (let i = 0; i < 8; i++) {
    f.manager.appendMessage({ role: 'user', content: `OPENING_${i}: ` + 'Task context. '.repeat(10), timestamp: 0 });
    f.manager.appendMessage(assistant([{ type: 'text', text: 'Historical observations. '.repeat(300) }]) as never);
  }
  f.manager.appendMessage({ role: 'user', content: 'CURRENT_PROMPT: Preserve this entire input.', timestamp: 0 });
  if (laterEdit) f.run('edit', { path: 'engine.go', oldText: 'Engine0', newText: 'Updated' });
  f.manager.appendMessage(assistant([{ type: 'text', text: 'RECENT_STATE: observed and ready.' }]) as never);
  const ctx = { sessionManager: f.manager, cwd: '/content-arm', model: { contextWindow: 131072, maxTokens: 16384 } } as unknown as ExtensionContext;
  const draft = (room: number) => tuckObservedDraft(tuck, { branchEntries: f.manager.getBranch(), tokensBefore: conversationTokens(f.manager.buildSessionProjection().messages) },
    ctx, 131072 - room, conversationTokens, {}, true);
  return { ...f, opening, draft };
}

test('observations spend only leftover room and disappear before protected openings or the whole native tail', () => {
  const f = rankedFixture(), large = f.draft(1200);
  if (!large.compaction) throw new Error(large.unavailable);
  expect(large.compaction.summary).toContain('(output tail):');
  expect(large.compaction.summary).toContain('(definitions as of #1):');
  let tight: ReturnType<typeof f.draft> | undefined;
  for (let room = 1150; room >= 350; room -= 5) {
    const candidate = f.draft(room);
    if (!candidate.compaction || candidate.compaction.firstKeptEntryId !== large.compaction.firstKeptEntryId) continue;
    if (!candidate.compaction.summary.includes('(output tail):') && !candidate.compaction.summary.includes('(definitions as of #')) { tight = candidate; break; }
  }
  expect(tight?.compaction).toBeDefined();
  if (!tight?.compaction) return;
  const records = parseRecords(splitSummary(tight.compaction.summary)!.body);
  expect(records.some(r => r.role === 'user' && r.text?.startsWith(f.opening.slice(0, 80)))).toBe(true);
  // The current native turn is the eighth answered turn; the other seven are quoted.
  for (let i = 1; i < 8; i++) expect(records.some(r => r.role === 'user' && r.text?.startsWith((`OPENING_${i}: ` + 'Task context. '.repeat(10)).slice(0, 80)))).toBe(true);
  expect(tight.compaction.summary).toContain('- bash: npm test (output: tuck_recall');
  expect(tight.compaction.summary).toContain('- wrote/edited engine.go (tuck_recall');
  for (const d of [large, tight]) {
    if (!d.compaction) throw new Error(d.unavailable);
    expect(d.after).toBeLessThanOrEqual((d.compaction.details as { carriedTarget: number }).carriedTarget);
    const branch = f.manager.getBranch(), at = branch.findIndex(e => e.id === d.compaction!.firstKeptEntryId);
    expect(branch.slice(at).flatMap(e => e.type === 'message' ? [e.message] : [])).toEqual([
      { role: 'user', content: 'CURRENT_PROMPT: Preserve this entire input.', timestamp: 0 },
      assistant([{ type: 'text', text: 'RECENT_STATE: observed and ready.' }]),
    ]);
  }
});

test('an edit in the kept tail invalidates a file map from the compacted prefix', () => {
  const f = rankedFixture(true), draft = f.draft(16000);
  if (!draft.compaction) throw new Error(draft.unavailable);
  expect(draft.compaction.summary).toContain('- wrote/edited engine.go');
  expect(draft.compaction.summary).not.toContain('(definitions as of #');
});

test('room pressure removes older observations per item while their pointer lines remain', () => {
  const f = rankedFixture(false, true);
  let actionGaveWay = false, fileGaveWay = false;
  for (let room = 2400; room >= 600 && !(actionGaveWay && fileGaveWay); room -= 10) {
    const draft = f.draft(room);
    if (!draft.compaction) continue;
    const records = parseRecords(splitSummary(draft.compaction.summary)!.body);
    const line = (needle: string) => records.find(r => r.kind === 'section' && r.text?.startsWith(needle))?.text;
    const newAction = line('- bash: npm test'), oldAction = line('- bash: older-command');
    const newFile = line('- wrote/edited engine.go'), oldFile = line('- wrote/edited older.py');
    if (newAction && oldAction) {
      const newer = newAction.includes('(output tail):'), older = oldAction.includes('(output tail):');
      expect(!older || newer).toBe(true);
      actionGaveWay ||= newer && !older;
    }
    if (newFile && oldFile) {
      const newer = newFile.includes('(definitions as of #'), older = oldFile.includes('(definitions as of #');
      expect(!older || newer).toBe(true);
      fileGaveWay ||= newer && !older;
    }
  }
  expect(actionGaveWay).toBe(true);
  expect(fileGaveWay).toBe(true);
});

test('the closing instruction directs command recall and preserves the file reread instruction', () => {
  expect(CLOSING_INSTRUCTION).toBe('Only the dialogue and the actions and files listed above carry over. Files created by commands are not listed: Before re-running a command listed above, read its output with tuck_recall instead. Re-read a file before editing it or importing from it. Use tuck_recall for anything else. Treat anything not shown here as unknown.');
});
