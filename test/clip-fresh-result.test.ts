import { expect, test } from 'vitest';
import { harness } from './budget-fixture';
import { tuck, tuckRecall } from '../src/tuck';
import { clipFor } from '../src/clip';
import { conversationTokens } from '../src/budget';

// A fresh tool result larger than the room cannot reach the model whole, and a cut keeps it whole. Rather than refuse the run, the request
// carries its head and tail and a tuck_recall locator to the rest; the session keeps the full result. Recorded case: eval live32 t02-B task 10,
// a 50,880-character bash result at a 32,768 window with a 16,384 reply reserve.
const WINDOW = 32768, RESPONSE = 16384;
const small = { limits: { contextWindow: WINDOW, maxTokens: RESPONSE }, reserveTokens: RESPONSE, cutAtDefault: true, liveTools: true,
	compaction: { requestReserve: () => ({ response: RESPONSE, responseExact: true as const }) } };

test('a fresh result larger than the room is clipped in the request, not refused, and the rest stays readable', async () => {
	const h = await harness({ ...small, system: 1500, host: 100, at: 'tool', history: 4000, fresh: 30000, complete: 37500, rounds: 1 });
	const requests: string[] = [];
	h.extension().on('context_with_system', event => { requests.push(JSON.stringify(event.messages)); });
	try {
		const result = await h.run();
		expect(result.faults, result.probe).toEqual([]);
		expect(result.aborts).toBe(0);
		expect(result.last?.stopReason, result.probe).toBe('stop');
		expect(result.guard.every(tokens => tokens < WINDOW - RESPONSE), result.probe).toBe(true);
		// The session keeps the whole result; the request after it carries the clip.
		const receipt = h.manager.getBranch().findLast(entry => entry.type === 'message' && entry.message.role === 'toolResult')!;
		const full = receipt.type === 'message' && receipt.message.role === 'toolResult' && receipt.message.content[0]!.type === 'text' ? receipt.message.content[0]!.text : '';
		expect(full.length).toBeGreaterThan(100000);
		const locator = requests.at(-1)!.match(/characters (\d+)-(\d+) of (\d+) are not shown, to fit the context window; read them with tuck_recall \{\\"entryId\\":\\"([^"\\]+)\\",\\"offset\\":(\d+)\}/);
		expect(locator, requests.at(-1)!.slice(0, 300)).not.toBeNull();
		const [, from, to, length, entryId, offset] = locator!;
		expect([Number(length), entryId, Number(offset)]).toEqual([full.length, receipt.id, Number(from)]);
		expect(requests.at(-1)!.length).toBeLessThan(full.length / 2);
		const read = tuckRecall(tuck, h.manager.getEntries(), h.manager.getBranch(), { entryId, offset: Number(from), limit: 16000 });
		expect(JSON.stringify(read)).toContain(JSON.stringify(full.slice(Number(from), Number(from) + 200)).slice(1, -1));
		expect(Number(to)).toBeGreaterThan(Number(from));
	} finally { await h.cleanup(); }
}, 120000);

// eval live32 t01-C task 2: one reply's three parallel bash calls, none larger than the room alone, too large together.
test('a round of parallel results shares the budget: the small one stays whole, the large ones are clipped, and the round fits', () => {
	const result = (id: string, chars: number) => ({ role: 'toolResult' as const, toolCallId: id, toolName: 'bash', isError: false, timestamp: 0,
		content: [{ type: 'text' as const, text: Array.from({ length: Math.ceil(chars / 8) }, (_, i) => `${id}${(i % 9999).toString().padStart(4, '0')} `).join('').slice(0, chars) }] });
	const round = [result('a', 18223), result('b', 27178), result('c', 5395)];
	const size = (message: unknown) => conversationTokens([message] as never);
	const budget = 6500;
	expect(round.reduce((sum, r) => sum + size(r), 0)).toBeGreaterThan(budget);
	const clips = clipFor(round, id => `entry-${id}`, budget);
	expect(clips.map(c => c.toolCallId).sort()).toEqual(['a', 'b']);
	const shown = round.map(r => ({ ...r, content: clips.find(c => c.toolCallId === r.toolCallId)?.content ?? r.content }));
	expect(shown.reduce((sum, r) => sum + size(r), 0)).toBeLessThanOrEqual(budget);
	for (const clip of clips) {
		const text = clip.content[0]!.type === 'text' ? clip.content[0]!.text : '';
		const full = round.find(r => r.toolCallId === clip.toolCallId)!.content[0]!.text;
		const [, from, to] = text.match(/characters (\d+)-(\d+) of (\d+)/)!;
		expect(text).toContain(`tuck_recall {"entryId":"entry-${clip.toolCallId}","offset":${from}}`);
		expect(text.startsWith(full.slice(0, Number(from)))).toBe(true);
		expect(text.endsWith(full.slice(Number(to)))).toBe(true);
	}
	// One result alone gets the whole budget.
	const alone = 3000, [single] = clipFor([round[1]!], id => `entry-${id}`, alone);
	expect(size({ ...round[1], content: single!.content })).toBeLessThanOrEqual(alone);
	expect(size({ ...round[1], content: single!.content })).toBeGreaterThan(alone - 20);
	expect(clipFor([round[2]!], id => `entry-${id}`, alone)).toEqual([]);
});
