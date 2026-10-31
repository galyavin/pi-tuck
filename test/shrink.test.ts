import { test, expect } from 'vitest';
import { shrinkDialogue, wholeDialogue, type DialogueInput, type Step } from '../src/tuck/core/shrink';
import type { DialogueBlock } from '../src/tuck/core/brief';
import { DIALOGUE_SUFFIX } from '../src/tuck/core/format';
import { parseRecords, serializeRecord, serializeRecords, splitSummary, TRANSCRIPT_HEADER, type TranscriptRecord } from '../src/tuck/core/transcript';
import type { NormalizedBlock } from '../src/tuck/types';
import { session } from './random-sessions';

// The ladder on normalized blocks. Prose is built from capitalized sentences of nine words each: a sentence is the unit a clip keeps or
// omits, and the sentence segmenter only breaks before a capital letter.
const sentence = (seed: number, words = 9) => Array.from({ length: words }, (_, i) => `W${seed}x${i}`).join(' ') + '.';
const prose = (seed: number, sentences: number) => Array.from({ length: sentences }, (_, i) => sentence(seed * 100 + i)).join(' ');

interface Shape { turns: number; user: number; assistant: number; notices?: number; times?: boolean }
/** Each turn: a user prompt, an assistant text and a tool call (omitted from the dialogue, so the tool notice is present). Sources number the blocks. */
function dialogue({ turns, user, assistant, notices = 0, times = false }: Shape) {
	const blocks: NormalizedBlock[] = [];
	const sourceTimes = times ? Object.fromEntries(Array.from({ length: turns * (3 + notices) }, (_, i) => [i, { basis: 'message' as const, utc: new Date(1_700_000_000_000 + i * 60_000).toISOString().replace('.000Z', 'Z') }])) : undefined;
	const add = (block: NormalizedBlock) => blocks.push({ ...block, sourceIndex: blocks.length, ...(sourceTimes ? { sourceTimes } : {}) });
	for (let t = 0; t < turns; t++) {
		const prompt = prose(t, user), reply = prose(500 + t, assistant);
		add({ kind: 'user', text: prompt, originalText: prompt });
		for (let n = 0; n < notices; n++) { const note = prose(900 + t * 10 + n, 30); add({ kind: 'notice', text: note, originalText: note, sourceEntryId: `note-${t}-${n}` }); }
		add({ kind: 'assistant', text: reply, originalText: reply });
		add({ kind: 'tool_call', name: 'read', args: { path: `f${t}` } });
	}
	const input: DialogueInput = { blocks, sourceIndices: blocks.map(b => b.sourceIndex) };
	return { blocks, input, whole: wholeDialogue(input) };
}

const recordsOf = (text: string): TranscriptRecord[] => parseRecords(splitSummary(text)!.body);
const textBlocks = (blocks: NormalizedBlock[], kind: DialogueBlock['kind']): DialogueBlock[] => blocks.filter((b): b is DialogueBlock => b.kind === kind);
/** The characters of excerpt text each source keeps, by source index; a source with none is absent. */
const kept = (records: TranscriptRecord[], role: string) => {
	const by = new Map<number, number>();
	for (const r of records) if (r.kind === 'excerpt' && r.role === role) by.set(r.sourceIndex!, (by.get(r.sourceIndex!) ?? 0) + r.text.length);
	return by;
};
const omission = (records: TranscriptRecord[], role: string) => records.find(r => r.kind === 'omission' && r.role === role && r.count !== undefined);
const rank = (step: Step) => ['whole', 'A1', 'A2', 'A3', 'B', 'C1', 'C2', 'C3', 'D', 'E1', 'E2', 'none'].indexOf(step);
const sweep = (whole: number, floor: number, count: number) => Array.from({ length: count }, (_, i) => Math.floor(whole * (floor + (1 - floor) * (1 - i / (count - 1)))) );

const S = dialogue({ turns: 30, user: 3, assistant: 30 });

