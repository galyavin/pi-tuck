import { test, expect } from 'vitest';
import { convertToLlm, estimateTokens } from '@earendil-works/pi-coding-agent';
import { getCurrentSystemMessage } from '@earendil-works/pi-ai';
import { TRIGGER_MARGIN_FRACTION, bandOf, chooseCut, conversationTokens, decideCut, gateCut, guardSystemTokens, incomingTokens, observedSystemTokens,
	planningReserve, requestTokens, systemPart, type Plan } from '../src/budget';

type Messages = Parameters<typeof convertToLlm>[0];
const SUMMARY_PREFIX = 'The conversation history before this point was compacted into the following summary:\n\n<summary>\n';
const SUMMARY_SUFFIX = '\n</summary>';
const BRANCH_PREFIX = 'The following is a summary of a branch that this conversation came back from:\n\n<summary>\n';
const BRANCH_SUFFIX = '</summary>';

// A mix with every message kind Pi converts: the wrapper kinds are the ones a raw estimate gets wrong.
const mix = (n: number): Messages => [
	{ role: 'system', content: 'You are a test.', sections: { cwd: 'x'.repeat(40 + n) }, timestamp: 0 },
	{ role: 'user', content: 'u'.repeat(10 + n), timestamp: 0 },
	{ role: 'compactionSummary', summary: 's'.repeat(333 + n), tokensBefore: 1, timestamp: 0 },
	{ role: 'branchSummary', summary: 'b'.repeat(77 + n), fromId: 'f', timestamp: 0 },
	{ role: 'custom', customType: 'x', content: 'c'.repeat(51 + n), display: false, timestamp: 0 },
	{ role: 'custom', customType: 'x', content: [{ type: 'text', text: 'd'.repeat(23 + n) }], display: false, timestamp: 0 },
	{ role: 'bashExecution', command: 'ls', output: 'o'.repeat(99 + n), exitCode: 1, cancelled: false, truncated: false, timestamp: 0 },
	{ role: 'bashExecution', command: 'secret', output: 'hidden', exitCode: 0, cancelled: false, truncated: false, timestamp: 0, excludeFromContext: true },
	{ role: 'assistant', content: [{ type: 'text', text: 'a'.repeat(17 + n) }, { type: 'toolCall', id: 't', name: 'read', arguments: { path: 'p' } }], stopReason: 'toolUse', api: 'openai-responses', provider: 'openai', model: 'm', timestamp: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } } },
	{ role: 'toolResult', toolCallId: 't', toolName: 'read', isError: false, timestamp: 0, content: [{ type: 'text', text: 'r'.repeat(61 + n) }] },
] as Messages;

test('the margin is one named constant, 2% of the room, rounded up, and never negative', () => {
	expect(TRIGGER_MARGIN_FRACTION).toBe(0.02);
	expect(bandOf(144000)).toBe(141120);
	expect(bandOf(100)).toBe(98);
	expect(bandOf(101)).toBe(98); // ceil(2.02) = 3
	expect(bandOf(1)).toBe(0);
	expect(bandOf(0)).toBe(0);
	expect(bandOf(-50)).toBe(-50);
});

test('conversationTokens counts the non-system messages after Pi\'s conversion, wrappers included', () => {
	for (const n of [0, 1, 2, 3, 4, 5, 11]) {
		const messages = mix(n);
		// By hand, from the characters Pi sends: system and the excluded bash command do not count.
		const chars = [10 + n, SUMMARY_PREFIX.length + 333 + n + SUMMARY_SUFFIX.length, BRANCH_PREFIX.length + 77 + n + BRANCH_SUFFIX.length, 51 + n, 23 + n,
			'Ran `ls`\n```\n'.length + 99 + n + '\n```'.length + '\n\nCommand exited with code 1'.length, 17 + n + 'read'.length + JSON.stringify({ path: 'p' }).length, 61 + n];
		expect(conversationTokens(messages)).toBe(chars.reduce((sum, c) => sum + Math.ceil(c / 4), 0));
		// And as the sum of Pi's own estimates over its own conversion, message by message.
		expect(conversationTokens(messages)).toBe(convertToLlm(messages).filter(m => m.role !== 'system').reduce((sum, m) => sum + estimateTokens(m), 0));
	}
	expect(conversationTokens([])).toBe(0);
});

