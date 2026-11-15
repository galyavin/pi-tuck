// Summaries saved before the rename to pi-tuck (header VCC-TRANSCRIPT/1) are read as this format: their records byte for byte, since an
// excerpt's length is checked against its span, and their closing pointed at the tools the model has now.
import { expect, test } from 'vitest';
import { LEGACY_TRANSCRIPT_HEADER, parseRecords, serializeRecords, splitSummary, type TranscriptRecord } from '../src/tuck/core/transcript';
import { isLookupTool, isRecallTool } from '../src/tuck/core/recall-operation';
import { SessionManager, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { projectedMessages } from '../src/omissions';

test('a legacy summary whose excerpt names vcc_recall still parses, and its closing names the current tools', () => {
	const text = 'I will look it up with vcc_recall first.';
	const records: TranscriptRecord[] = [{ kind: 'excerpt', role: 'assistant', sourceIndex: 3, text,
		span: { coordinateSpace: 'sanitized-block', start: 0, end: text.length, totalCharacters: text.length } }];
	const legacy = `${LEGACY_TRANSCRIPT_HEADER}\n${serializeRecords(records)}\n\n---\n\nUse vcc_recall or vcc_search for anything else.`;
	const split = splitSummary(legacy)!;
	expect(parseRecords(split.body)).toEqual(records);
	expect(split.closing).toBe('\n\n---\n\nUse tuck_recall for anything else.');
});

test('old tool calls in history are recognized under both names', () => {
	for (const name of ['tuck_recall', 'vcc_recall']) expect(isRecallTool(name)).toBe(true);
	for (const name of ['tuck_search', 'vcc_search', 'tuck_recall', 'vcc_recall']) expect(isLookupTool(name)).toBe(true);
	expect(isLookupTool('read')).toBe(false);
});

for (const header of ['VCC-TRANSCRIPT/1', 'TUCK-TRANSCRIPT/1', 'TUCK-TRANSCRIPT/2'])
test(`${header}: saved closing instructions use the available recall tool without changing source quotes or the saved entry`, () => {
	const manager = SessionManager.inMemory('/virtual/old-summary');
	const text = 'Earlier I called tuck_search.';
	const body = header.endsWith('/1') ? JSON.stringify({ kind: 'excerpt', role: 'assistant', text }) : `assistant: ${text}`;
	const oldTool = header.startsWith('VCC') ? 'vcc_search' : 'tuck_search';
	const summary = `${header}\n${body}\n\n---\n\nUse ${oldTool} for anything else.`;
	manager.appendCompaction(summary, '', 10, { compactor: 'pi-tuck' }, true);
	const messages = projectedMessages(manager.buildSessionProjection().messages, { cwd: '/virtual/old-summary', sessionManager: manager } as unknown as ExtensionContext);
	const projected = messages.find(message => message.role === 'compactionSummary');
	expect(projected).toHaveProperty('summary', `${header}\n${body}\n\n---\n\nUse tuck_recall for anything else.`);
	expect(manager.getBranch().at(-1)).toHaveProperty('summary', summary);
});
