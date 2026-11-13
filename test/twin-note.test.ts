import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { projectedMessages, measurableMessages } from '../src/omissions';
import { conversationTokens, projectedConversationTokens, measurableConversationTokens } from '../src/budget';
import { installCompaction } from '../src/compaction';
import { tuck, tuckRecall } from '../src/tuck';
import { buildGlobalIndexById, type GlobalIndexCursor } from '../src/tuck/core/global-indices';
import { serializeTranscript } from '../src/tuck/core/transcript';
import { DIALOGUE_SUFFIX } from '../src/tuck/core/format';

const summary = serializeTranscript([{ kind: 'omission', reason: 'Earlier tool output is out of view.' }]) + DIALOGUE_SUFFIX;
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const line = (n: number) => `Substantive source line ${n}: the recorded value is unchanged.`;
const lines = (n = 6, start = 0) => Array.from({ length: n }, (_, i) => line(start + i));
const ctxOf = (sessionManager: SessionManager) => ({ sessionManager, cwd: '/twin-note' }) as unknown as ExtensionContext;
let calls = 0;
function output(manager: SessionManager, text: string, toolName = 'read', isError = false, image = false) {
 const toolCallId = `twin-${++calls}`;
 const call = manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id: toolCallId, name: toolName, arguments: {} }],
  api: 'openai-completions', provider: 'fixture', model: 'fixture', usage, stopReason: 'toolUse', timestamp: calls });
 const id = manager.appendMessage({ role: 'toolResult', toolCallId, toolName, isError, timestamp: calls,
  content: [{ type: 'text', text }, ...(image ? [{ type: 'image' as const, mimeType: 'image/png', data: 'AAAA' }] : [])] });
 return { id, toolCallId, call };
}
function session() {
 const manager = SessionManager.inMemory('/twin-note');
 const first = manager.appendMessage({ role: 'user', content: 'Inspect the source.', timestamp: 1 });
 return { manager, ctx: ctxOf(manager), first };
}
function cut(manager: SessionManager, keep?: string, native = false) {
 const firstKept = keep ?? manager.appendMessage({ role: 'user', content: 'Continue after the cut.', timestamp: 2 });
 manager.appendCompaction(summary, firstKept, 10000, native ? { compactor: 'native' } : { compactor: 'pi-tuck' }, !native);
 return firstKept;
}
function project(manager: SessionManager) { return projectedMessages(manager.buildSessionProjection().messages, ctxOf(manager)); }
function note(manager: SessionManager, result: ReturnType<typeof output>, messages = project(manager)) {
 const message = messages.find(m => m.role === 'toolResult' && m.toolCallId === result.toolCallId);
 if (message?.role !== 'toolResult') throw new Error('Result missing from projection');
 const last = message.content.at(-1);
 return last?.type === 'text' && last.text.startsWith('[pi-tuck:') ? last.text : undefined;
}
const indexOf = (manager: SessionManager, id: string) => buildGlobalIndexById(manager.getEntries()).get(id)!;
const allNote = (n: number, k: number) => `[pi-tuck: this output repeats output #${k} from before the cut (every line of 20+ characters matches); tuck_recall {"index":${k}} shows it exactly.]`;

test('an identical re-read names the session-global source, and that index recalls the original exactly', () => {
 const { manager, first } = session();
 output(manager, lines(6, 100).join('\n')); // an abandoned branch still occupies global indices
 manager.branch(first);
 const text = lines().join('\n'), source = output(manager, text);
 cut(manager);
 const repeated = output(manager, text), k = indexOf(manager, source.id);
 expect(k).toBe(4);
 expect(note(manager, repeated)).toBe(allNote(6, k));
 const recalled = tuckRecall(tuck, manager.getEntries(), manager.getBranch(), { index: k });
 expect(recalled).toMatchObject({ status: 'ok', entries: [{ entryId: source.id, text }] });
 const projected = project(manager), message = projected.find(m => m.role === 'toolResult')!;
 expect(message).toMatchObject({ content: [{ type: 'text', text }, { type: 'text', text: allNote(6, k) }] });
 expect(projectedMessages(projected, ctxOf(manager))).toEqual(projected);
});