test('the compaction-summary wrapper is counted: a raw estimate of the saved message is smaller', () => {
	const summary: Messages = [{ role: 'compactionSummary', summary: 's'.repeat(400), tokensBefore: 1, timestamp: 0 }];
	expect(estimateTokens(summary[0]!)).toBe(100);
	expect(conversationTokens(summary)).toBe(Math.ceil((SUMMARY_PREFIX.length + 400 + SUMMARY_SUFFIX.length) / 4));
	expect(conversationTokens(summary)).toBeGreaterThan(estimateTokens(summary[0]!) + 20);
});

test('guardSystemTokens is the larger of the saved system message and the live prompt with the saved tools', () => {
	const tool = { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} } };
	const saved: Messages = [{ role: 'system', content: '', sections: { preamble: 'p'.repeat(400) }, toolsAdded: [tool], timestamp: 0 }, { role: 'user', content: 'hi', timestamp: 0 }] as Messages;
	const toolsChars = JSON.stringify([tool]).length;
	// The live prompt is shorter than the saved sections: the saved message wins.
	expect(guardSystemTokens(saved, 'short')).toBe(Math.ceil((400 + toolsChars) / 4));
	// The live prompt is longer: it is charged with the saved system message's tools, never without them.
	expect(guardSystemTokens(saved, 'L'.repeat(1000))).toBe(Math.ceil((1000 + toolsChars) / 4));
	// No saved system message: the prompt alone.
	expect(guardSystemTokens([{ role: 'user', content: 'hi', timestamp: 0 }], 'x'.repeat(40))).toBe(10);
	expect(guardSystemTokens([], '')).toBe(0);
	// Independent of the system messages' order and of later checkpoints (Pi replays them).
	const checkpoint = { role: 'system', content: 'more', toolsRemoved: [{ name: 'read' }], timestamp: 1 } as Messages[number];
	const current = getCurrentSystemMessage(convertToLlm([...saved, checkpoint]));
	expect(guardSystemTokens([...saved, checkpoint], 'short')).toBe(Math.max(estimateTokens(current!), estimateTokens({ role: 'system', content: 'short', toolsAdded: current!.toolsAdded, timestamp: 0 })));
});

test('requestTokens is the guard\'s complete measure: system formula plus every converted non-system message', () => {
	for (const n of [0, 3, 9]) {
		const messages = mix(n);
		for (const prompt of ['', 'p'.repeat(5000 + n), 'q'.repeat(100)])
			expect(requestTokens(messages, prompt)).toBe(guardSystemTokens(messages, prompt) + conversationTokens(messages));
	}
	// By hand: prompt 4000 characters, one user message of 40 characters.
	expect(requestTokens([{ role: 'user', content: 'u'.repeat(40), timestamp: 0 }], 'p'.repeat(4000))).toBe(1000 + 10);
});

test('systemPart charges the larger of the observed prompt and tools and the guard formula', () => {
	const tools = [{ name: 'a', description: 'd'.repeat(2000), parameters: {} }];
	const observed = (prompt: string) => Math.ceil((prompt.length + JSON.stringify(tools).length) / 4);
	expect(observedSystemTokens('p'.repeat(400), tools)).toBe(observed('p'.repeat(400)));
	expect(observedSystemTokens('', [])).toBe(0); // Empty tool declarations are omitted; an empty prompt adds no tokens.
	// No saved system message: the observed measure is larger.
	expect(systemPart('p'.repeat(400), tools, [], 'p'.repeat(400))).toBe(observed('p'.repeat(400)));
	// A saved system message that declares more than the live tools (a tool dropped since): the guard formula is larger and wins.
	const saved: Messages = [{ role: 'system', content: '', sections: { preamble: 'x'.repeat(40000) }, timestamp: 0 }] as Messages;
	expect(systemPart('p'.repeat(400), tools, saved, 'p'.repeat(400))).toBe(10000);
	expect(10000).toBeGreaterThan(observed('p'.repeat(400)));
});

