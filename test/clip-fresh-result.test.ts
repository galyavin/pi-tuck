import { expect, test } from 'vitest';
import { harness } from './budget-fixture';
import { tuck, tuckRecall } from '../src/tuck';
import { clipBudgets, clipFor } from '../src/clip';
import { conversationTokens } from '../src/budget';

// A text-only tool result of about `chars` characters, for measuring a round against a budget.
const result = (id: string, chars: number) => ({ role: 'toolResult' as const, toolCallId: id, toolName: 'bash', isError: false, timestamp: 0,
	content: [{ type: 'text' as const, text: Array.from({ length: Math.ceil(chars / 8) }, (_, i) => `${id}${(i % 9999).toString().padStart(4, '0')} `).join('').slice(0, chars) }] });

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

// The budget is counted in the units the round and the mandatory input are counted in. Counting the provider's room against an estimate asks the
// round for more than the room holds once the factor is above 1: recorded at a 28,672-token room with 1,052 of mandatory input, where the old
// (room - mandatory) / 2 let a round through that the provider still refused.
test('the clip budget converts the provider room by the factor before halving it', () => {
	const room = 28672, factor = 1.25, mandatory = 1052, free = Math.floor(room / factor) - mandatory;
	expect(free).toBe(21885);
	expect(clipBudgets(room, factor, mandatory)).toEqual([10942]);
	// The old formula: a round of that many estimate tokens is 17,263 at the provider's count, inside a room of 28,672 - so it clipped nothing,
	// and the request was refused with room to spare.
	expect(Math.floor((room - mandatory) / 2)).toBe(13810);
	expect(Math.round(13810 * factor)).toBeLessThan(room);
	// A round cut to the first budget stays inside the room at the provider's count.
	const big = result('big', 100000);
	expect(conversationTokens([big] as never)).toBeGreaterThan(10942);
	const [clip] = clipFor([big], id => `entry-${id}`, 10942);
	expect(clip).toBeDefined();
	const shown = { ...big, content: clip!.content };
	expect(Math.round(conversationTokens([shown] as never) * factor)).toBeLessThan(room);
	// No budgets when the mandatory input has already taken the room.
	expect(clipBudgets(room, factor, Math.floor(room / factor))).toEqual([]);
});

// A round under the half is not clipped at all, so the half cannot rescue a request whose room is taken by the smallest cut's own floor: the free
// room is 7,320, the cut keeps a 6,614-token quote of the prompt apart from the fresh results, and the round is 3,517. Recorded in the stress grid
// (free 7,320, quote 6,614, result 3,517), where the request was refused although clipping the round to 706 fits it.
test('a round the half leaves whole is clipped to what the smallest cut leaves of the free room', () => {
	const budgets = clipBudgets(7320, 1, 0, 6614);
	expect(budgets).toEqual([3660, 706]);
	const one = [result('r', 14000)];
	const size = conversationTokens(one as never);
	expect(size).toBeGreaterThan(budgets[1]!);
	expect(size).toBeLessThanOrEqual(budgets[0]!);
	// The half clips nothing: the round already fits it, and the request still faults.
	expect(clipFor(one, id => `entry-${id}`, budgets[0]!)).toEqual([]);
	const clips = clipFor(one, id => `entry-${id}`, budgets[1]!);
	expect(clips.map(clip => clip.toolCallId)).toEqual(['r']);
	const shown = { ...one[0]!, content: clips[0]!.content };
	expect(conversationTokens([shown] as never)).toBeLessThanOrEqual(budgets[1]!);
	const text = shown.content[0]!.type === 'text' ? shown.content[0]!.text : '';
	const [, from, to] = text.match(/characters (\d+)-(\d+) of (\d+)/)!;
	expect(text).toContain(`tuck_recall {"entryId":"entry-r","offset":${from}}`);
	expect(text.startsWith(one[0]!.content[0]!.type === 'text' ? one[0]!.content[0]!.text.slice(0, Number(from)) : '')).toBe(true);
});
