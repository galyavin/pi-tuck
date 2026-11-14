import { createHash } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import type { ToolResultMessage } from '@earendil-works/pi-ai';
import { SessionManager, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { measurableConversationTokens } from '../src/budget';
import { keptSearchCandidates, parseSearchCommand, searchPathsMatch } from '../src/kept-searches';
import * as keptSearchModule from '../src/kept-searches';
import { classifyBash } from '../src/bash-command';
import * as bashModule from '../src/bash-command';
import { keptReadCandidates } from '../src/kept-reads';
import { projectedMessages } from '../src/omissions';
import { createRecall } from '../src/recall';
import { tuck, tuckObservedDraft, tuckRecall, type Tuck } from '../src/tuck';
import { buildGlobalIndexById } from '../src/tuck/core/global-indices';
import { parseRecords, serializeRecord, splitSummary, type TranscriptRecord } from '../src/tuck/core/transcript';

const answer = (content: unknown[], stopReason = 'stop') => ({ role: 'assistant', content, stopReason,
	api: 'openai-completions', provider: 'fixture', model: 'fixture', timestamp: 0,
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }) as never;
interface Call { name?: string; command?: string; path?: string; text?: string; content?: ToolResultMessage['content']; isError?: boolean; noResult?: boolean; args?: object }
function fixture(calls: Call[], cwd = '/kept-searches') {
	const manager = SessionManager.inMemory(cwd);
	manager.getHeader()!.cwd = cwd;
	manager.appendMessage({ role: 'user', content: 'Inspect the recorded files.', timestamp: 0 });
	const append = (call: Call, id: string) => {
		const name = call.name ?? 'bash';
		manager.appendMessage(answer([{ type: 'toolCall', id, name, arguments: call.args ?? (name === 'bash' ? { command: call.command } : { path: call.path }) }], 'toolUse'));
		return call.noResult ? undefined : manager.appendMessage({ role: 'toolResult', toolCallId: id, toolName: name, isError: call.isError ?? false,
			content: call.content ?? [{ type: 'text', text: call.text ?? 'src/a.ts:12:match' }], timestamp: 0 });
	};
	const results = calls.map((call, i) => append(call, `c${i}`));
	for (let i = 0; i < 8; i++) {
		append({ command: `cat log-${i}`, text: 'recorded output\n'.repeat(1500) }, `b${i}`);
		manager.appendMessage(answer([{ type: 'text', text: `Finished step ${i}.` }]));
	}
	manager.appendMessage({ role: 'user', content: 'Continue the task.', timestamp: 0 });
	const ctx = { cwd, sessionManager: manager, model: { contextWindow: 131072, maxTokens: 8192 } } as unknown as ExtensionContext;
	const measure = (messages: Parameters<typeof measurableConversationTokens>[0]) => measurableConversationTokens(messages, ctx);
	return { manager, ctx, results, measure, append };
}
function draftOf(s: ReturnType<typeof fixture>, reserve = 8192, compiler: Tuck = tuck) {
	const draft = tuckObservedDraft(compiler, { branchEntries: s.manager.getBranch(), tokensBefore: s.measure(s.manager.buildSessionProjection().messages) }, s.ctx, reserve, s.measure);
	if (!draft.compaction) throw new Error(draft.unavailable);
	return draft;
}
const recordsOf = (summary: string) => parseRecords(splitSummary(summary)!.body);
const keptOf = (summary: string) => recordsOf(summary).filter(r => r.title === 'Kept-read' || r.title === 'Kept-search');
const lineCost = (records: readonly TranscriptRecord[]) => records.reduce((n, record) => n + serializeRecord(record).length + 1, 0);
const candidatesOf = (s: ReturnType<typeof fixture>, indices = buildGlobalIndexById(s.manager.getEntries()), readable = createRecall({}).readable) =>
	keptSearchCandidates([s.manager.getHeader()!, ...s.manager.getBranch()], indices, entry => readable(entry) !== undefined);

test.each([
	'grep needle src/a.ts', 'rg -n "needle with spaces" src', 'cd /work/repo && grep -rn needle src | head -40',
	`cd 'a dir' && rg 'a|b' . | grep -v skip | sort | uniq | cut -d: -f1 | tail -n 3 | wc -l`,
	'rg --files src', 'grep -e needle -e other -- src/a.ts', 'rg\tneedle\tsrc/a.ts',
	'rg "needle$" src/a.ts', 'grep ^needle$ src/a.ts', 'rg needle{2} src/a.ts', 'rg needle#part src/a.ts',
])('accepts search %s', command => expect(parseSearchCommand(command)).toBeDefined());
test.each([
	'cat src/a.ts', 'git grep needle', 'env rg needle src', 'cd repo && cd src && rg needle .',
	'rg needle src | xargs cat', 'rg needle | rg other', 'rg needle | sed -n 1p',
	'rg needle; echo done', 'rg needle && echo done', 'rg needle || true', 'rg needle > out',
	'rg needle >> out', 'rg needle < in', 'rg $(cat pattern)', 'rg `cat pattern`',
	'rg needle |', '| rg needle', 'rg "unterminated', 'rg needle &', 'rg $PATTERN src', 'rg needle\nrm file',
])('rejects search %s', command => expect(parseSearchCommand(command)).toBeUndefined());
test.each([
	'ls', 'cat a | head -n 4 | wc -l', 'cd repo && pwd', 'echo done', 'tree src', 'file a', 'stat a',
	'find . -name "*.ts"', 'sed -n "1,4p" a', 'git status --short', 'git log -2', 'git diff -- a', 'git show HEAD:a',
	'cd repo && grep -n needle src | head',
])('recognizes read-only bash %s', command => expect(classifyBash(command).readOnly).toBe(true));
test.each([
	'du .', 'df .', 'which rg', 'git branch', 'sed -ne 1p a', 'rg needle | sort | uniq',
	'npm test', 'touch a', 'python script.py', 'find . -exec cat {} +', 'find . -execdir cat {} +', 'find . -delete', 'find . -fprint out',
	'sed 1p a', 'sed -ni 1p a', 'sed -n --in-place=.bak 1p a', 'git branch new', 'git branch --list', 'git checkout main',
	'cat a | sort', 'ls && pwd', 'cat a > b', 'unknown', '', 'cd repo',
])('unclassified bash voids searches: %s', command => expect(classifyBash(command).readOnly).toBe(false));

test('a kept search quotes the whole result, exact command and result index, beside reads; recall and tool outputs stay unchanged', () => {
	const command = 'cd /work/repo && rg -n "needle" src | head -20', body = 'src/a.ts:12:needle\n\n#42 Files: literal\\text\r\nlast line';
	const s = fixture([{ command, text: body }, { name: 'read', path: 'other', text: 'whole read' }]);
	const before = JSON.stringify(s.manager.getEntries()), draft = draftOf(s), records = recordsOf(draft.compaction.summary), kept = keptOf(draft.compaction.summary);
	const index = buildGlobalIndexById(s.manager.getEntries()).get(s.results[0]!)!;
	expect(kept.map(r => r.title)).toEqual(['Kept-read', 'Kept-search']);
	expect(kept[1]).toEqual({ kind: 'section', title: 'Kept-search', sourceIndex: index,
		text: `bash ${command} (as recorded at #${index}; no file it lists was written or edited since):\n${body}` });
	expect(records.findIndex(r => r.title === 'Kept-read')).toBe(records.findLastIndex(r => r.title === 'Files') + 1);
	expect(splitSummary(draft.compaction.summary)!.body.split('\n').filter(line => line.includes('Kept-search:'))).toEqual([serializeRecord(kept[1]!)]);
	const recalled = tuckRecall(tuck, s.manager.getEntries(), s.manager.getBranch(), { index }) as { entries: { text: string }[] };
	expect(recalled.entries[0]!.text).toBe(body);
	expect(draftOf(s).compaction.summary).toBe(draft.compaction.summary);
	expect(JSON.stringify(s.manager.getEntries())).toBe(before);
});

test.each(['write', 'edit'])('a later successful or missing %s voids named files; a failed mutation and unrelated file do not', name => {
	for (const noResult of [false, true]) for (const path of ['src/a.ts', '/work/repo/src/a.ts']) {
		const s = fixture([{ command: 'cd /work/repo && rg needle src/a.ts', text: 'needle' }, { name, path, noResult }]);
		expect(candidatesOf(s)).toEqual([]);
	}
	for (const mutation of [{ name, path: 'src/a.ts', isError: true }, { name, path: 'src/other.ts' }])
		expect(candidatesOf(fixture([{ command: 'rg needle src/a.ts', text: 'needle' }, mutation]))).toHaveLength(1);
});

test.each([
	['cd /work/repo && rg needle .', 'src/a.ts:12:needle', '/work/repo/src/a.ts'],
	['cd /work/repo && grep needle .', 'src/a.ts:needle', 'src/a.ts'],
	['cd /work/repo && rg needle ../repo/src/a.ts', 'needle', 'repo/src/a.ts'],
	['rg needle "a dir/file.ts"', 'needle', '/work/repo/a dir/file.ts'],
	['rg -g "*.ts" -t ts -e needle src/a.ts', 'needle', 'src/a.ts'],
	['grep -rn -A 3 -e needle src/a.ts', 'needle', 'src/a.ts'],
	['rg --regexp=needle --glob "*.ts" src/a.ts', 'needle', 'src/a.ts'],
	['grep --color needle src/a.ts', 'needle', 'src/a.ts'],
	['rg --max-columns-preview needle src/a.ts', 'needle', 'src/a.ts'],
	['grep -f patterns.txt src/a.ts', 'needle', 'patterns.txt'],
	['rg --files src/a.ts', 'src/a.ts', 'src/a.ts'],
	['rg needle . | head -n 3 src/a.ts', 'needle', 'src/a.ts'],
])('names paths from operands and output: %s', (command, text, path) => {
	expect(candidatesOf(fixture([{ command, text }, { name: 'edit', path }]))).toEqual([]);
});

test('path matching uses whole suffix components, including normalized paths', () => {
	for (const [a, b] of [['/work/repo/src/a.ts', 'src/a.ts'], ['./src/a.ts', 'a.ts'], ['src/../a.ts', '/repo/a.ts']]) expect(searchPathsMatch(a!, b!)).toBe(true);
	for (const [a, b] of [['src/a.ts', 'src/ba.ts'], ['src/a.ts', 'other/a.ts'], ['src/a.ts', 'a.ts.bak']]) expect(searchPathsMatch(a!, b!)).toBe(false);
});

test('path option values and patterns are not mistaken for files', () => {
	const s = fixture([{ command: 'rg -g glob -e pattern -A 3 src/a.ts', text: 'needle' },
		...['glob', 'pattern', '3', 'ba.ts'].map(path => ({ name: 'write', path }))]);
	expect(candidatesOf(s)).toHaveLength(1);
});

test('any later unsafe bash voids every older search even on error or without a result; fresh searches survive', () => {
	for (const mutation of [{ isError: false }, { isError: true }, { noResult: true }]) {
		const s = fixture([{ command: 'rg first a' }, { command: 'grep second b' }, { command: 'npm test', ...mutation }, { command: 'rg fresh c' }]);
		expect(candidatesOf(s).map(r => r.text!.split(' (')[0])).toEqual(['bash rg fresh c']);
	}
	expect(candidatesOf(fixture([{ command: 'rg first a' }, { args: {} }]))).toEqual([]);
	expect(candidatesOf(fixture([{ command: 'rg first a' }, { command: 'cd repo && find . -name "*.ts" | head -2' }]))).toHaveLength(1);
});

test('direct shell executions also void earlier searches unless read-only', () => {
	for (const command of ['git status --short', 'npm run build']) {
		const s = fixture([{ command: 'rg needle src/a.ts' }]);
		s.manager.appendMessage({ role: 'bashExecution', command, output: 'done', exitCode: 0, cancelled: false, truncated: false, timestamp: 0 });
		expect(candidatesOf(s)).toHaveLength(command.startsWith('git') ? 1 : 0);
	}
});

test('nonempty text-only results of at most 2000 characters are whole; no fallback to an older result for the same key', () => {
	const image = { type: 'image' as const, mimeType: 'image/png', data: 'aA==' };
	const s = fixture([{ command: 'rg limit a', text: 'x'.repeat(2000) }, { command: 'rg large b', text: 'x'.repeat(2001) },
		{ command: 'rg error c', isError: true }, { command: 'rg empty d', text: '' }, { command: 'rg no-blocks e', content: [] },
		{ command: 'rg image f', content: [image] }, { command: 'rg mixed g', content: [{ type: 'text', text: 'caption' }, image] },
		{ command: 'rg missing h', noResult: true }, { command: 'rg same i', text: 'old' }, { command: 'rg   same\ti', text: 'new' },
		{ command: 'grep failed-latest j', text: 'old success' }, { command: 'grep failed-latest j', isError: true }]);
	const candidates = candidatesOf(s);
	expect(candidates).toHaveLength(2);
	expect(candidates[0]!.text).toContain('\nnew');
	expect(candidates[1]!.text).toContain('\n' + 'x'.repeat(2000));
	expect(candidatesOf(s, new Map())).toEqual([]);
	expect(candidatesOf(s, undefined, () => undefined)).toEqual([]);
});

test('latest and recency follow result source indices, even with out-of-order results; voids follow call order', () => {
	const s = fixture([]), m = s.manager;
	m.appendMessage(answer([{ type: 'toolCall', id: 'old', name: 'bash', arguments: { command: 'rg same a' } },
		{ type: 'toolCall', id: 'edit', name: 'write', arguments: { path: 'a' } },
		{ type: 'toolCall', id: 'new', name: 'bash', arguments: { command: 'rg same a' } }], 'toolUse'));
	for (const id of ['new', 'old']) m.appendMessage({ role: 'toolResult', toolCallId: id, toolName: 'bash', isError: false, content: [{ type: 'text', text: id }], timestamp: 0 });
	// The latest result is from the invalidated old call, so the earlier-arriving result is not substituted.
	expect(candidatesOf(s)).toEqual([]);
});

function pricedDraft(s: ReturnType<typeof fixture>, reserve = 8192) {
	let maxBriefChars = 0, mandatory = new Set<number>();
	const draft = draftOf(s, reserve, { ...tuck, compileDialogue: input => {
		maxBriefChars = input.ranking.maxBriefChars; mandatory = new Set(input.ranking.mandatorySourceIndices);
		return tuck.compileDialogue(input);
	} });
	const records = recordsOf(draft.compaction.summary), kept = keptOf(draft.compaction.summary);
	const fixed = records.filter(r => r.kind === 'section' || r.kind === 'excerpt' && r.role === 'user' && mandatory.has(r.sourceIndex!));
	return { draft, kept, maxSummaryCharacters: maxBriefChars + lineCost(fixed) };
}

test('reads and searches merge newest first, with independent caps of four', () => {
	const s = fixture(Array.from({ length: 7 }, (_, i) => [{ command: `rg pattern${i} a`, text: `result ${i}` }, { name: 'read', path: `f${i}`, text: `read ${i}` }]).flat());
	const { kept } = pricedDraft(s);
	expect(kept.map(r => [r.title, r.text!.split('\n')[1]])).toEqual([6, 5, 4, 3].flatMap(i => [['Kept-read', `read ${i}`], ['Kept-search', `result ${i}`]]));
	expect(kept.map(r => r.sourceIndex)).toEqual(kept.map(r => r.sourceIndex).sort((a, b) => b! - a!));
});

test('at equal recency reads spend the allowance first and searches are popped first', () => {
	// A real result belongs to one tool; force equal locators to exercise the explicit tie policy.
	const s = fixture([...Array.from({ length: 56 }, (_, i) => ({ name: 'write', path: `written-${i}-` + 'p'.repeat(500) })),
		{ name: 'read', path: 'a', text: 'whole read '.repeat(20) }]);
	const sourceIndex = buildGlobalIndexById(s.manager.getEntries()).get(s.results.at(-1)!)!;
	const search: TranscriptRecord = { kind: 'section', title: 'Kept-search', sourceIndex, text: 'whole search '.repeat(20) };
	const mock = vi.spyOn(keptSearchModule, 'keptSearchCandidates').mockReturnValue([search]);
	try {
		const seen = new Set<number>();
		for (let reserve = 119000; reserve < 125000; reserve += 10) {
			const kept = keptOf(draftOf(s, reserve).compaction.summary);
			seen.add(kept.length);
			if (kept.length) expect(kept[0]!.title).toBe('Kept-read');
			if (kept.length === 2) expect(kept[1]).toEqual(search);
			if (!kept.length && seen.has(2)) break;
		}
		expect([...seen].sort()).toEqual([0, 1, 2]);
	} finally { mock.mockRestore(); }
});

test.each([32768, 262144])('reads and searches share the whole serialized allowance at window %i', window => {
	const s = fixture([{ name: 'read', path: 'small', text: 'complete' },
		...Array.from({ length: 4 }, (_, i) => [{ name: 'read', path: `read${i}`, text: 'r'.repeat(5000) }, { command: `rg pattern${i} src`, text: '\\'.repeat(2000) }]).flat()]);
	s.ctx.model = { ...s.ctx.model!, contextWindow: window };
	const { kept, maxSummaryCharacters } = pricedDraft(s), cap = Math.min(Math.floor(0.20 * maxSummaryCharacters), 24000);
	expect(lineCost(kept)).toBeLessThanOrEqual(cap);
	expect(kept.some(r => r.title === 'Kept-read')).toBe(true);
	expect(kept.some(r => r.title === 'Kept-search')).toBe(true);
	expect(cap < 24000).toBe(window === 32768);
	for (const record of kept.filter(r => r.title === 'Kept-search')) expect(candidatesOf(s)).toContainEqual(record);
});

test('over target pops the last added result across the merged list before shrinking ledgers', () => {
	const s = fixture([...Array.from({ length: 56 }, (_, i) => ({ name: 'write', path: `written-${i}-` + 'p'.repeat(500) })),
		...Array.from({ length: 4 }, (_, i) => [{ name: 'read', path: `read-${i}`, text: 'whole read '.repeat(20) }, { command: `rg pattern${i} src`, text: 'whole search '.repeat(20) }]).flat()]);
	const expected = keptOf(draftOf(s).compaction.summary), seen = new Set<number>();
	let shrunk = false;
	for (let reserve = 118000; reserve < 125000; reserve += 10) {
		const { compaction } = draftOf(s, reserve), records = recordsOf(compaction.summary), kept = keptOf(compaction.summary);
		if (records.some(r => r.title === 'Files' && r.text!.includes('older files:'))) { expect(kept).toEqual([]); shrunk = true; break; }
		seen.add(kept.length);
		expect(kept).toEqual(expected.slice(0, kept.length));
	}
	expect(expected).toHaveLength(8);
	expect([...seen].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
	expect(shrunk).toBe(true);
});

test('only prefix searches are kept, and native tail extension preserves their allowance and provenance', () => {
	const s = fixture([{ command: 'rg old a' }]);
	s.append({ command: 'rg tail b', text: 'tail result' }, 'tail');
	s.manager.appendMessage(answer([{ type: 'text', text: 'Read the tail.' }]));
	s.manager.appendMessage({ role: 'user', content: 'Continue again.', timestamp: 0 });
	const draft = draftOf(s), { compaction } = draft, branch = s.manager.getBranch(), boundary = branch.findIndex(e => e.id === compaction.firstKeptEntryId);
	const indices = buildGlobalIndexById(s.manager.getEntries()), prefixIndices = new Set(branch.slice(0, boundary).map(e => indices.get(e.id)));
	const kept = keptOf(compaction.summary);
	expect(kept).toHaveLength(2);
	for (const record of kept) expect(prefixIndices.has(record.sourceIndex)).toBe(true);
	const target = (compaction.details as { carriedTarget: number }).carriedTarget;
	expect(lineCost(kept)).toBeLessThanOrEqual(Math.min(Math.floor(0.20 * (compaction.summary.length + 4 * (target - draft.after))), 24000));
});

test('a mutation in the native suffix does not void a search from the prefix', () => {
	const s = fixture([{ command: 'rg needle src/a.ts' }]);
	s.append({ name: 'edit', path: 'src/a.ts' }, 'native-edit');
	expect(keptOf(draftOf(s).compaction.summary)).toHaveLength(1);
});

test('native omission excludes the search result both before drafting and from a saved summary', () => {
	const s = fixture([{ command: 'rg needle a' }, { command: 'rg needle b' }]), draft = draftOf(s);
	s.manager.appendCompaction(draft.compaction.summary, draft.compaction.firstKeptEntryId, draft.compaction.tokensBefore, draft.compaction.details, true);
	s.manager.appendContextEdit(s.results[0]!, null);
	const summary = projectedMessages(s.manager.buildSessionProjection().messages, s.ctx).find(m => m.role === 'compactionSummary');
	if (summary?.role !== 'compactionSummary') throw new Error('Missing summary');
	expect(keptOf(summary.summary)).toEqual(keptOf(draft.compaction.summary).filter(r => r.text!.startsWith('bash rg needle b ')));
	const omitted = fixture([{ command: 'rg needle a' }]);
	omitted.manager.appendContextEdit(omitted.results[0]!, null);
	expect(keptOf(draftOf(omitted).compaction.summary)).toEqual([]);
});

test('without a qualifying search the summary including kept reads is byte-identical to ba8de1e', () => {
	const s = fixture([{ command: 'npm test', text: 'passed' }, { name: 'read', path: 'a', text: 'whole read' }]);
	const summary = draftOf(s).compaction.summary;
	expect(keptOf(summary).map(r => r.title)).toEqual(['Kept-read']);
	expect(createHash('sha256').update(summary).digest('hex')).toBe('6fb4af0750b51528554c49b6e087278c8d42a1f147fb1123e94b524aecbc9d1f');
});


test.each([
	['C:\\repo\\src\\a.ts:12:needle', '.\\src\\a.ts'],
	['c:/repo/src/a.ts:needle', 'C:\\repo\\src\\a.ts'],
	['.\\src\\a.ts:12:needle', 'C:/repo/src/a.ts'],
	['src/../src/a.ts:needle', '.\\src\\a.ts'],
	['src\\a.ts:needle', 'c:/repo/src/a.ts'],
	['\\\\server\\share\\src\\a.ts:12:needle', '//server/share/src/a.ts'],
])('Windows output prefix %s matches an edited alias %s', (text, path) => {
	const calls = [{ command: 'rg needle .', text }];
	const before = fixture(calls, 'C:\\repo');
	expect(candidatesOf(before)).toHaveLength(1);
	for (const name of ['write', 'edit']) expect(candidatesOf(fixture([...calls, { name, path }], 'C:\\repo'))).toEqual([]);
});

test.each([
	'cd C:\\repo && rg needle src\\a.ts',
	'cd c:/repo && grep needle .\\src\\a.ts',
	'cd "C:\\repo\\my src" && rg needle "a file.ts"',
])('Windows command operands and cd resolve against the recorded header: %s', command => {
	const path = command.includes('my src') ? 'c:/repo/my src/a file.ts' : 'C:/repo/src/a.ts';
	const s = fixture([{ command, text: 'needle' }, { name: 'edit', path }], 'C:\\elsewhere');
	expect(candidatesOf(s)).toEqual([]);
});

test('Windows path comparison folds only the drive and respects whole suffixes', () => {
	for (const path of ['C:\\repo\\src\\a.ts', 'c:/repo/src/a.ts', '.\\src\\a.ts'])
		expect(searchPathsMatch(path, 'src/a.ts')).toBe(true);
	for (const path of ['d:/repo/src/a.ts', 'c:/repo/SRC/a.ts', 'c:/repo/src/ba.ts'])
		expect(searchPathsMatch('C:\\repo\\src\\a.ts', path)).toBe(false);
});

test.each([
	['cat src/a.ts', true], ['git status -- src/a.ts', true],
	['du src/a.ts', false], ['df src/a.ts', false], ['which src/a.ts', false],
	['git branch src/a.ts', false], ['sed -ne 1p src/a.ts', false],
	['rg needle src/a.ts | sort', false], ['rg needle src/a.ts | uniq', false], ['rg needle src/a.ts | cut -f1', false],
	["find src/a.ts -ok cat '{}' \\;", false], ["find src/a.ts -ok cat '{}' '+'", false],
	["find src/a.ts -okdir cat '{}' \\;", false], ["find src/a.ts -okdir cat '{}' '+'", false],
	['Set-Content src\\a.ts changed', false], ['git.exe reset --hard', false],
] as const)('both lanes use the shared decision for %s', (command, readOnly) => {
	const s = fixture([{ name: 'read', path: 'src/a.ts', text: 'whole' }, { command: 'rg initial src/a.ts' }, { command }]);
	const entries = [s.manager.getHeader()!, ...s.manager.getBranch()], indices = buildGlobalIndexById(s.manager.getEntries());
	expect(classifyBash(command, s.ctx.cwd).readOnly).toBe(readOnly);
	expect(keptReadCandidates(entries, indices, () => true)).toHaveLength(readOnly ? 1 : 0);
	expect(candidatesOf(s).some(record => record.text!.startsWith('bash rg initial '))).toBe(readOnly);
});

test('both lanes consume the same classifier function, including its Windows shell mode', () => {
	const s = fixture([{ name: 'read', path: 'src/a.ts' }, { command: 'rg needle src/a.ts' }, { command: 'cat src/a.ts' }]);
	const original = bashModule.classifyBash;
	const spy = vi.spyOn(bashModule, 'classifyBash').mockImplementation((command, cwd) => ({ ...original(command, cwd), readOnly: false }));
	try {
		expect(keptReadCandidates([s.manager.getHeader()!, ...s.manager.getBranch()], buildGlobalIndexById(s.manager.getEntries()), () => true)).toEqual([]);
		expect(candidatesOf(s)).toEqual([]);
		expect(spy).toHaveBeenCalledWith('cat src/a.ts', s.ctx.cwd);
	} finally { spy.mockRestore(); }
});