test('changed lines use raw 1-based positions, including repeated missing lines and short/blank lines', () => {
 const { manager } = session(), source = output(manager, lines(8).join('\n'));
 cut(manager);
 const raw = ['heading', '', ...lines(6), line(100), line(100), 'short', line(101)];
 const repeated = output(manager, raw.join('\n')), k = indexOf(manager, source.id);
 expect(note(manager, repeated)).toBe(`[pi-tuck: this output largely repeats output #${k} from before the cut (6 of its 8 distinct lines of 20+ characters match); tuck_recall {"index":${k}} shows it exactly. Lines here not in #${k}: 9, 10, 12.]`);
});

test('exactly 60 percent overlap qualifies and a long changed-line list ends with and m more', () => {
 const { manager } = session(), source = output(manager, lines(12).join('\n'));
 cut(manager);
 const repeated = output(manager, [...lines(12), ...lines(8, 100)].join('\n')), k = indexOf(manager, source.id);
 expect(note(manager, repeated)).toBe(`[pi-tuck: this output largely repeats output #${k} from before the cut (12 of its 20 distinct lines of 20+ characters match); tuck_recall {"index":${k}} shows it exactly. Lines here not in #${k}: 13, 14, 15, 16, 17 and 3 more.]`);
});

test.each([
 ['cat -n | sed -n', (s: string, i: number) => `  ${201 + i}\t${s}`],
 ['read bars', (s: string, i: number) => `${201 + i}| ${s}`],
 ['grep -n', (s: string, i: number) => `${201 + i}:${s}`],
 ['path:N:', (s: string, i: number) => `src/@scope/file-name.ts:${201 + i}: ${s}`],
 ['two spaces', (s: string, i: number) => `${201 + i}  ${s}`],
])('cross-tool normalization: read to %s', (_, numbered) => {
 const { manager } = session(), source = output(manager, lines().map((s, i) => `${i + 1}| ${s}`).join('\n'));
 cut(manager);
 const repeated = output(manager, lines().map(numbered).join('\n'), 'bash');
 expect(note(manager, repeated)).toBe(allNote(6, indexOf(manager, source.id)));
});

test('normalization strips just one prefix and counts distinct substantive lines only', () => {
 const { manager } = session();
 output(manager, Array(10).fill(line(0)).join('\n') + '\n' + Array(20).fill('short').join('\n'));
 cut(manager);
 const repeated = output(manager, Array(10).fill(`1| ${line(0)}`).join('\n'));
 expect(note(manager, repeated)).toBeUndefined();
 const double = output(manager, lines().map(s => `1| 2| ${s}`).join('\n'));
 expect(note(manager, double)).toBeUndefined();
});

test('a normalized line of exactly 20 characters is substantive', () => {
 const { manager } = session(), text = Array.from({ length: 5 }, (_, i) => `${i}abcdefghijklmnopqrs`).join('\n');
 const source = output(manager, text); cut(manager);
 expect(note(manager, output(manager, text))).toBe(allNote(5, indexOf(manager, source.id)));
});

test.each([
 ['shared below five', lines(4), [...lines(4), ...lines(2, 100)]],
 ['shared below sixty percent', lines(5), [...lines(5), ...lines(4, 100)]],
 ['fewer than five substantive lines', lines(4), lines(4)],
])('no note: %s', (_, earlier, current) => {
 const { manager } = session(); output(manager, earlier.join('\n')); cut(manager);
 expect(note(manager, output(manager, current.join('\n')))).toBeUndefined();
});

test.each(['error', 'tuck_recall', 'tuck_search', 'image'])('an %s result is neither a target nor a candidate', kind => {
 const { manager } = session(), text = lines().join('\n');
 const name = kind.startsWith('tuck_') ? kind : 'read';
 output(manager, text, name, kind === 'error', kind === 'image');
 cut(manager);
 expect(note(manager, output(manager, text))).toBeUndefined();
 // Add an eligible source and another cut so each excluded target would otherwise have a twin.
 cut(manager);
 const target = output(manager, text, name, kind === 'error', kind === 'image');
 expect(note(manager, target)).toBeUndefined();
});

test.each([false, true])('no note before a pi-tuck cut (native compaction=%s)', native => {
 const { manager } = session(), text = lines().join('\n'); output(manager, text);
 if (native) cut(manager, undefined, true);
 const repeated = output(manager, text), raw = manager.buildSessionProjection().messages;
 expect(note(manager, repeated)).toBeUndefined();
 expect(JSON.stringify(project(manager))).toBe(JSON.stringify(raw));
});

