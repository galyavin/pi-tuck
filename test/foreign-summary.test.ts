import { test, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { harness, scenario } from './budget-fixture';
import { conversationTokens } from '../src/budget';
import { measurableMessages, projectedMessages } from '../src/omissions';
import { TRANSCRIPT_HEADER, serializeTranscript, type TranscriptRecord } from '../src/pi-tuck/core/transcript';
import { SUMMARY_SUFFIX } from '../src/pi-tuck/core/format';

// A session whose saved projection holds a summary in another format (a Pi default summary) cannot run a request: the context hook
// and the triggers filter summaries and refuse one they cannot read. An operator's /compact is the way out: it compiles from the original
// sources and replaces the foreign summary. The planner therefore counts the conversation without failing on a summary it cannot filter.
test('an operator /compact repairs a session whose saved summary is foreign', async () => {
	const h = await harness({ at: 'prompt', complete: 60000, host: 6000, summary: true, foreign: true });
	try {
		expect(h.saved().some(m => m.role === 'compactionSummary' && !m.summary.startsWith(TRANSCRIPT_HEADER))).toBe(true);
		await h.session.compact();
		expect(h.faults).toEqual([]);
		expect(h.compactions()).toHaveLength(1);
		const summaries = h.saved().filter(m => m.role === 'compactionSummary');
		expect(summaries).toHaveLength(1);
		expect(summaries[0]!.summary.startsWith(TRANSCRIPT_HEADER + '\n')).toBe(true); // this compactor's own format
	} finally { await h.cleanup(); }
});

test('the triggers and the context hook stay strict: a foreign summary fails a request closed, as before', async () => {
	const r = await scenario({ at: 'prompt', complete: 40000, host: 6000, summary: true, foreign: true });
	expect(r.faults.join(' '), r.probe).toContain('Cannot resolve custom sources in an unsupported compaction summary');
	expect(r.requests, r.probe).toBe(0);
});

// ---------------------------------------------------------------------------------------------------------------------
// The two projections are the same function for this compactor's own summaries.
function prng(seed: number) {
	let a = seed >>> 0;
	return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } };
function session(seed: number) {
	const rng = prng(seed), int = (n: number) => Math.floor(rng() * n);
	const dir = mkdtempSync(join(tmpdir(), 'pi-measurable-'));
	const manager = SessionManager.inMemory(dir);
	const ids: string[] = [], customIds: string[] = [];
	const first = manager.appendMessage({ role: 'user', content: 'Opening', timestamp: 0 }); ids.push(first);
	for (let i = 0, n = 6 + int(14); i < n; i++) {
		const kind = int(3);
		if (kind === 0) ids.push(manager.appendMessage({ role: 'user', content: 'u'.repeat(1 + int(400)), timestamp: 0 }));
		else if (kind === 1) ids.push(manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'a'.repeat(1 + int(400)) }], stopReason: 'stop', api: 'openai-responses', provider: 'openai', model: 'm', timestamp: 0, usage }));
		else customIds.push(manager.appendCustomMessageEntry('host.note', 'c'.repeat(1 + int(400)), false));
	}
	// A summary in this compactor's format: records that cite sources by their original index, and custom records that cite an entry id.
	const records: TranscriptRecord[] = [];
	for (let i = 0, n = 1 + int(10); i < n; i++) {
		const kind = int(4);
		if (kind === 0) records.push({ kind: 'excerpt', role: 'user', sourceIndex: int(ids.length), text: 'q'.repeat(1 + int(300)) });
		else if (kind === 1) records.push({ kind: 'excerpt', role: 'assistant', sourceIndex: int(ids.length), text: 'r'.repeat(1 + int(300)) });
		else if (kind === 2 && customIds.length) records.push({ kind: 'excerpt', role: 'custom', sourceEntryId: customIds[int(customIds.length)]!, text: 'n'.repeat(1 + int(300)) });
		else records.push({ kind: 'omission', reason: 'Omitted ' + 'x'.repeat(int(100)) });
	}
	manager.appendCompaction(serializeTranscript(records) + SUMMARY_SUFFIX, first, 1000, { compactor: 'pi-tuck', version: 2 }, true);
	// Native omissions of some of the quoted sources.
	for (const id of ids) if (rng() < 0.25) manager.appendContextEdit(id, null);
	for (const id of customIds) if (rng() < 0.25) manager.appendContextEdit(id, null);
	manager.appendMessage({ role: 'user', content: 'Latest', timestamp: 0 });
	const ctx = { sessionManager: manager, cwd: dir } as unknown as ExtensionContext;
	return { manager, ctx, messages: manager.buildSessionProjection().messages, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

test('for this compactor\'s own summaries the measurable projection is the strict one: the same messages, the same tokens', () => {
	let filtered = 0;
	for (let seed = 1; seed <= 300; seed++) {
		const s = session(seed);
		try {
			const strict = projectedMessages(s.messages, s.ctx), lenient = measurableMessages(s.messages, s.ctx);
			expect(lenient, `seed ${seed}`).toEqual(strict);
			expect(conversationTokens(lenient), `seed ${seed}`).toBe(conversationTokens(strict));
			// The filters really changed some summaries: omitted sources and custom quotes left out.
			const raw = s.messages.find(m => m.role === 'compactionSummary');
			const out = strict.find(m => m.role === 'compactionSummary');
			if (raw?.role === 'compactionSummary' && out?.role === 'compactionSummary' && raw.summary !== out.summary) filtered++;
		} finally { s.dispose(); }
	}
	expect(filtered).toBeGreaterThan(100);
});

test('any other summary is left as it is, and never fails the measure', () => {
	const dir = mkdtempSync(join(tmpdir(), 'pi-measurable-'));
	try {
		for (const summary of ['## Goal\nA default Pi summary.', '', TRANSCRIPT_HEADER + '\nnot a record and no suffix', 'x'.repeat(5000)]) {
			const manager = SessionManager.inMemory(dir);
			const first = manager.appendMessage({ role: 'user', content: 'Opening', timestamp: 0 });
			manager.appendMessage({ role: 'user', content: 'Later', timestamp: 0 });
			manager.appendCompaction(summary, first, 1000, undefined, false);
			manager.appendContextEdit(first, null); // with a native omission pending, the strict filter fails in a different place
			const ctx = { sessionManager: manager, cwd: dir } as unknown as ExtensionContext;
			const messages = manager.buildSessionProjection().messages;
			expect(() => projectedMessages(messages, ctx), JSON.stringify(summary.slice(0, 20))).toThrow('unsupported compaction summary');
			expect(measurableMessages(messages, ctx), JSON.stringify(summary.slice(0, 20))).toEqual(messages);
		}
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