test('a dialogue that fits comes back whole, as compileDialogue renders it', () => {
	const r = shrinkDialogue(S.input, S.whole.length);
	expect(r.step).toBe('whole');
	expect(r.text).toBe(S.whole);
	expect(r.size).toBe(S.whole.length);
	expect(shrinkDialogue(S.input, S.whole.length - 1).step).not.toBe('whole');
});

test('every prompt stays whole while only assistant text is clipped or dropped', () => {
	const prompts = textBlocks(S.blocks, 'user'), steps = new Set<Step>();
	for (const limit of sweep(S.whole.length, 0.15, 40)) {
		const r = shrinkDialogue(S.input, limit);
		if (!['A1', 'A2', 'A3', 'B'].includes(r.step)) continue;
		steps.add(r.step);
		const users = recordsOf(r.text).filter(x => x.role === 'user' && x.kind !== 'omission');
		expect(users.map(x => [x.sourceIndex, x.text, x.span]), `limit ${limit} ${r.step}`).toEqual(prompts.map(p => [p.sourceIndex, p.originalText, undefined]));
	}
	// The sweep passed through every tier and through dropping.
	expect([...steps].sort()).toEqual(['A1', 'A2', 'A3', 'B']);
});

test('age grades the clipping: older assistant text is never longer than newer, the newest is whole in step A, and the oldest is clipped or dropped', () => {
	const replies = textBlocks(S.blocks, 'assistant');
	for (const fraction of [0.97, 0.7, 0.45, 0.25, 0.15]) {
		const r = shrinkDialogue(S.input, Math.floor(S.whole.length * fraction));
		expect(['A1', 'A2', 'A3', 'B', 'C1', 'C2', 'C3', 'D'], `${fraction}: ${r.step}`).toContain(r.step);
		const records = kept(recordsOf(r.text), 'assistant');
		const retained = replies.map(b => records.get(b.sourceIndex!) ?? 0);
		for (let i = 1; i < retained.length; i++) expect(retained[i]!, `${fraction} ${r.step} #${i}`).toBeGreaterThanOrEqual(retained[i - 1]!);
		if (r.step.startsWith('A')) expect(retained.at(-1), `${fraction} newest`).toBe(replies.at(-1)!.originalText!.length);
		expect(retained[0]!, `${fraction} oldest`).toBeLessThan(replies[0]!.originalText!.length);
	}
	// In step A the older units share one tier and the newest k are whole: two lengths only, the whole text and the tier's.
	const a = shrinkDialogue(S.input, Math.floor(S.whole.length * 0.7));
	expect(a.step.startsWith('A')).toBe(true);
	const lengths = new Set(replies.map(b => kept(recordsOf(a.text), 'assistant').get(b.sourceIndex!)));
	expect(lengths.size).toBe(2);
});

test('a clip that would not make a unit smaller is not taken', () => {
	const blocks: NormalizedBlock[] = [
		{ kind: 'user', text: 'Short prompt.', originalText: 'Short prompt.', sourceIndex: 0 },
		{ kind: 'assistant', text: 'Short answer.', originalText: 'Short answer.', sourceIndex: 1 },
		...Array.from({ length: 12 }, (_, i): NormalizedBlock => ({ kind: 'assistant', text: prose(i, 30), originalText: prose(i, 30), sourceIndex: 2 + i })),
	];
	const input = { blocks, sourceIndices: blocks.map(b => b.sourceIndex) };
	const r = shrinkDialogue(input, Math.floor(wholeDialogue(input).length * 0.3));
	expect(r.step).toBe('A3');
	const short = recordsOf(r.text).find(x => x.sourceIndex === 1)!;
	expect(short).toEqual({ kind: 'excerpt', role: 'assistant', sourceIndex: 1, text: 'Short answer.' });
});

