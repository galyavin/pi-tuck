import { expect, test } from 'vitest';
import { harness } from './budget-fixture';
import { tuck, tuckRecall } from '../src/tuck';

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
