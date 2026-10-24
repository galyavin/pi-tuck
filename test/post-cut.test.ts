import { test, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BAND, HOST, ROOM, harness, nonSystem, scenario } from './budget-fixture';

const PREFLIGHT = 'Incoming Pi preflight compaction did not reduce context within the estimated request budget';
const GUARD = 'Complete Pi context and response reserve exceed the estimated request budget';

// The incoming prompt awaits its cut and then takes the snapshot again: the cut ran in between, and the host's view may have changed
// with it. A request the cut did not bring within the room fails closed there, with the cut's own error, before any request is made.
test('the post-cut check of an incoming prompt counts the whole request with a fresh snapshot: host input that grew during the cut fails closed', async () => {
	const h = await harness({ at: 'prompt', complete: ROOM + 500, host: HOST });
	try {
		// The view grows as soon as the cut is committed (attempt effects are recorded in it): the saved conversation and the host input
		// alone still fit the room, with 7,000 tokens to spare, but the whole request (the system part and the prompt come on top) does not.
		h.extension().on('session_compact', () => { h.setHost(ROOM - nonSystem(h.saved()) - 7000); });
		const r = await h.run();
		expect(r.cuts, r.probe).toBe(1);
		expect(r.faults.join(' | '), r.probe).toContain(PREFLIGHT);
		expect(r.faults.join(' | '), r.probe).not.toContain(GUARD);
		expect(r.requests, r.probe).toBe(0);
		expect(h.notices.join(' '), r.probe).toContain('adjust the input, model or reserve'); // over the room: the capacity error
		expect(r.hostCalls, r.probe).toBe(2); // the decision and the snapshot after the cut
	} finally { await h.cleanup(); }
});

test('the post-cut check passes when the host input grew during the cut but the request still fits', async () => {
	const h = await harness({ at: 'prompt', complete: ROOM + 500, host: HOST });
	try {
		h.extension().on('session_compact', () => { h.setHost(HOST + 500); });
		const r = await h.run();
		expect(r.cuts, r.probe).toBe(1);
		expect(r.faults, r.probe).toEqual([]);
		expect(r.requests, r.probe).toBe(1);
		expect(r.guard[0]!, r.probe).toBeLessThan(BAND);
	} finally { await h.cleanup(); }
});

// An opportunistic cut that the planner declines, or that Pi has nothing to do for, is no event for the incident recorder: it must not stop an
// operator's recording as a cancelled or failed cut (Pi reports both as failed compactions).
for (const why of ['the planner declines it', 'Pi has nothing to compact'] as const)
test(`an opportunistic cut that cannot be made leaves the incident recorder recording: ${why}`, async () => {
	const directory = mkdtempSync(join(tmpdir(), 'pi-incident-'));
	const diagnostics = { directory };
	// Declined: an irreducible request inside the band, so nothing can bring it under the band. Nothing to compact: the saved conversation
	// ends with a compaction while the prompt puts the request inside the band.
	const h = await harness(why === 'the planner declines it'
		? { at: 'tool', complete: BAND + 2000, host: HOST, history: 1500, fresh: 100, compaction: { diagnostics } }
		: { at: 'prompt', complete: BAND + 500, host: HOST, compactedLast: true, compaction: { diagnostics } });
	try {
		await h.session.prompt('/compaction-incident on');
		await h.session.prompt('/compaction-incident status');
		expect(JSON.parse(h.notices.at(-1)!).state, h.notices.join('\n')).toBe('recording');
		const r = await h.run();
		expect(r.cuts, r.probe).toBe(0);
		expect(r.faults, r.probe).toEqual([]);
		expect(r.requests, r.probe).toBe(why === 'the planner declines it' ? 2 : 1);
		await h.session.prompt('/compaction-incident status');
		expect(JSON.parse(h.notices.at(-1)!).state, h.notices.join('\n')).toBe('recording');
	} finally { await h.cleanup(); rmSync(directory, { recursive: true, force: true }); }
});

// An opportunistic incoming cut is not needed to send the request, which is below the room: however it ends, it is no fault, unless a
// failure is latched. Today nothing runs inside the band, so no cancellation that is not the compactor's own may become a fault there.
test('an opportunistic cut that an earlier handler cancels is no fault: the request is sent', async () => {
	const r = await scenario({ at: 'prompt', complete: BAND + 100, host: HOST, cancelCompact: true });
	expect(r.faults, r.probe).toEqual([]);
	expect(r.cuts, r.probe).toBe(0);
	expect(r.requests, r.probe).toBe(1);
	expect(r.guard[0]!, r.probe).toBeLessThan(ROOM);
});

test('a cut that is due and that an earlier handler cancels is still a failure, as before the margin', async () => {
	const r = await scenario({ at: 'prompt', complete: ROOM + 500, host: HOST, cancelCompact: true });
	expect(r.faults.join(' '), r.probe).toContain('Compaction cancelled');
	expect(r.requests, r.probe).toBe(0);
});

test('a planner exception inside an opportunistic cut is still a fault: a latched failure is not swallowed', async () => {
	let manager: { getHeader: () => unknown } | undefined;
	// The planner needs the native session header; at the first read after the cut is asked for it is gone, and the draft throws (an invariant
	// break, not a decision). Pi's own later reads see the header again.
	const h = await harness({ at: 'prompt', complete: BAND + 100, host: HOST, onBeforeCompact: () => { const real = manager!.getHeader.bind(manager); let missing = true; manager!.getHeader = () => (missing ? (missing = false, null) : real()); } });
	manager = h.manager as unknown as typeof manager;
	try {
		const r = await h.run();
		expect(r.faults.join(' '), r.probe).toContain('Missing native session header');
		expect(r.requests, r.probe).toBe(0);
		expect(r.cuts, r.probe).toBe(0);
	} finally { await h.cleanup(); }
});

// A cut the compactor proposed and that then fails to commit is not an opportunistic non-event: Pi appends the compaction to the session in
// memory before it writes the file, so a write that fails (ENOSPC, EIO) leaves the session holding a cut that the file lacks. That must fault.
test('an opportunistic cut the compactor proposed and Pi then fails to commit is a fault: nothing swallows it', async () => {
	const h = await harness({ at: 'prompt', complete: BAND + 100, host: HOST });
	try {
		const manager = h.manager as unknown as { _persist: (entry: { type: string }) => void };
		const persist = manager._persist.bind(manager);
		manager._persist = (entry) => { if (entry.type === 'compaction') throw new Error('ENOSPC: no space left on device'); persist(entry); };
		const r = await h.run();
		expect(r.faults.join(' | '), r.probe).toContain('Compaction failed: ENOSPC');
		expect(r.requests, r.probe).toBe(0);
		// Control: the very same run with a working disk cuts and sends the request.
		const ok = await scenario({ at: 'prompt', complete: BAND + 100, host: HOST });
		expect(ok.faults, ok.probe).toEqual([]);
		expect(ok.cuts, ok.probe).toBe(1);
		expect(ok.requests, ok.probe).toBe(1);
	} finally { await h.cleanup(); }
});