test('every record of every view round-trips, and every clipped excerpt keeps its source and a span that reads that text back', () => {
	const sources = new Map<number, string>(S.blocks.flatMap(b => 'text' in b && b.sourceIndex !== undefined ? [[b.sourceIndex, b.text] as const] : []));
	let clipped = 0;
	for (const limit of sweep(S.whole.length, 0.01, 60)) {
		const r = shrinkDialogue(S.input, limit);
		if (!r.text) continue;
		const records = recordsOf(r.text);
		expect(parseRecords(serializeRecords(records)), `limit ${limit} ${r.step}`).toEqual(records);
		for (const x of records) {
			if (!x.span) continue;
			expect(x.sourceIndex, `${r.step}: ${JSON.stringify(x).slice(0, 120)}`).toBeTypeOf('number');
			const text = sources.get(x.sourceIndex!)!;
			expect(x.span.coordinateSpace).toBe('sanitized-block');
			expect(x.span.totalCharacters).toBe(text.length);
			expect(x.span.end).toBeLessThanOrEqual(text.length);
			if (x.kind === 'excerpt') { clipped++; expect(text.slice(x.span.start, x.span.end)).toBe(x.text); }
			else expect(x.reason).toBe(`tuck_recall {"index":${x.sourceIndex}}`);
		}
	}
	expect(clipped).toBeGreaterThan(100);
});

test('the summary text is never longer than the allowance, and is as long as the ladder computed', () => {
	for (const shape of [S, dialogue({ turns: 25, user: 40, assistant: 10 }), dialogue({ turns: 6, user: 2, assistant: 12, notices: 3 }), dialogue({ turns: 20, user: 3, assistant: 30, times: true })]) {
		let previous: { size: number; step: Step } | undefined;
		for (const limit of [0, 1, 700, ...sweep(shrinkDialogue(shape.input, Infinity).size, 0.001, 80).reverse()]) {
			const r = shrinkDialogue(shape.input, limit);
			expect(r.text.length, `limit ${limit} ${r.step}`).toBeLessThanOrEqual(limit);
			expect(r.text.length, `limit ${limit} ${r.step}`).toBe(r.size);
			if (r.text) { expect(r.text.startsWith(TRANSCRIPT_HEADER + '\n')).toBe(true); expect(r.text.endsWith(DIALOGUE_SUFFIX)).toBe(true); }
			// The ladder's configurations do not depend on the allowance up to step B, so the first that fits is a later one for a smaller allowance.
			if (previous && rank(r.step) <= rank('B') && rank(previous.step) <= rank('B')) {
				expect(rank(r.step), `limit ${limit}`).toBeLessThanOrEqual(rank(previous.step));
				expect(r.size, `limit ${limit}`).toBeGreaterThanOrEqual(previous.size);
			}
			previous = r;
		}
	}
});

test('dropped assistant units are counted in one omission, with the first eight locators of the oldest', () => {
	const r = shrinkDialogue(S.input, 10000);
	expect(r.step).toBe('B');
	const records = recordsOf(r.text), replies = textBlocks(S.blocks, 'assistant');
	const shown = kept(records, 'assistant'), dropped = replies.filter(b => !shown.has(b.sourceIndex!));
	const note = omission(records, 'assistant')!;
	expect(dropped.length).toBeGreaterThan(8);
	// The dropped are the oldest, and the notice counts them and names the first eight.
	expect(dropped.map(b => b.sourceIndex)).toEqual(replies.slice(0, dropped.length).map(b => b.sourceIndex));
	expect(note.count).toBe(dropped.length);
	expect(note.sourceIndices).toEqual(dropped.slice(0, 8).map(b => b.sourceIndex));
	expect(note.reason).toContain('Locator list incomplete');
	expect(note.reason).toContain('tuck_recall');
	expect(omission(records, 'user')).toBeUndefined();
	// One notice per role, after every other record, and the tool notice last.
	expect(records.filter(x => x.kind === 'omission' && x.count !== undefined)).toHaveLength(1);
	expect(records.at(-1)).toEqual({ kind: 'omission', reason: 'Historical tool actions and observations omitted; read original sources with tuck_recall' });
	expect(records.indexOf(note)).toBe(records.length - 2);
});

