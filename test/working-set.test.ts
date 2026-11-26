import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { SessionManager, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { measurableConversationTokens } from '../src/budget';
import { tuck, tuckObservedDraft } from '../src/tuck';
import { CLOSING_INSTRUCTION, DIALOGUE_SUFFIX, WORKING_FILES_INSTRUCTION } from '../src/tuck/core/format';
import { parseRecords, splitSummary } from '../src/tuck/core/transcript';
import { readPath, setWorkingFileReader } from '../src/working-set';

const answer = (content: unknown[], stopReason = 'stop') => ({ role: 'assistant', content, stopReason,
	api: 'openai-completions', provider: 'fixture', model: 'fixture', timestamp: 0,
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }) as never;
type Read = { path: string; text: string; args?: Record<string, unknown> };
const dirs: string[] = [];
afterEach(() => { setWorkingFileReader(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
/** A session in a real folder: the reads in its compacted prefix, then large outputs that make the cut useful. */
function fixture(reads: Read[], files: Record<string, string>, window = 131072) {
	const cwd = mkdtempSync(join(tmpdir(), 'working-set-'));
	dirs.push(cwd);
	for (const [name, text] of Object.entries(files)) writeFileSync(join(cwd, name), text);
	const manager = SessionManager.inMemory(cwd);
	manager.getHeader()!.cwd = cwd;
	manager.appendMessage({ role: 'user', content: 'Fix the recorded files.', timestamp: 0 });
	reads.forEach((read, i) => {
		manager.appendMessage(answer([{ type: 'toolCall', id: `r${i}`, name: 'read', arguments: read.args ?? { path: read.path } }], 'toolUse'));
		manager.appendMessage({ role: 'toolResult', toolCallId: `r${i}`, toolName: 'read', isError: false, content: [{ type: 'text', text: read.text }], timestamp: 0 });
	});
	for (let i = 0; i < 8; i++) {
		manager.appendMessage(answer([{ type: 'toolCall', id: `b${i}`, name: 'bash', arguments: { command: `step ${i}` } }], 'toolUse'));
		manager.appendMessage({ role: 'toolResult', toolCallId: `b${i}`, toolName: 'bash', isError: false,
			content: [{ type: 'text', text: 'recorded output\n'.repeat(1500) }], timestamp: 0 });
		manager.appendMessage(answer([{ type: 'text', text: `Finished step ${i}.` }]));
	}
	manager.appendMessage({ role: 'user', content: 'Continue the task.', timestamp: 0 });
	const ctx = { cwd, sessionManager: manager, model: { contextWindow: window, maxTokens: 8192 } } as unknown as ExtensionContext;
	const measure = (messages: Parameters<typeof measurableConversationTokens>[0]) => measurableConversationTokens(messages, ctx);
	return { cwd, manager, ctx, measure };
}
function draftOf(s: ReturnType<typeof fixture>, reserve = 8192) {
	const draft = tuckObservedDraft(tuck, { branchEntries: s.manager.getBranch(), tokensBefore: s.measure(s.manager.buildSessionProjection().messages) }, s.ctx, reserve, s.measure);
	if (!draft.compaction) throw new Error(draft.unavailable);
	return draft.compaction;
}
const closingOf = (summary: string) => splitSummary(summary)!.closing;
const keptReads = (summary: string) => parseRecords(splitSummary(summary)!.body).filter(r => r.kind === 'section' && r.title === 'Kept-read');
const SOURCE = 'export function a() {\n\treturn "a\\\\b";\n}\n';

test('a re-read file that is unchanged on disk is carried raw, after the closing words, and only its re-read rule is dropped', () => {
	const s = fixture([{ path: 'a.ts', text: SOURCE }, { path: 'a.ts', text: SOURCE }], { 'a.ts': SOURCE });
	const { summary, details } = draftOf(s);
	const closing = closingOf(summary);
	expect(closing.startsWith('\n\n---\n\n' + WORKING_FILES_INSTRUCTION)).toBe(true);
	expect(WORKING_FILES_INSTRUCTION).not.toBe(CLOSING_INSTRUCTION);
	expect(WORKING_FILES_INSTRUCTION).toContain('unless it is one of the working files below');
	// Verbatim: real line breaks and backslashes, so the text can be quoted exactly in an edit.
	expect(closing).toContain(`<file path="a.ts">\n${SOURCE}\n</file>`);
	expect(keptReads(summary)).toEqual([]);
	expect((details as { workingSet?: unknown }).workingSet).toEqual({ carried: ['a.ts'], offered: 1, rejected: 0 });
});

test('a file read once is not a working file: it keeps the escaped kept read and the plain closing', () => {
	const s = fixture([{ path: 'a.ts', text: SOURCE }], { 'a.ts': SOURCE });
	const { summary, details } = draftOf(s);
	expect(closingOf(summary)).toBe(DIALOGUE_SUFFIX);
	expect(keptReads(summary)).toHaveLength(1);
	expect((details as { workingSet?: unknown }).workingSet).toBeUndefined();
});

test('a file changed on disk since its last read is rejected, whatever changed it', () => {
	// No edit or write is recorded: a shell command or generator changed it. The disk check alone catches it.
	const s = fixture([{ path: 'a.ts', text: SOURCE }, { path: 'a.ts', text: SOURCE }], { 'a.ts': SOURCE + '// regenerated\n' });
	const { summary, details } = draftOf(s);
	expect(closingOf(summary)).toBe(DIALOGUE_SUFFIX);
	expect((details as { workingSet?: unknown }).workingSet).toEqual({ carried: [], offered: 0, rejected: 1 });
});

test('a missing file is rejected', () => {
	const s = fixture([{ path: 'gone.ts', text: SOURCE }, { path: 'gone.ts', text: SOURCE }], {});
	expect((draftOf(s).details as { workingSet?: unknown }).workingSet).toEqual({ carried: [], offered: 0, rejected: 1 });
});

test.each([{ offset: 1 }, { limit: 50 }])('a last read that is partial is never carried, even after a whole read: %j', partial => {
	const s = fixture([{ path: 'a.ts', text: SOURCE }, { path: 'a.ts', text: SOURCE, args: { path: 'a.ts', ...partial } }], { 'a.ts': SOURCE });
	const { summary, details } = draftOf(s);
	expect(closingOf(summary)).toBe(DIALOGUE_SUFFIX);
	expect((details as { workingSet?: unknown }).workingSet).toBeUndefined();
});

test('a truncated whole read never matches the file on disk', () => {
	const big = 'line\n'.repeat(3000), shown = 'line\n'.repeat(2000) + '\n[Showing lines 1-2000 of 3001. Use offset=2001 to continue.]';
	const s = fixture([{ path: 'big.txt', text: shown }, { path: 'big.txt', text: shown }], { 'big.txt': big });
	expect((draftOf(s).details as { workingSet?: unknown }).workingSet).toEqual({ carried: [], offered: 0, rejected: 1 });
});

test('working files rank by reads, then by the most recent last read', () => {
	const files = { 'a.ts': 'a\n', 'b.ts': 'b\n', 'c.ts': 'c\n' };
	const s = fixture([{ path: 'a.ts', text: 'a\n' }, { path: 'b.ts', text: 'b\n' }, { path: 'c.ts', text: 'c\n' }, { path: 'b.ts', text: 'b\n' },
		{ path: 'a.ts', text: 'a\n' }, { path: 'b.ts', text: 'b\n' }, { path: 'c.ts', text: 'c\n' }], files);
	expect((draftOf(s).details as { workingSet?: { carried: string[] } }).workingSet!.carried).toEqual(['b.ts', 'c.ts', 'a.ts']);
});

test('the working set is paid for from the summary: the native tail is the same with or without it, and a file over the allowance is skipped whole', () => {
	const huge = 'h'.repeat(60_000) + '\n', small = 'small\n';
	const reads = [{ path: 'huge.txt', text: huge }, { path: 'huge.txt', text: huge }, { path: 'huge.txt', text: huge }, { path: 's.ts', text: small }, { path: 's.ts', text: small }];
	const s = fixture(reads, { 'huge.txt': huge, 's.ts': small }, 32768);
	const withCarry = draftOf(s, 16384);
	expect((withCarry.details as { workingSet?: { carried: string[] } }).workingSet!.carried).toEqual(['s.ts']);
	setWorkingFileReader(() => undefined);
	const without = draftOf(s, 16384);
	expect(closingOf(without.summary)).toBe(DIALOGUE_SUFFIX);
	expect(withCarry.firstKeptEntryId).toBe(without.firstKeptEntryId);
});

test('read paths resolve as Pi resolves them', () => {
	expect(readPath('@src/a.ts', '/repo')).toBe('/repo/src/a.ts');
	expect(readPath('/abs/a.ts', '/repo')).toBe('/abs/a.ts');
	expect(readPath('~/a.ts', '/repo').endsWith('/a.ts')).toBe(true);
	expect(readPath('~/a.ts', '/repo').startsWith('/repo')).toBe(false);
});
