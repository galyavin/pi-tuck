import { expect, test } from 'vitest';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { tuck, tuckRecall } from '../src/tuck';
import { normalize } from '../src/tuck/core/normalize';
import { blockRecords, isDialogue } from '../src/tuck/core/brief';
import type { CompilerMessage } from '../src/tuck/types';

// An omission left by a clip says how to read the omitted passage: tuck_recall by the source's index (or its entry id), and from the
// passage's offset only where that offset means the same in the source as in the clipped block. Every hint is followed here.
const sentence = (k: number, end = '. ') => Array.from({ length: 9 }, (_, i) => `W${k}x${i}`).join(' ') + end;
const prose = (n: number, seed = 0, end = '. ') => Array.from({ length: n }, (_, i) => sentence(seed + i, end)).join('').trimEnd();
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const answer = (content: unknown) => ({ role: 'assistant', content, api: 'openai-completions', provider: 'probe', model: 'probe', usage, stopReason: 'stop', timestamp: 1 }) as never;

test('a clip names the way to read what it omits, and tuck_recall returns that passage', () => {
	const m = SessionManager.inMemory('/hint');
	const ids = [
		m.appendMessage({ role: 'user', content: prose(30), timestamp: 1 }),
		m.appendMessage({ role: 'user', content: prose(30, 100, '.\r\n'), timestamp: 1 }),
		m.appendMessage(answer([{ type: 'text', text: prose(30, 200) }, { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a.ts' } }, { type: 'text', text: prose(30, 300) }])),
		m.appendMessage({ role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 1 }),
		m.appendMessage(answer([{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: prose(30, 400) }])),
		m.appendMessage(answer([{ type: 'text', text: prose(30, 500) }])),
		m.appendCustomMessageEntry('host.note', prose(30, 600), true),
		m.appendCustomMessageEntry('host.note', prose(30, 700), true),
	];
	const entries = m.getEntries(), indices = tuck.buildGlobalIndexById(entries);
	const messages: CompilerMessage[] = entries.map(entry => entry.type === 'message' ? entry.message : entry.type === 'custom_message' ?
		{ role: 'custom', customType: entry.customType, content: entry.content, display: entry.display, timestamp: 1 } : undefined as never) as never;
	// A custom message has no numeric index: its notice is read by entry id.
	const sourceIndices = ids.map(id => indices.get(id));
	const blocks = normalize(messages, sourceIndices, undefined, ids).filter(isDialogue);
	const kinds = new Set<string>();
	for (const block of blocks) for (const clip of [[256, 0], [64, 0], [24, 0], [80, 120], [16, 0]] as const) {
		for (const record of blockRecords(block, undefined, clip)) {
			if (record.kind !== 'omission') continue;
			const hint = /^tuck_recall (\{.*\})$/.exec(record.reason)?.[1];
			expect(hint, record.reason).toBeDefined();
			const args = JSON.parse(hint!) as { index?: number; entryId?: string; offset?: number };
			expect(args.index !== undefined || args.entryId !== undefined).toBe(true);
			const read = tuckRecall(tuck, entries, m.getBranch(), args as never) as { status: string; entries: { text: string }[] };
			expect(read.status, record.reason).toBe('ok');
			const omitted = block.text.slice(record.span!.start, record.span!.start + 40);
			if (args.offset !== undefined) {
				// The offset is the passage's own: the read begins where the omission does.
				expect(args.offset).toBe(record.span!.start);
				expect(read.entries[0]!.text.startsWith(omitted), record.reason).toBe(true);
				kinds.add(args.index !== undefined ? 'index and offset' : 'entry id and offset');
			} else {
				// Without an offset the source is read from its start, and it holds the passage.
				expect(read.entries[0]!.text.includes(omitted), record.reason).toBe(true);
				kinds.add(args.index !== undefined ? 'index' : 'entry id');
			}
		}
	}
	// Followed: offsets where the block begins the source's text and sanitizing left it alone (a plain user text, the first text of an
	// assistant message even after hidden reasoning, a note); none after a tool call or where CRLF became LF.
	expect([...kinds].sort()).toEqual(['entry id and offset', 'index', 'index and offset']);
	const offsetOf = (id: string) => blocks.filter(b => b.kind === 'notice' ? b.sourceEntryId === id : b.sourceIndex === indices.get(id)).flatMap(b => blockRecords(b, undefined, [16, 0])).filter(r => r.kind === 'omission').map(r => /offset/.test(r.reason!));
	expect(offsetOf(ids[0]!)).toEqual([true]);
	expect(offsetOf(ids[1]!)).toEqual([false]);
	expect(offsetOf(ids[2]!)).toEqual([true, false]);
	expect(offsetOf(ids[4]!)).toEqual([true]);
	expect(offsetOf(ids[5]!)).toEqual([true]);
	expect(offsetOf(ids[6]!)).toEqual([true]);
});

test('a clipped block with no locator says so', () => {
	const text = prose(30);
	const [block] = normalize([{ role: 'user', content: text, timestamp: 1 }], [undefined]).filter(isDialogue);
	const omission = blockRecords(block!, undefined, [16, 0]).find(r => r.kind === 'omission')!;
	expect(omission.kind === 'omission' && omission.reason).toBe('source has no locator to read it by');
});