test('a saved cut never retroactively annotates a retained result that preceded it', () => {
 const { manager } = session(), text = lines().join('\n'); output(manager, text);
 const repeated = output(manager, text); cut(manager, repeated.call);
 expect(note(manager, repeated)).toBeUndefined();
});

test('the newest out-of-view candidate wins a tie, but a visible candidate with equal overlap suppresses it', () => {
 const { manager } = session(), text = lines().join('\n');
 output(manager, text); const newest = output(manager, text); cut(manager);
 const repeated = output(manager, text);
 expect(note(manager, repeated)).toBe(allNote(6, indexOf(manager, newest.id)));
 expect(note(manager, output(manager, text))).toBeUndefined();
});

test('a larger overlap beats a newer candidate and a source at firstKept remains in view', () => {
 const { manager } = session(), text = lines().join('\n'), best = output(manager, text);
 output(manager, lines(5).join('\n')); cut(manager);
 expect(note(manager, output(manager, text))).toBe(allNote(6, indexOf(manager, best.id)));
 const other = session(), kept = output(other.manager, text);
 cut(other.manager, kept.id);
 expect(note(other.manager, output(other.manager, text))).toBeUndefined();
});

test('a smaller in-view overlap does not suppress the best out-of-view twin', () => {
 const { manager } = session(), text = lines().join('\n'), source = output(manager, text);
 const keep = manager.appendMessage({ role: 'user', content: 'Keep the next output.', timestamp: 2 });
 output(manager, lines(5).join('\n')); cut(manager, keep);
 expect(note(manager, output(manager, text))).toBe(allNote(6, indexOf(manager, source.id)));
});

test('the latest preceding pi-tuck cut sets the split; a native cut does not replace it', () => {
 const { manager } = session(), text = lines().join('\n'); output(manager, text); cut(manager);
 const newer = output(manager, text); cut(manager); cut(manager, undefined, true);
 expect(note(manager, output(manager, text))).toBe(allNote(6, indexOf(manager, newer.id)));
});

test('notes and none verdicts survive later cuts, fifty appended results, and a cold-cache replay', () => {
 const { manager } = session(), text = lines().join('\n'), source = output(manager, text);
 const keep = cut(manager), repeated = output(manager, text), duplicate = output(manager, text);
 const expected = allNote(6, indexOf(manager, source.id));
 expect(note(manager, repeated)).toBe(expected); expect(note(manager, duplicate)).toBeUndefined();
 cut(manager, keep);
 for (let i = 0; i < 50; i++) output(manager, text);
 expect(note(manager, repeated)).toBe(expected); expect(note(manager, duplicate)).toBeUndefined();
 // A distinct manager identity replays the same immutable entries without any warmed memo.
 const cold = Object.create(manager) as SessionManager;
 expect(note(cold, repeated)).toBe(expected); expect(note(cold, duplicate)).toBeUndefined();
 expect(JSON.stringify(project(cold))).toBe(JSON.stringify(project(manager)));
});

test('tree navigation and a sibling fork invalidate the branch cache without importing abandoned candidates', () => {
 const { manager, first } = session(), text = lines().join('\n'), source = output(manager, text);
 cut(manager); const repeated = output(manager, text), oldLeaf = manager.getLeafId()!;
 const expected = allNote(6, indexOf(manager, source.id)); expect(note(manager, repeated)).toBe(expected);
 manager.branch(first); cut(manager); const sibling = output(manager, text);
 expect(note(manager, sibling)).toBeUndefined();
 manager.branch(oldLeaf); expect(note(manager, repeated)).toBe(expected);
 manager.branch(first); expect(JSON.stringify(project(manager))).toBe(JSON.stringify(manager.buildSessionProjection().messages));
});

test('a new session on the same manager resets the cache and source indices', () => {
 const { manager } = session(), text = lines().join('\n');
 output(manager, text); cut(manager); const repeated = output(manager, text);
 expect(note(manager, repeated)).toBeDefined();
 manager.newSession();
 const source = output(manager, text); cut(manager);
 expect(note(manager, output(manager, text))).toBe(allNote(6, indexOf(manager, source.id)));
});

test('the 4000 distinct-line cap applies to both new results and earlier candidates', () => {
 const { manager } = session(), first = lines(4000), source = output(manager, [...first, ...lines(6, 9000)].join('\n'));
 cut(manager);
 expect(note(manager, output(manager, [...first, ...lines(6, 8000)].join('\n')))).toBe(allNote(4000, indexOf(manager, source.id)));
 expect(note(manager, output(manager, lines(6, 9000).join('\n')))).toBeUndefined();
});

