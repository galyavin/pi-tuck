import { test, expect } from 'vitest';
import { BAND, HOST, ROOM, harness, receiptOf } from './budget-fixture';

// Pi's own cut finder keeps the last keepRecentTokens of the conversation. When that is at least the whole conversation, Pi has nothing to
// cut, and before 1.0.10 every prompt on a conversation above the room was refused for good (t06 at Pi's defaults, 32k window, 2026-11-01:
// 28 of 30 tasks lost). The cut a prompt needs is pi-tuck's own, whatever keepRecentTokens is.
test('keepRecentTokens above the whole conversation: a prompt on a conversation above the room is cut and answered, and so is the next', async () => {
	const h = await harness({ at: 'prompt', complete: ROOM + 2000, host: HOST, keepRecent: ROOM * 2 });
	try {
		const first = await h.run();
		expect(first.faults, first.probe).toEqual([]);
		expect(first.requests, first.probe).toBeGreaterThanOrEqual(1);
		for (const guarded of first.guard) expect(guarded, first.probe).toBeLessThan(ROOM);
		// The run saved the cut its prompt needed, as pi-tuck's own.
		expect(first.entries.map(entry => receiptOf(entry).reason), first.probe).toEqual(['prompt']);
		const requests = h.state.requests, faults = h.faults.length;
		await h.session.prompt('A short prompt');
		expect(h.faults.slice(faults), first.probe).toEqual([]);
		expect(h.state.requests - requests, first.probe).toBe(1);
	} finally { await h.cleanup(); }
}, 120000);

// An aborted run (Esc, a time limit) gets no run-end cut: Pi skips agent_before_settle on abort. It can leave the conversation above the room,
// as t06's task 2 did at Pi's 30-minute cap, and every prompt after it was refused. Here the run is left as an abort leaves it: a large tool
// round on top, no cut, nothing settled.
test('keepRecentTokens above the whole conversation: after a run that left the conversation above the room, the next prompt is answered', async () => {
	const h = await harness({ at: 'prompt', complete: BAND - 5000, host: HOST, keepRecent: ROOM * 2 });
	try {
		const first = await h.run();
		expect(first.faults, first.probe).toEqual([]);
		h.round(Math.ceil(ROOM - BAND + 10000));
		const requests = h.state.requests, faults = h.faults.length;
		await h.session.prompt('Next task');
		expect(h.faults.slice(faults), first.probe).toEqual([]);
		expect(h.state.requests - requests, first.probe).toBe(1);
		for (const guarded of h.guard.slice(-1)) expect(guarded, first.probe).toBeLessThan(ROOM);
	} finally { await h.cleanup(); }
}, 120000);