test('incomingTokens counts the prompt and the images', () => {
	expect(incomingTokens('p'.repeat(40), undefined)).toBe(10);
	const image = { type: 'image' as const, data: 'AAAA', mimeType: 'image/png' };
	expect(incomingTokens('p'.repeat(40), [image])).toBe(10 + estimateTokens({ role: 'user', content: [image], timestamp: 0 }));
	expect(estimateTokens({ role: 'user', content: [image], timestamp: 0 })).toBeGreaterThan(0);
});

test('planningReserve is the old reserve at the room with factor 1, and the factor scales only the room', () => {
	const window = 272000, room = 144000, response = window - room;
	// Old arithmetic: planningResponse(response) + projectedInput + incoming = (window - floor(room / factor)) + the mandatory sum.
	expect(planningReserve(window, room, 1, 18052)).toBe(response + 18052);
	expect(planningReserve(window, bandOf(room), 1, 18052)).toBe(window - 141120 + 18052);
	expect(planningReserve(window, room, 1.25, 0)).toBe(window - Math.floor(144000 / 1.25));
	expect(planningReserve(window, room, 1.13, 7)).toBe(window - Math.floor(144000 / 1.13) + 7);
});

// ---------------------------------------------------------------------------------------------------------------------
// decideCut: every branch.
const fitsAt = (factor = 1) => (tokens: number, limit: number) => Math.ceil(tokens * factor) < limit;
const ROOM = 1000, BAND = bandOf(ROOM);
type Calls = Target[];
type Target = 'band' | 'room';
const planner = (plans: { band?: Plan<{ tag: string }>; room?: Plan<{ tag: string }> }, calls: Calls) => (target: Target): Plan<{ tag: string }> => {
	calls.push(target);
	const plan = plans[target];
	if (!plan) throw new Error('unexpected plan ' + target);
	return plan;
};
const draft = (after: number, tag = 'x', mode = 'bounded'): Plan<{ tag: string }> => ({ draft: true, after, mode, tag });
const none = (capacityRejected = false, reason = 'no cut'): Plan<{ tag: string }> => ({ draft: false, capacityRejected, reason });
const base = (over: Partial<{ total: number; mandatory: number; before: number }>) => ({ total: 0, mandatory: 100, before: 500, room: ROOM, band: BAND, fits: fitsAt(), unreduced: 'did not reduce', ...over });

test('decideCut rule 1: a request below the band is not cut and nothing is planned', () => {
	const calls: Calls = [];
	expect(decideCut({ ...base({ total: BAND - 1 }), plan: planner({}, calls) })).toEqual({ kind: 'none' });
	expect(calls).toEqual([]);
});

test('decideCut rule 3: mandatory input that does not fit the room defers to the guard in the band and above, and plans nothing', () => {
	for (const total of [BAND, ROOM - 1, ROOM, ROOM + 500]) {
		const calls: Calls = [];
		expect(decideCut({ ...base({ total, mandatory: ROOM }), plan: planner({}, calls) })).toEqual({ kind: 'defer' });
		expect(calls).toEqual([]);
	}
	// Mandatory input just under the room does not defer.
	expect(decideCut({ ...base({ total: ROOM + 10, mandatory: ROOM - 1 }), plan: planner({ band: draft(0), room: draft(0) }, []) }).kind).toBe('cut');
});

// The room is planned first. With the mandatory input m = 100 a room plan lands below the band when its `after` is at most BAND - m - 1.
const M = 100, FITS_BAND = BAND - M - 1, JUST_OVER = BAND - M;