test('dropped prompts are counted the same way, oldest first, after the assistant text is gone', () => {
	const r = shrinkDialogue(S.input, 4000);
	expect(r.step).toBe('D');
	const records = recordsOf(r.text), prompts = textBlocks(S.blocks, 'user');
	const shown = kept(records, 'user'), dropped = prompts.filter(b => !shown.has(b.sourceIndex!));
	expect(dropped.length).toBeGreaterThan(0);
	expect(dropped.map(b => b.sourceIndex)).toEqual(prompts.slice(0, dropped.length).map(b => b.sourceIndex));
	const note = omission(records, 'user')!;
	expect(note.count).toBe(dropped.length);
	expect(note.sourceIndices).toEqual(dropped.slice(0, 8).map(b => b.sourceIndex));
	// The newest prompts stay whole; the assistant text left is the newest that fit a third of the allowance.
	for (const x of records.filter(y => y.role === 'user' && y.kind === 'excerpt')) expect(x.span).toBeUndefined();
	const assistant = textBlocks(S.blocks, 'assistant'), replies = kept(records, 'assistant');
	expect(omission(records, 'assistant')!.count).toBe(assistant.length - replies.size);
	// Those are the newest units, and they fill at most a third of the allowance: one more would not fit it.
	expect([...replies.keys()]).toEqual(assistant.slice(assistant.length - replies.size).map(b => b.sourceIndex));
	const third = records.filter(x => x.role === 'assistant' && x.count === undefined).reduce((n, x) => n + serializeRecord(x).length + 1, 0);
	expect(third).toBeLessThanOrEqual(4000 / 3);
	expect(third + third / replies.size).toBeGreaterThan(4000 / 3);
	// The order of the records: user notice, assistant notice, tool notice.
	expect(records.slice(-3).map(x => x.role ?? 'tools')).toEqual(['user', 'assistant', 'tools']);
});

test('long prompts are clipped oldest first, tier by tier, before any prompt is dropped', () => {
	const L = dialogue({ turns: 25, user: 40, assistant: 10 });
	const steps = new Set<Step>();
	for (const limit of sweep(L.whole.length, 0.1, 40)) {
		const r = shrinkDialogue(L.input, limit);
		steps.add(r.step);
		if (!r.step.startsWith('C')) continue;
		const prompts = textBlocks(L.blocks, 'user'), records = recordsOf(r.text), shown = kept(records, 'user');
		expect(shown.size, `${limit} ${r.step}`).toBe(prompts.length);
		const retained = prompts.map(b => shown.get(b.sourceIndex!)!);
		// The oldest u are clipped to one tier; the rest are whole.
		const clippedCount = retained.filter((n, i) => n < prompts[i]!.originalText!.length).length;
		expect(retained.slice(0, clippedCount).every((n, i) => n < prompts[i]!.originalText!.length), `${limit} ${r.step}`).toBe(true);
		expect(retained.slice(clippedCount).every((n, i) => n === prompts[clippedCount + i]!.originalText!.length), `${limit} ${r.step}`).toBe(true);
	}
	expect([...steps].filter(s => s.startsWith('C')).length).toBeGreaterThanOrEqual(2);
});

test('notices are clipped to one tier once the dialogue shrinks, and dropped oldest first, uncounted, after the prompts', () => {
	const N = dialogue({ turns: 2, user: 2, assistant: 5, notices: 10 });
	const whole = recordsOf(N.whole).filter(x => x.role === 'custom');
	expect(whole).toHaveLength(20);
	expect(whole.every(x => x.sourceEntryId !== undefined && x.span === undefined)).toBe(true);
	const steps = new Set<Step>();
	for (const limit of sweep(N.whole.length, 0.05, 40)) {
		const r = shrinkDialogue(N.input, limit);
		steps.add(r.step);
		const notes = recordsOf(r.text).filter(x => x.role === 'custom');
		if (r.step === 'whole') continue;
		// Clipped notices keep their entry identity on the excerpt and the omission, and their span.
		expect(notes.every(x => x.sourceEntryId !== undefined && x.span !== undefined)).toBe(true);
		if (r.step === 'E1') {
			const present = [...new Set(notes.map(x => x.sourceEntryId))];
			const all = whole.map(x => x.sourceEntryId!);
			expect(present).toEqual(all.slice(all.length - present.length));
			expect(present.length).toBeLessThan(all.length);
			expect(notes.every(x => x.count === undefined)).toBe(true);
		}
	}
	expect(steps.has('E1')).toBe(true);
});

