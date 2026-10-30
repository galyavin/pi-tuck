// Summaries saved before the rename to pi-tuck (header VCC-TRANSCRIPT/1) are read as this format: their records byte for byte, since an
// excerpt's length is checked against its span, and their closing pointed at the tools the model has now.
import { expect, test } from 'vitest';
import { LEGACY_TRANSCRIPT_HEADER, parseRecords, serializeRecords, splitSummary, type TranscriptRecord } from '../src/tuck/core/transcript';
import { isLookupTool, isRecallTool } from '../src/tuck/core/recall-operation';

test('a legacy summary whose excerpt names vcc_recall still parses, and its closing names the current tools', () => {
	const text = 'I will look it up with vcc_recall first.';
	const records: TranscriptRecord[] = [{ kind: 'excerpt', role: 'assistant', sourceIndex: 3, text,
		span: { coordinateSpace: 'sanitized-block', start: 0, end: text.length, totalCharacters: text.length } }];
	const legacy = `${LEGACY_TRANSCRIPT_HEADER}\n${serializeRecords(records)}\n\n---\n\nUse vcc_recall or vcc_search for anything else.`;
	const split = splitSummary(legacy)!;
	expect(parseRecords(split.body)).toEqual(records);
	expect(split.closing).toBe('\n\n---\n\nUse tuck_recall or tuck_search for anything else.');
});

test('old tool calls in history are recognized under both names', () => {
	for (const name of ['tuck_recall', 'vcc_recall']) expect(isRecallTool(name)).toBe(true);
	for (const name of ['tuck_search', 'vcc_search', 'tuck_recall', 'vcc_recall']) expect(isLookupTool(name)).toBe(true);
	expect(isLookupTool('read')).toBe(false);
});