test('decideCut rule 4, whatever the request: a room plan that already lands below the band is taken as it is, and the band is not planned', () => {
	for (const total of [BAND, BAND + 1, ROOM - 1, ROOM, ROOM + 5000]) for (const bandPlan of [draft(300, 'band', 'shrunk'), draft(300, 'band', 'bounded'), none()]) {
		const calls: Calls = [];
		const d = decideCut({ ...base({ total, before: 2000, mandatory: M }), plan: planner({ band: bandPlan, room: draft(FITS_BAND, 'room', 'bounded') }, calls) });
		expect(d, `${total}`).toEqual({ kind: 'cut', target: 'room', plan: { draft: true, after: FITS_BAND, mode: 'bounded', tag: 'room' } });
		expect(calls).toEqual(['room']);
	}
	// The edge: one token more and the room plan no longer fits the band, so the band is planned (and, same mode, taken).
	const calls: Calls = [];
	expect(decideCut({ ...base({ total: ROOM - 1, before: 2000, mandatory: M }), plan: planner({ band: draft(FITS_BAND, 'band', 'bounded'), room: draft(JUST_OVER, 'room', 'bounded') }, calls) }))
		.toMatchObject({ kind: 'cut', target: 'band', plan: { tag: 'band' } });
	expect(calls).toEqual(['room', 'band']);
	// A room plan that does not reduce is not taken as it is, however small it is.
	expect(decideCut({ ...base({ total: ROOM - 1, before: 50, mandatory: M }), plan: planner({ band: none(), room: draft(60, 'room') }, []) })).toEqual({ kind: 'none' });
});

test('decideCut rule 4, inside the band: a band cut is taken only when the room can plan a cut too, with the same view', () => {
	for (const total of [BAND, BAND + 1, ROOM - 1]) {
		const calls: Calls = [];
		expect(decideCut({ ...base({ total, before: 2000, mandatory: M }), plan: planner({ band: draft(FITS_BAND, 'band', 'dialogue'), room: draft(JUST_OVER + 50, 'room', 'dialogue') }, calls) }))
			.toEqual({ kind: 'cut', target: 'band', plan: { draft: true, after: FITS_BAND, mode: 'dialogue', tag: 'band' } });
		expect(calls).toEqual(['room', 'band']);
	}
});

test('decideCut rule 4, inside the band: the margin never changes the view: a band cut whose view differs from the room plan\'s is not taken', () => {
	for (const [bandMode, roomMode] of [['shrunk', 'dialogue'], ['dialogue', 'bounded'], ['masked', 'full'], ['bounded', 'shrunk']] as const) {
		const calls: Calls = [];
		expect(decideCut({ ...base({ total: ROOM - 1, before: 2000, mandatory: M }), plan: planner({ band: draft(FITS_BAND, 'band', bandMode), room: draft(JUST_OVER + 50, 'room', roomMode) }, calls) }), `${bandMode} against ${roomMode}`).toEqual({ kind: 'none' });
		expect(calls).toEqual(['room', 'band']);
	}
});

test('decideCut rule 4, inside the band: a band cut the exact room cannot plan at all is not taken (today cuts nothing there; no fault to prevent)', () => {
	for (const total of [BAND, ROOM - 1]) {
		const calls: Calls = [];
		expect(decideCut({ ...base({ total, before: 2000, mandatory: M }), plan: planner({ band: draft(FITS_BAND, 'band', 'shrunk'), room: none(true, 'cannot fit') }, calls) })).toEqual({ kind: 'none' });
		expect(calls).toEqual(['room', 'band']);
	}
});

test('decideCut rule 4, inside the band: a cut that cannot be taken is no fault, and does not fall back to the room', () => {
	const cases: [string, Plan<{ tag: string }>][] = [
		['no draft', none(false, 'cannot')],
		['no draft, capacity rejected', none(true, 'cannot fit')],
		['a draft that does not reduce', draft(2000)],
		['a draft that increases', draft(2001)],
		['a draft that reduces but lands in the band', draft(JUST_OVER)],
		['a draft that reduces but lands far in the band', draft(JUST_OVER + 500)],
	];
	for (const [name, plan] of cases) {
		const calls: Calls = [];
		// The room plan is a draft of the same view that does not land below the band: it does not rescue the band plan.
		expect(decideCut({ ...base({ total: ROOM - 1, before: 2000, mandatory: M }), plan: planner({ band: plan, room: draft(JUST_OVER + 50, 'room') }, calls) }), name).toEqual({ kind: 'none' });
		expect(calls, name).toEqual(['room', 'band']);
	}
	// The edge itself: the draft that fits the band by one token is taken.
	expect(decideCut({ ...base({ total: ROOM - 1, before: 2000, mandatory: M }), plan: planner({ band: draft(FITS_BAND), room: draft(JUST_OVER + 50) }, []) }).kind).toBe('cut');
});