test('multiple text blocks join with newlines, and projection appends one separate block', () => {
 const { manager } = session(), text = lines().join('\n'), source = output(manager, text); cut(manager);
 const repeated = output(manager, text);
 const raw = manager.getEntry(repeated.id)!;
 if (raw.type !== 'message' || raw.message.role !== 'toolResult') throw new Error('Not a result');
 // Set up the saved fixture before the first cache use; subsequent projections must never mutate it.
 raw.message.content = [{ type: 'text', text: lines(3).join('\n') }, { type: 'text', text: lines(3, 3).join('\n') }];
 const before = JSON.stringify(manager.getEntries()), projected = project(manager);
 expect(note(manager, repeated, projected)).toBe(allNote(6, indexOf(manager, source.id)));
 expect(projected.find(m => m.role === 'toolResult')?.content).toHaveLength(3);
 expect(JSON.stringify(manager.getEntries())).toBe(before);
});

test('both budget measures count the exact appended note', () => {
 const { manager, ctx } = session(), text = lines().join('\n'), source = output(manager, text); cut(manager);
 output(manager, text);
 const raw = manager.buildSessionProjection().messages, expected = structuredClone(raw);
 const last = expected.at(-1)!;
 if (last.role !== 'toolResult') throw new Error('Not a result');
 last.content.push({ type: 'text', text: allNote(6, indexOf(manager, source.id)) });
 expect(projectedConversationTokens(raw, ctx)).toBe(conversationTokens(expected));
 expect(measurableConversationTokens(raw, ctx)).toBe(conversationTokens(expected));
 expect(projectedConversationTokens(raw, ctx)).toBeGreaterThan(conversationTokens(raw));
 expect(measurableMessages(raw, ctx)).toEqual(expected);
});

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
test('session-file bytes stay unchanged and reopening reproduces the same note', () => {
 const dir = mkdtempSync(join(tmpdir(), 'twin-note-')); dirs.push(dir);
 const manager = SessionManager.create(dir, dir), text = lines().join('\n');
 manager.appendMessage({ role: 'user', content: 'Read the file.', timestamp: 1 });
 const source = output(manager, text); cut(manager); const repeated = output(manager, text);
 const path = manager.getSessionFile()!, before = readFileSync(path), expected = allNote(6, indexOf(manager, source.id));
 expect(note(manager, repeated)).toBe(expected);
 expect(readFileSync(path).equals(before)).toBe(true);
 expect(note(SessionManager.open(path), repeated)).toBe(expected);
 expect(readFileSync(path).equals(before)).toBe(true);
});

test('disabled history hooks preserve a request even when a saved pi-tuck cut and a twin exist', async () => {
 const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
 const pi = { on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => handlers.set(name, handler),
  registerCommand: () => {}, registerTool: () => {} } as unknown as ExtensionAPI;
 const handle = await installCompaction(pi, { active: () => false });
 try {
  const { manager, ctx } = session(), text = lines().join('\n'); output(manager, text); cut(manager); output(manager, text);
  const messages = manager.buildSessionProjection().messages, before = JSON.stringify(messages);
  for (const hook of ['context', 'context_with_system']) expect(await handlers.get(hook)!({ messages }, ctx)).toBeUndefined();
  expect(JSON.stringify(messages)).toBe(before);
 } finally { await handle.close(); }
});

test('the incremental global index preserves missing-id slots and fail-closed duplicate ids across appends', () => {
 const cursor: GlobalIndexCursor = { byId: new Map(), ambiguous: new Set(), messageIndex: 0, through: 0 };
 const message = { role: 'user', content: 'text' }, entries = [{ type: 'message', id: 'a', message }, { type: 'message', message }];
 expect(buildGlobalIndexById(entries, cursor).get('a')).toBe(0);
 entries.push({ type: 'message', id: 'b', message }, { type: 'message', id: 'a', message });
 expect([...buildGlobalIndexById(entries, cursor)]).toEqual([['b', 2]]);
 entries.push({ type: 'message', id: 'a', message });
 expect([...buildGlobalIndexById(entries, cursor)]).toEqual([...buildGlobalIndexById(entries)]);
});