test('the smallest allowances keep a notice or two, then nothing: "" when not even the omission notices fit', () => {
	const none = shrinkDialogue(S.input, 100);
	expect(none).toEqual({ text: '', step: 'none', size: 0 });
	for (const limit of [0, 1, TRANSCRIPT_HEADER.length + DIALOGUE_SUFFIX.length]) expect(shrinkDialogue(S.input, limit).text).toBe('');
	// The least summary is the three omission notices alone.
	let least: ReturnType<typeof shrinkDialogue> | undefined;
	for (let limit = 800; limit < 3000 && !least?.text; limit += 5) least = shrinkDialogue(S.input, limit);
	expect(least!.text.length).toBeLessThanOrEqual(3000);
	const records = recordsOf(least!.text);
	expect(records.filter(x => x.kind === 'excerpt')).toEqual([]);
	expect(records.map(x => x.role ?? 'tools')).toEqual(['user', 'assistant', 'tools']);
	expect(records.map(x => x.count)).toEqual([30, 30, undefined]);
	expect(shrinkDialogue(S.input, least!.text.length - 1).text).toBe('');
});

test('a mandatory source renders as nothing and is not counted as omitted; a dropped unit with no locator is counted, and the notice says so', () => {
	const unit = (kind: 'user' | 'assistant', seed: number, sourceIndex?: number): NormalizedBlock =>
		({ kind, text: prose(seed, kind === 'user' ? 3 : 30), originalText: prose(seed, kind === 'user' ? 3 : 30), ...(sourceIndex !== undefined ? { sourceIndex } : {}) });
	const blocks = [unit('user', 1, 0), unit('assistant', 2, 1), unit('user', 3), unit('assistant', 4, 3), unit('user', 5, 4), unit('assistant', 6, 5)];
	const input: DialogueInput = { blocks, mandatorySourceIndices: new Set([0, 3]), sourceIndices: blocks.map(b => b.sourceIndex) };
	const whole = wholeDialogue(input);
	// The unlocated prompt sorts after every located record.
	expect(recordsOf(whole).map(x => x.sourceIndex)).toEqual([1, 4, 5, undefined]);
	for (const limit of sweep(whole.length, 0.02, 30)) {
		const r = shrinkDialogue(input, limit);
		expect(recordsOf(r.text || whole).some(x => x.sourceIndex === 0 || x.sourceIndex === 3), `${limit} ${r.step}`).toBe(false);
	}
	// The least summary drops every unit: the mandatory ones are not counted, the unlocated prompt is, with no locator.
	let least = shrinkDialogue(input, 0);
	for (let limit = 500; !least.text && limit < 4000; limit += 5) least = shrinkDialogue(input, limit);
	const records = recordsOf(least.text);
	expect(records.map(x => [x.role, x.count])).toEqual([['user', 2], ['assistant', 2]]);
	expect(omission(records, 'user')!.sourceIndices).toEqual([4]);
	expect(omission(records, 'user')!.reason).toContain('Some text blocks have no source locator');
	expect(omission(records, 'assistant')!.sourceIndices).toEqual([1, 5]);
	expect(omission(records, 'assistant')!.reason).not.toContain('no source locator');
});