test('decideCut rule 4, at or above the room: the band plan is taken when the room plan has the same view, or when the room has no plan (a cut instead of a fault)', () => {
	for (const total of [ROOM, ROOM + 1, ROOM + 5000]) {
		const calls: Calls = [];
		expect(decideCut({ ...base({ total, before: 5000, mandatory: M }), plan: planner({ band: draft(300, 'band'), room: draft(JUST_OVER + 10, 'room') }, calls) }))
			.toEqual({ kind: 'cut', target: 'band', plan: { draft: true, after: 300, mode: 'bounded', tag: 'band' } });
		expect(calls).toEqual(['room', 'band']);
		expect(decideCut({ ...base({ total, before: 5000, mandatory: M }), plan: planner({ band: draft(300, 'band'), room: none() }, []) })).toMatchObject({ kind: 'cut', target: 'band' });
	}
});

test('decideCut rule 4, at or above the room: a band plan of another view gives way to the room plan, today\'s view', () => {
	for (const [bandMode, roomMode] of [['shrunk', 'dialogue'], ['dialogue', 'bounded'], ['masked', 'full']] as const) {
		const calls: Calls = [];
		expect(decideCut({ ...base({ total: ROOM, before: 5000, mandatory: M }), plan: planner({ band: draft(300, 'band', bandMode), room: draft(JUST_OVER + 10, 'room', roomMode) }, calls) }), `${bandMode} against ${roomMode}`)
			.toEqual({ kind: 'cut', target: 'room', plan: { draft: true, after: JUST_OVER + 10, mode: roomMode, tag: 'room' } });
		expect(calls).toEqual(['room', 'band']);
	}
});

test('decideCut rule 4, at or above the room: with no band plan the room plan is used, as before the margin', () => {
	for (const total of [ROOM, ROOM + 1, ROOM + 5000]) {
		const calls: Calls = [];
		expect(decideCut({ ...base({ total, before: 5000, mandatory: M }), plan: planner({ band: none(), room: draft(JUST_OVER + 10, 'room', 'shrunk') }, calls) }))
			.toEqual({ kind: 'cut', target: 'room', plan: { draft: true, after: JUST_OVER + 10, mode: 'shrunk', tag: 'room' } });
		expect(calls).toEqual(['room', 'band']);
	}
});

test('decideCut rule 4, at or above the room: no plan is a fault, labelled by the room plan', () => {
	expect(decideCut({ ...base({ total: ROOM }), plan: planner({ band: none(true, 'band reason'), room: none(false, 'room reason') }, []) }))
		.toEqual({ kind: 'fault', capacity: false, message: 'room reason' });
	expect(decideCut({ ...base({ total: ROOM }), plan: planner({ band: none(false, 'band reason'), room: none(true, 'room capacity') }, []) }))
		.toEqual({ kind: 'fault', capacity: true, message: 'room capacity' });
});

test('decideCut rule 4, at or above the room: a draft that does not reduce or does not fit the room is a fault, whichever plan made it', () => {
	// Not a reduction, but it fits: not a capacity fault.
	expect(decideCut({ ...base({ total: ROOM, before: 500, mandatory: M }), plan: planner({ band: draft(500), room: draft(500) }, []) })).toEqual({ kind: 'fault', capacity: false, message: 'did not reduce' });
	// A reduction that lands over the room: a capacity fault; and with the mandatory input counted (after + mandatory), not after alone.
	expect(decideCut({ ...base({ total: ROOM, before: 2000, mandatory: M }), plan: planner({ band: draft(ROOM - M), room: draft(ROOM - M) }, []) })).toEqual({ kind: 'fault', capacity: true, message: 'did not reduce' });
	expect(decideCut({ ...base({ total: ROOM, before: 2000, mandatory: M }), plan: planner({ band: draft(ROOM - M - 1), room: draft(ROOM - M - 1) }, []) }).kind).toBe('cut');
	// The room plan is checked the same way, whether it stands alone or replaces a band plan of another view.
	expect(decideCut({ ...base({ total: ROOM, before: 2000, mandatory: M }), plan: planner({ band: none(), room: draft(ROOM - M) }, []) })).toEqual({ kind: 'fault', capacity: true, message: 'did not reduce' });
	expect(decideCut({ ...base({ total: ROOM, before: 2000, mandatory: M }), plan: planner({ band: none(), room: draft(ROOM - M - 1) }, []) }).kind).toBe('cut');
	expect(decideCut({ ...base({ total: ROOM, before: 2000, mandatory: M }), plan: planner({ band: draft(10, 'b', 'shrunk'), room: draft(ROOM - M, 'r', 'bounded') }, []) })).toEqual({ kind: 'fault', capacity: true, message: 'did not reduce' });
});

