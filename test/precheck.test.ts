import { test, expect } from 'vitest';
import { BAND, ROOM, scenario } from './budget-fixture';

// The incoming prompt is checked against the exact room, with the system part and before any cut: "Incoming Pi prompt and response reserve
// cannot fit the estimated request budget". The band does not enter it. A prompt and a system part that straddle the band (the request is
// not over the room: the host input is small) are sent; the check fails only from the room on.
const PRECHECK = 'Incoming Pi prompt and response reserve cannot fit the estimated request budget';
const GUARD = 'Complete Pi context and response reserve exceed the estimated request budget';
const HOST_SMALL = 100;

test('a prompt and a system part that straddle the band are no fault: the request is sent', async () => {
	for (const j of [-3, -2, -1, 0, 1, 2, 3, 500, 1000, 1200]) {
		const r = await scenario({ at: 'prompt', history: 1500, complete: 0, incoming: BAND + j, host: HOST_SMALL });
		expect(r.faults, `${j} ${r.probe}`).toEqual([]);
		expect(r.requests, `${j} ${r.probe}`).toBe(1);
		expect(r.guard[0]!, `${j} ${r.probe}`).toBeLessThan(ROOM);
	}
});

test('the precheck fails exactly from the room on, with its own message; just below, the guard decides', async () => {
	for (const k of [2, 1]) {
		const r = await scenario({ at: 'prompt', history: 1500, complete: 0, incoming: ROOM - k, host: HOST_SMALL });
		// The prompt and the system part fit the room; the host input does not come on top of them: the guard rejects, not the precheck.
		expect(r.faults.join(' '), `-${k} ${r.probe}`).not.toContain(PRECHECK);
		expect(r.faults.join(' '), `-${k} ${r.probe}`).toContain(GUARD);
		expect(r.requests, `-${k} ${r.probe}`).toBe(0);
	}
	for (const k of [0, 1, 1000]) {
		const r = await scenario({ at: 'prompt', history: 1500, complete: 0, incoming: ROOM + k, host: HOST_SMALL });
		expect(r.faults.join(' '), `+${k} ${r.probe}`).toContain(PRECHECK);
		expect(r.requests, `+${k} ${r.probe}`).toBe(0);
		expect(r.cuts, `+${k} ${r.probe}`).toBe(0);
	}
});