test('source times: clipped prompts and the prompt notice carry the time of each locator they name, and only prompts are timed', () => {
	const T = dialogue({ turns: 20, user: 40, assistant: 10, times: true });
	let seen = 0;
	for (const limit of sweep(T.whole.length, 0.03, 40)) {
		const r = shrinkDialogue(T.input, limit);
		if (!r.text) continue;
		for (const x of recordsOf(r.text)) {
			if (x.role === 'user') {
				const indices = x.sourceIndices ?? (x.sourceIndex === undefined ? [] : [x.sourceIndex]);
				expect(x.sourceTimes?.map(t => t.sourceIndex), `${limit} ${r.step}`).toEqual(indices);
				if (x.kind === 'omission' || x.span) seen++;
			} else expect(x.sourceTimes).toBeUndefined();
		}
	}
	expect(seen).toBeGreaterThan(20);
});

test('random sessions: every step renders exactly the length it computed, within the allowance, as valid records with readable spans', () => {
	const steps = new Set<Step>();
	let checked = 0;
	for (let seed = 1; seed <= 150; seed++) {
		const { blocks, mandatory, sourceIndices, sourceEntryIds } = session(seed);
		const input: DialogueInput = { blocks, mandatorySourceIndices: seed % 3 ? mandatory : undefined, sourceIndices, sourceEntryIds };
		const whole = wholeDialogue(input);
		const texts = new Map<string, string[]>();
		for (const b of blocks) if ('text' in b && b.kind !== 'tool_result') {
			const key = `${b.kind === 'notice' ? 'custom' : b.kind}:${b.sourceIndex}`;
			texts.set(key, [...(texts.get(key) ?? []), b.text]);
		}
		for (const limit of [Infinity, whole.length, ...[0.9, 0.7, 0.5, 0.3, 0.15, 0.08, 0.03].map(f => Math.floor(whole.length * f)), 1500, 700, 100]) {
			const r = shrinkDialogue(input, limit);
			steps.add(r.step);
			expect(r.text.length, `seed ${seed} limit ${limit} ${r.step}`).toBeLessThanOrEqual(limit);
			expect(r.text.length, `seed ${seed} limit ${limit} ${r.step}`).toBe(r.size);
			if (limit >= whole.length) { expect(r.text).toBe(whole); continue; }
			if (!r.text) continue;
			const records = recordsOf(r.text);
			expect(parseRecords(serializeRecords(records)), `seed ${seed} ${r.step}`).toEqual(records);
			for (const x of records) {
				if (!x.span) continue;
				if (x.sourceIndex === undefined) continue; // a block without a locator has none to keep
				const candidates = texts.get(`${x.role}:${x.sourceIndex}`) ?? [];
				expect(candidates.some(text => text.length === x.span!.totalCharacters && (x.kind === 'omission' || text.slice(x.span!.start, x.span!.end) === x.text)), `seed ${seed} ${r.step}`).toBe(true);
			}
			checked++;
		}
	}
	expect(checked).toBeGreaterThan(500);
	expect([...steps]).toEqual(expect.arrayContaining(['whole', 'A1', 'C1', 'D', 'none']));
});

test('a clip that keeps no text renders nothing: its unit joins the one omission notice instead of carrying a notice of its own', () => {
	// Each assistant text is one long sentence: no clip tier can keep any of it whole.
	const blocks: NormalizedBlock[] = [];
	const add = (block: NormalizedBlock) => blocks.push({ ...block, sourceIndex: blocks.length });
	for (let t = 0; t < 40; t++) {
		const prompt = prose(t, 2), reply = sentence(700 + t, 400);
		add({ kind: 'user', text: prompt, originalText: prompt });
		add({ kind: 'assistant', text: reply, originalText: reply });
	}
	const input: DialogueInput = { blocks, sourceIndices: blocks.map(b => b.sourceIndex) };
	const whole = wholeDialogue(input).length;
	for (const limit of sweep(whole, 0.15, 12)) {
		const shrunk = shrinkDialogue(input, limit);
		if (!shrunk.text) continue;
		expect(shrunk.text.length).toBeLessThanOrEqual(limit);
		const records = recordsOf(shrunk.text);
		// No source is represented by a span notice alone.
		const sources = new Map<number, string[]>();
		for (const r of records) if (r.sourceIndex !== undefined && (r.kind === 'excerpt' || r.kind === 'omission')) sources.set(r.sourceIndex, [...(sources.get(r.sourceIndex) ?? []), r.kind]);
		for (const [source, kinds] of sources) expect(kinds, `source ${source} at ${limit}`).toContain('excerpt');
		// Every assistant text that is not whole is counted in the assistant omission.
		const whole_ = kept(records, 'assistant').size;
		expect(whole_ + (omission(records, 'assistant')?.count ?? 0), `limit ${limit}`).toBe(40);
		// Users are never sacrificed while assistant text could still go.
		if (whole_ === 0 && rank(shrunk.step) <= rank('B')) expect(kept(records, 'user').size).toBe(40);
	}
});

