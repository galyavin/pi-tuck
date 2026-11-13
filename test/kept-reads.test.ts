import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import type { ToolResultMessage } from '@earendil-works/pi-ai';
import { SessionManager, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { measurableConversationTokens } from '../src/budget';
import { keptReadCandidates } from '../src/kept-reads';
import { projectedMessages } from '../src/omissions';
import { createRecall } from '../src/recall';
import { tuck, tuckObservedDraft, tuckRecall, type Tuck } from '../src/tuck';
import { buildGlobalIndexById } from '../src/tuck/core/global-indices';
import { CLOSING_INSTRUCTION } from '../src/tuck/core/format';
import { parseRecords, serializeRecord, splitSummary, type TranscriptRecord } from '../src/tuck/core/transcript';

const answer = (content: unknown[], stopReason = 'stop') => ({ role: 'assistant', content, stopReason,
	api: 'openai-completions', provider: 'fixture', model: 'fixture', timestamp: 0,
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }) as never;
interface Call { name?: string; path: string; text?: string; content?: ToolResultMessage['content']; isError?: boolean; noResult?: boolean; args?: Record<string, unknown> }
function fixture(calls: Call[], dialogueCharacters = 0) {
	const manager = SessionManager.inMemory('/kept-reads');
	manager.appendMessage({ role: 'user', content: 'Inspect the recorded files.', timestamp: 0 });
	const results = calls.map((call, i) => {
		const name = call.name ?? 'read', id = `c${i}`;
		manager.appendMessage(answer([{ type: 'toolCall', id, name, arguments: call.args ?? { path: call.path } }], 'toolUse'));
		return call.noResult ? undefined : manager.appendMessage({ role: 'toolResult', toolCallId: id, toolName: name, isError: call.isError ?? false,
			content: call.content ?? [{ type: 'text', text: call.text ?? `contents of ${call.path}` }], timestamp: 0 });
	});
	// Large ordinary outputs make the cut useful and keep the reads in its compacted prefix.
	for (let i = 0; i < 8; i++) {
		manager.appendMessage(answer([{ type: 'toolCall', id: `b${i}`, name: 'bash', arguments: { command: `step ${i}` } }], 'toolUse'));
		manager.appendMessage({ role: 'toolResult', toolCallId: `b${i}`, toolName: 'bash', isError: false,
			content: [{ type: 'text', text: 'recorded output\n'.repeat(1500) }], timestamp: 0 });
		manager.appendMessage(answer([{ type: 'text', text: `Finished step ${i}.` + 'x'.repeat(dialogueCharacters) }]));
	}
	manager.appendMessage({ role: 'user', content: 'Continue the task.', timestamp: 0 });
	const ctx = { cwd: '/kept-reads', sessionManager: manager, model: { contextWindow: 131072, maxTokens: 8192 } } as unknown as ExtensionContext;
	const measure = (messages: Parameters<typeof measurableConversationTokens>[0]) => measurableConversationTokens(messages, ctx);
	return { manager, ctx, results, measure };
}
function draftOf(s: ReturnType<typeof fixture>, reserve = 8192, compiler: Tuck = tuck) {
	const draft = tuckObservedDraft(compiler, { branchEntries: s.manager.getBranch(), tokensBefore: s.measure(s.manager.buildSessionProjection().messages) }, s.ctx, reserve, s.measure);
	if (!draft.compaction) throw new Error(draft.unavailable);
	return draft;
}
const recordsOf = (summary: string) => parseRecords(splitSummary(summary)!.body);
const keptOf = (summary: string) => recordsOf(summary).filter(r => r.kind === 'section' && r.title === 'Kept-read');
const lineCost = (records: readonly TranscriptRecord[]) => records.reduce((n, record) => n + serializeRecord(record).length + 1, 0);
const candidatesOf = (s: ReturnType<typeof fixture>, indices = buildGlobalIndexById(s.manager.getEntries()), readable = createRecall({}).readable) =>
	keptReadCandidates(s.manager.getBranch(), indices, entry => readable(entry) !== undefined);

test('a kept read quotes the whole result with the exact header, after Files, on one escaped line; its global index recalls the result', () => {
	const body = 'first line\nC:\\project\r\n#42 Files: text, not a record\n\n---\n\nlast line';
	const s = fixture([{ path: 'src/a.ts', text: body }]);
	const draft = draftOf(s), summary = draft.compaction.summary, records = recordsOf(summary), kept = keptOf(summary);
	const index = buildGlobalIndexById(s.manager.getEntries()).get(s.results[0]!)!;
	expect(kept).toEqual([{ kind: 'section', title: 'Kept-read', text: `read src/a.ts (as recorded at #${index}; no write or edit recorded since):\n${body}`, sourceIndex: index }]);
	expect(records.findIndex(r => r.title === 'Kept-read')).toBe(records.findLastIndex(r => r.title === 'Files') + 1);
	expect(splitSummary(summary)!.body.split('\n').filter(line => line.includes('Kept-read:'))).toEqual([serializeRecord(kept[0]!)]);
	const recalled = tuckRecall(tuck, s.manager.getEntries(), s.manager.getBranch(), { index }) as { entries: { role: string; text: string }[] };
	expect(recalled.entries[0]).toMatchObject({ role: 'toolResult', text: body });
	expect(summary.endsWith(CLOSING_INSTRUCTION)).toBe(true);
});

test.each(['write', 'edit'])('a later %s invalidates a read regardless of its result, and a re-read is eligible', name => {
	const s = fixture([
		{ path: 'success' }, { name, path: 'success' },
		{ path: 'failed' }, { name, path: 'failed', isError: true },
		{ path: 'missing' }, { name, path: 'missing', noResult: true },
		{ path: 'again', text: 'old' }, { name, path: 'again', isError: true }, { path: 'again', text: 'new contents' },
	]);
	const kept = keptOf(draftOf(s).compaction.summary);
	expect(kept).toHaveLength(1);
	expect(kept[0]!.text).toMatch(/^read again .*\nnew contents$/);
});

test('only the latest eligible read per path is kept; errors, empty, image-only and mixed results are excluded', () => {
	const image = { type: 'image' as const, mimeType: 'image/png', data: 'aA==' };
	const s = fixture([
		{ path: 'same', text: 'old contents' }, { path: 'same', text: 'latest contents' },
		{ path: 'error', isError: true }, { path: 'empty', text: '' }, { path: 'no-blocks', content: [] },
		{ path: 'image', content: [image] }, { path: 'mixed', content: [{ type: 'text', text: 'caption' }, image] },
		{ path: 'missing-result', noResult: true }, { path: 'bad\npath' },
	]);
	const kept = keptOf(draftOf(s).compaction.summary);
	expect(kept).toHaveLength(1);
	expect(kept[0]!.text).toContain('\nlatest contents');
});

test('path aliases use the ledger extractor; unreadable or unindexed results cannot be kept', () => {
	const s = fixture(['path', 'file_path', 'filePath', 'file'].map((key, i) => ({ path: `p${i}`, args: { [key]: `p${i}` } })));
	expect(candidatesOf(s).map(r => r.text!.split(' ')[1])).toEqual(['p3', 'p2', 'p1', 'p0']);
	expect(candidatesOf(s, new Map())).toEqual([]);
	expect(candidatesOf(s, undefined, () => undefined)).toEqual([]);
});

test('newest means result order, even when the calls were issued together and results arrived out of order', () => {
	const s = fixture([]), m = s.manager;
	m.appendMessage(answer([{ type: 'toolCall', id: 'first', name: 'read', arguments: { path: 'first' } },
		{ type: 'toolCall', id: 'second', name: 'read', arguments: { path: 'second' } }], 'toolUse'));
	for (const id of ['second', 'first']) m.appendMessage({ role: 'toolResult', toolCallId: id, toolName: 'read', isError: false, content: [{ type: 'text', text: id }], timestamp: 0 });
	expect(candidatesOf(s).map(r => r.text!.split(' ')[1])).toEqual(['first', 'second']);
});

test('a mutation in the native suffix does not invalidate a read in the compacted prefix', () => {
	const s = fixture([{ path: 'a', text: 'before the native edit' }]);
	s.manager.appendMessage(answer([{ type: 'toolCall', id: 'native-edit', name: 'edit', arguments: { path: 'a' } }], 'toolUse'));
	s.manager.appendMessage({ role: 'toolResult', toolCallId: 'native-edit', toolName: 'edit', isError: false, content: [{ type: 'text', text: 'edited' }], timestamp: 0 });
	const { compaction } = draftOf(s);
	expect(keptOf(compaction.summary)).toHaveLength(1);
	expect(keptOf(compaction.summary)[0]!.text).toContain('\nbefore the native edit');
});

function pricedDraft(s: ReturnType<typeof fixture>, reserve = 8192) {
	let maxBriefChars = 0, mandatory = new Set<number>();
	const draft = draftOf(s, reserve, { ...tuck, compileDialogue: input => {
		maxBriefChars = input.ranking.maxBriefChars; mandatory = new Set(input.ranking.mandatorySourceIndices);
		return tuck.compileDialogue(input);
	} });
	const records = recordsOf(draft.compaction.summary), kept = keptOf(draft.compaction.summary);
	// The compiler receives room after the bare ledger and protected dialogue;
	// content additions must not inflate the allowance they are checked against.
	const fixed = records.filter(r => r.kind === 'section' && ['Actions', 'Files'].includes(r.title!) || r.kind === 'excerpt' && r.role === 'user' && mandatory.has(r.sourceIndex!))
		.map(r => r.kind === 'section' ? { ...r, text: r.text!.replace(/ \((?:output tail|definitions as of #\d+)\):\n[\s\S]*$/u, '') } : r);
	return { draft, kept, maxSummaryCharacters: maxBriefChars + lineCost(fixed) };
}

test('at most four whole outputs are kept, newest first', () => {
	const s = fixture(Array.from({ length: 7 }, (_, i) => ({ path: `f${i}`, text: `whole output ${i}` })));
	const { kept } = pricedDraft(s);
	expect(kept.map(r => r.text!.split(' ')[1])).toEqual(['f6', 'f5', 'f4', 'f3']);
	for (const record of kept) expect(record.text).toMatch(/\nwhole output [3-6]$/);
});

test.each([32768, 262144])('whole escaped line costs respect min(20%%, 24000) at a %i window; oversize newest reads are skipped', window => {
	const s = fixture([
		{ path: 'old-small', text: 'small complete output' },
		{ path: 'escaped', text: '\n\\\r'.repeat(800) },
		{ path: 'large', text: 'x'.repeat(20000) },
		{ path: 'oversize-newest', text: 'x'.repeat(24000) },
	]);
	s.ctx.model = { ...s.ctx.model!, contextWindow: window };
	const { kept, maxSummaryCharacters } = pricedDraft(s);
	const cap = Math.min(Math.floor(0.20 * maxSummaryCharacters), 24000);
	expect(lineCost(kept)).toBeLessThanOrEqual(cap);
	expect(kept.some(r => r.text!.startsWith('read oversize-newest '))).toBe(false);
	expect(kept.some(r => r.text!.startsWith('read old-small '))).toBe(true);
	expect(cap < 24000).toBe(window === 32768);
	for (const record of kept) expect(candidatesOf(s)).toContainEqual(record);
});

test('escaping and the header count against the allowance, rather than only raw output characters', () => {
	const s = fixture([{ path: 'small', text: 'complete' }, { path: 'escaped', text: '\\'.repeat(13000) }, { path: 'header', text: 'x'.repeat(23999) }]);
	s.ctx.model = { ...s.ctx.model!, contextWindow: 262144 };
	const { kept, maxSummaryCharacters } = pricedDraft(s);
	expect(Math.min(Math.floor(0.20 * maxSummaryCharacters), 24000)).toBe(24000);
	expect(kept.map(r => r.text!.split(' ')[1])).toEqual(['small']);
});

test('a whole read that exceeds the remaining target room is skipped even below the per-kind cap, so an older small read can fit', () => {
	const s = fixture([{ path: 'old-small', text: 'small complete output' }, { path: 'new-large', text: 'x'.repeat(2000) }], 1000);
	const newest = candidatesOf(s)[0]!;
	let skippedForRoom = false;
	for (let reserve = 110000; reserve < 129000; reserve += 20) {
		const { draft, kept, maxSummaryCharacters } = pricedDraft(s, reserve);
		if (lineCost([newest]) > Math.min(Math.floor(0.20 * maxSummaryCharacters), 24000)) continue;
		if (kept.some(r => r.text!.startsWith('read new-large ')) || !kept.some(r => r.text!.startsWith('read old-small '))) continue;
		expect(kept).toEqual([candidatesOf(s)[1]]);
		expect(draft.after).toBeLessThanOrEqual((draft.compaction.details as { carriedTarget: number }).carriedTarget);
		skippedForRoom = true;
		break;
	}
	expect(skippedForRoom).toBe(true);
});

test('only reads before the final cut boundary can be kept, including when spare budget extends the native tail', () => {
	const s = fixture([{ path: 'old' }]), m = s.manager;
	m.appendMessage(answer([{ type: 'toolCall', id: 'tail-read', name: 'read', arguments: { path: 'tail' } }], 'toolUse'));
	m.appendMessage({ role: 'toolResult', toolCallId: 'tail-read', toolName: 'read', isError: false, content: [{ type: 'text', text: 'small tail output' }], timestamp: 0 });
	m.appendMessage(answer([{ type: 'text', text: 'Read the tail.' }]));
	m.appendMessage({ role: 'user', content: 'Continue again.', timestamp: 0 });
	const draft = draftOf(s), { compaction } = draft, branch = m.getBranch(), boundary = branch.findIndex(e => e.id === compaction.firstKeptEntryId);
	const indices = buildGlobalIndexById(m.getEntries()), prefixIndices = new Set(branch.slice(0, boundary).map(e => indices.get(e.id)));
	const kept = keptOf(compaction.summary);
	expect(kept).toHaveLength(2);
	for (const record of kept) expect(prefixIndices.has(record.sourceIndex)).toBe(true);
	const target = (compaction.details as { carriedTarget: number }).carriedTarget;
	expect(draft.after).toBeLessThanOrEqual(target);
});

test('kept reads give way as whole items, newest kept, before output tails and definition maps are spent', () => {
	const s = fixture([
		...Array.from({ length: 4 }, (_, i) => ({ name: 'write', path: `written-${i}.py`, args: { path: `written-${i}.py`, content: 'def written():\n    pass' } })),
		...Array.from({ length: 4 }, (_, i) => ({ path: `read-${i}`, text: `whole output ${i}: ` + 'x'.repeat(80) })),
	], 1000);
	const expected = candidatesOf(s), seen = new Set<number>();
	let tailsGaveWay = false, definitionsGaveWay = false;
	for (let reserve = 119000; reserve < 130500; reserve += 10) {
		const { compaction } = draftOf(s, reserve), records = recordsOf(compaction.summary), kept = keptOf(compaction.summary);
		seen.add(kept.length);
		expect(kept).toEqual(expected.slice(0, kept.length));
		expect(records.filter(r => r.title === 'Actions')).toHaveLength(9);
		expect(records.filter(r => r.title === 'Files')).toHaveLength(9);
		const tails = records.filter(r => r.title === 'Actions' && r.text!.includes('(output tail):')).length;
		const definitions = records.filter(r => r.title === 'Files' && r.text!.includes('(definitions as of #')).length;
		tailsGaveWay ||= kept.length === 4 && tails < 8;
		definitionsGaveWay ||= kept.length === 4 && definitions === 0;
		expect(records.some(r => r.role === 'user' && r.text === 'Inspect the recorded files.')).toBe(true);
		const branch = s.manager.getBranch(), boundary = branch.findIndex(e => e.id === compaction.firstKeptEntryId);
		expect(branch.slice(boundary).some(e => e.id === branch.at(-1)!.id)).toBe(true);
		expect(branch.slice(boundary).some(e => e.type === 'message' && e.message.role === 'toolResult')).toBe(false);
	}
	expect([...seen].sort()).toEqual([0, 1, 2, 3, 4]);
	expect(tailsGaveWay).toBe(true);
	expect(definitionsGaveWay).toBe(true);
});

test('a kept-read file gets no definition map, while other file maps still use spare room', () => {
	const s = fixture([
		{ name: 'write', path: 'written.py', args: { path: 'written.py', content: 'def written():' } },
		{ path: 'read.py', text: 'def read():\n    pass' },
	]);
	const summary = draftOf(s).compaction.summary, records = recordsOf(summary);
	expect(keptOf(summary)).toHaveLength(1);
	expect(records.find(r => r.title === 'Files' && r.text!.startsWith('- read read.py'))!.text).not.toContain('(definitions as of #');
	expect(records.find(r => r.title === 'Files' && r.text!.startsWith('- wrote/edited written.py'))!.text).toContain('(definitions as of #');
});

test('without read candidates the summary is byte-identical to the arm F (41bf248) fixture', () => {
	const s = fixture([{ name: 'write', path: 'out.txt', text: 'written' }]);
	const summary = draftOf(s).compaction.summary;
	expect(keptOf(summary)).toEqual([]);
	expect(createHash('sha256').update(summary).digest('hex')).toBe('209ac35348e109e3d57a84d1b844e78d89a1528ca4a82ea0fa83faebe9c61ce4');
});

test('native omission of a kept result removes its own record and preserves the other kept read', () => {
	const s = fixture([{ path: 'a' }, { path: 'b' }]), draft = draftOf(s);
	s.manager.appendCompaction(draft.compaction.summary, draft.compaction.firstKeptEntryId, draft.compaction.tokensBefore, draft.compaction.details, true);
	s.manager.appendContextEdit(s.results[0]!, null);
	const summary = projectedMessages(s.manager.buildSessionProjection().messages, s.ctx).find(m => m.role === 'compactionSummary');
	if (summary?.role !== 'compactionSummary') throw new Error('Missing summary');
	expect(keptOf(summary.summary)).toEqual(keptOf(draft.compaction.summary).filter(r => r.text!.startsWith('read b ')));
});

test('native omission before drafting excludes a read result', () => {
	const s = fixture([{ path: 'a' }]);
	s.manager.appendContextEdit(s.results[0]!, null);
	expect(keptOf(draftOf(s).compaction.summary)).toEqual([]);
});

test('drafting twice from the same entries gives identical summaries and never changes tool outputs', () => {
	const s = fixture([{ path: 'a', text: 'line\nback\\slash' }, { path: 'b' }]);
	const before = JSON.stringify(s.manager.getEntries());
	expect(draftOf(s).compaction.summary).toBe(draftOf(s).compaction.summary);
	expect(JSON.stringify(s.manager.getEntries())).toBe(before);
});