test('decideCut uses the calibrated count: the factor applies to the request, the band and the room alike', () => {
	const fits = fitsAt(1.25);
	// 0.8 * 1000 = 800 raw tokens reach the room; the band is 980 / 1.25 = 784.
	expect(decideCut({ ...base({ total: 783 }), fits, plan: planner({}, []) })).toEqual({ kind: 'none' });
	expect(decideCut({ ...base({ total: 784, before: 700, mandatory: 50 }), fits, plan: planner({ band: draft(300), room: draft(300) }, []) }).kind).toBe('cut');
	expect(decideCut({ ...base({ total: 800, before: 700, mandatory: 50 }), fits, plan: planner({ band: none(), room: draft(300) }, []) })).toMatchObject({ kind: 'cut', target: 'room' });
	// A room plan lands below the band by the calibrated count: 784 raw tokens is the edge (ceil(783 * 1.25) = 979 < 980; ceil(784 * 1.25) = 980).
	expect(decideCut({ ...base({ total: 800, before: 2000, mandatory: 50 }), fits, plan: planner({ band: draft(10, 'b', 'shrunk'), room: draft(733, 'r') }, []) })).toMatchObject({ kind: 'cut', target: 'room' });
	expect(decideCut({ ...base({ total: 800, before: 2000, mandatory: 50 }), fits, plan: planner({ band: draft(10, 'b', 'shrunk'), room: draft(734, 'r') }, []) })).toMatchObject({ kind: 'cut', target: 'room' }); // another view: the room plan wins either way
	expect(decideCut({ ...base({ total: 800, before: 2000, mandatory: 50 }), fits, plan: planner({ band: draft(10, 'b', 'bounded'), room: draft(734, 'r', 'bounded') }, []) })).toMatchObject({ kind: 'cut', target: 'band' });
});

test('exceptions thrown by the planner are not caught by the decision', () => {
	const boom = () => { throw new Error('invalid boundary'); };
	expect(() => decideCut({ ...base({ total: ROOM }), plan: boom })).toThrow('invalid boundary');
	expect(() => decideCut({ ...base({ total: ROOM - 1 }), plan: boom })).toThrow('invalid boundary');
	expect(() => decideCut({ ...base({ total: BAND - 1 }), plan: boom })).not.toThrow();
	// Also from the band plan, once the room plan did not settle it.
	const bandBoom = (target: Target) => { if (target === 'band') throw new Error('invalid boundary'); return draft(JUST_OVER + 50); };
	expect(() => decideCut({ ...base({ total: ROOM - 1, before: 2000, mandatory: M }), plan: bandBoom })).toThrow('invalid boundary');
	expect(() => decideCut({ ...base({ total: ROOM, before: 2000, mandatory: M }), plan: bandBoom })).toThrow('invalid boundary');
});

test('gateCut and chooseCut compose to decideCut', () => {
	const input = base({ total: ROOM - 1, mandatory: 100, before: 500 });
	expect(gateCut(input)).toEqual({ kind: 'plan', opportunistic: true });
	expect(gateCut({ ...input, total: ROOM })).toEqual({ kind: 'plan', opportunistic: false });
	expect(gateCut({ ...input, total: BAND - 1 })).toEqual({ kind: 'none' });
	expect(gateCut({ ...input, total: ROOM + 1, mandatory: ROOM })).toEqual({ kind: 'defer' });
	expect(chooseCut({ ...input, opportunistic: true, plan: planner({ band: none(), room: none() }, []) })).toEqual({ kind: 'none' });
	expect(chooseCut({ ...input, opportunistic: false, plan: planner({ band: none(), room: none(true, 'r') }, []) })).toEqual({ kind: 'fault', capacity: true, message: 'r' });
});