test('when prompts alone would fill the allowance, the newest assistant text within a third of it is kept', () => {
	// Prompts that fit only if every assistant text goes: B may drop older assistant text, but the newest third stays and users give way.
	const many = dialogue({ turns: 60, user: 12, assistant: 6 });
	const usersOnly = recordsOf(many.whole).filter(r => r.kind === 'excerpt' && r.role === 'user').reduce((n, r) => n + serializeRecord(r).length + 1, 0);
	for (const limit of [Math.floor(usersOnly * 1.05), Math.floor(usersOnly * 0.9), Math.floor(usersOnly * 0.6)]) {
		const shrunk = shrinkDialogue(many.input, limit);
		expect(rank(shrunk.step), `limit ${limit}`).toBeGreaterThanOrEqual(rank('C1'));
		const records = recordsOf(shrunk.text);
		const assistant = [...kept(records, 'assistant').keys()];
		expect(assistant.length, `limit ${limit}`).toBeGreaterThan(0);
		// They are the newest: every assistant source kept is later than every assistant source omitted.
		const all = textBlocks(many.blocks, 'assistant').map(b => b.sourceIndex!);
		const omitted = all.filter(s => !assistant.includes(s));
		expect(Math.min(...assistant), `limit ${limit}`).toBeGreaterThan(Math.max(...omitted));
	}
});

test('the recent assistant third holds text even when every assistant message is one long sentence that a clip empties', () => {
	const blocks: NormalizedBlock[] = [];
	const add = (block: NormalizedBlock) => blocks.push({ ...block, sourceIndex: blocks.length });
	for (let t = 0; t < 50; t++) {
		const prompt = prose(t, 12), reply = sentence(800 + t, 80 + (t * 37) % 121);
		add({ kind: 'user', text: prompt, originalText: prompt });
		add({ kind: 'assistant', text: reply, originalText: reply });
	}
	const input: DialogueInput = { blocks, sourceIndices: blocks.map(b => b.sourceIndex) };
	const records = recordsOf(wholeDialogue(input));
	const cost = (r: TranscriptRecord) => serializeRecord(r).length + 1;
	const usersOnly = records.filter(r => r.kind === 'excerpt' && r.role === 'user').reduce((n, r) => n + cost(r), 0);
	const replies = records.filter(r => r.kind === 'excerpt' && r.role === 'assistant');
	const total = replies.reduce((n, r) => n + (r.text ?? "").length, 0), longest = Math.max(...replies.map(cost));
	// Prompts alone exceed each allowance, so users give way and the newest assistant third is reserved first.
	for (const limit of [Math.floor(usersOnly * 0.95), Math.floor(usersOnly * 0.8), Math.floor(usersOnly * 0.5)]) {
		const shrunk = shrinkDialogue(input, limit);
		const assistant = [...kept(recordsOf(shrunk.text), 'assistant').values()].reduce((n, c) => n + c, 0);
		expect(assistant, `limit ${limit} ${shrunk.step}`).toBeGreaterThanOrEqual(Math.min(limit / 3 - 2 * longest, total));
		expect(assistant, `limit ${limit} ${shrunk.step}`).toBeGreaterThan(0);
	}
});
