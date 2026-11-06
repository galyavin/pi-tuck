import { test, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BAND, HOST, ROOM, harness, scenario } from './budget-fixture';

const GUARD = 'Complete Pi context and response reserve exceed the estimated request budget';

// A prompt's cut is decided on one snapshot. Host input that grows after the decision (attempt effects are recorded in it) is the
// complete-context guard's: it counts the whole request with the cut applied and fails closed when the request does not fit the room.
test('host input that grew after the prompt\'s cut was decided: a request that no longer fits fails closed at the guard', async () => {
	const h = await harness({ at: 'prompt', complete: ROOM + 500, host: HOST, afterDecision: (i, api) => { if (i === 0) api.growHost(ROOM); } });
	try {
		const r = await h.run();
		expect(r.faults.join(' | '), r.probe).toContain(GUARD);
		expect(r.requests, r.probe).toBe(0);
		// The run made no request, so no boundary saved the cut.
		expect(r.cuts, r.probe).toBe(0);
		expect(h.notices.join(' '), r.probe).toContain("lower Pi's compaction.reserveTokens"); // over the room: the capacity error
	} finally { await h.cleanup(); }
});

test('host input that grew after the prompt\'s cut was decided but still fits: the request is sent with the cut, which its run saves', async () => {
	const h = await harness({ at: 'prompt', complete: ROOM + 500, host: HOST, afterDecision: (i, api) => { if (i === 0) api.growHost(500); } });
	try {
		const r = await h.run();
		expect(r.faults, r.probe).toEqual([]);
		expect(r.requests, r.probe).toBe(1);
		expect(r.cuts, r.probe).toBe(1);
		expect(r.guard[0]!, r.probe).toBeLessThan(BAND);
	} finally { await h.cleanup(); }
});

// An opportunistic cut that the planner declines is no event for the incident recorder: it must not stop an operator's recording as a
// cancelled or failed cut.
for (const why of ['the planner declines it'] as const)
test(`an opportunistic cut that cannot be made leaves the incident recorder recording: ${why}`, async () => {
	const directory = mkdtempSync(join(tmpdir(), 'pi-incident-'));
	const diagnostics = { directory };
	// Declined: an irreducible request inside the band, so nothing can bring it under the band.
	const h = await harness({ at: 'tool', complete: BAND + 2000, host: HOST, history: 1500, fresh: 100, compaction: { diagnostics } });
	try {
		await h.session.prompt('/tuck-incident on');
		await h.session.prompt('/tuck-incident status');
		expect(JSON.parse(h.notices.at(-1)!).state, h.notices.join('\n')).toBe('recording');
		const r = await h.run();
		expect(r.cuts, r.probe).toBe(0);
		expect(r.faults, r.probe).toEqual([]);
		expect(r.requests, r.probe).toBe(2);
		// A run-end cut that is made after the declined one is captured like any cut, and may fill the recording.
		await h.session.prompt('/tuck-incident status');
		const state = JSON.parse(h.notices.at(-1)!).state;
		if (r.runEnd.length) expect(state, h.notices.join('\n')).not.toMatch(/^cut-/); else expect(state, h.notices.join('\n')).toBe('recording');
	} finally { await h.cleanup(); rmSync(directory, { recursive: true, force: true }); }
});

// A prompt's cut is pi-tuck's own, as a tool boundary's is: another extension's session_before_compact policy is for the cuts Pi asks for
// (an operator's /compact, Pi's threshold and overflow recovery), and it does not stop the cut a request needs.
for (const [name, complete] of [['opportunistic', BAND + 100], ['due', ROOM + 500]] as const)
test(`an earlier handler that cancels every cut Pi asks for does not stop a prompt's own cut: ${name}`, async () => {
	const r = await scenario({ at: 'prompt', complete, host: HOST, cancelCompact: true });
	expect(r.faults, r.probe).toEqual([]);
	expect(r.cuts, r.probe).toBe(1);
	expect(r.requests, r.probe).toBe(1);
	expect(r.guard[0]!, r.probe).toBeLessThan(ROOM);
});

test('a planner exception inside an opportunistic cut is still a fault: a latched failure is not swallowed', async () => {
	let manager: { getHeader: () => unknown } | undefined;
	// The planner needs the native session header; at the first read after the prompt arrives it is gone, and the draft throws (an invariant
	// break, not a decision). Pi's own later reads see the header again.
	const h = await harness({ at: 'prompt', complete: BAND + 100, host: HOST, onPrompt: () => { const real = manager!.getHeader.bind(manager); let missing = true; manager!.getHeader = () => (missing ? (missing = false, null) : real()); } });
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
// A prompt's cut is saved at its run's first boundary, after the request that carried it.
test('an opportunistic cut the compactor proposed and Pi then fails to commit is a fault: nothing swallows it', async () => {
	const h = await harness({ at: 'prompt', complete: BAND + 100, host: HOST });
	try {
		const manager = h.manager as unknown as { _persist: (entry: { type: string }) => void };
		const persist = manager._persist.bind(manager);
		manager._persist = (entry) => { if (entry.type === 'compaction') throw new Error('ENOSPC: no space left on device'); persist(entry); };
		const r = await h.run();
		expect(r.faults.join(' | '), r.probe).toContain('boundary draft remained unconfirmed');
		// Control: the very same run with a working disk cuts and sends the request.
		const ok = await scenario({ at: 'prompt', complete: BAND + 100, host: HOST });
		expect(ok.faults, ok.probe).toEqual([]);
		expect(ok.cuts, ok.probe).toBe(1);
		expect(ok.requests, ok.probe).toBe(1);
	} finally { await h.cleanup(); }
});

// Every refusal says why. A refusal that is not about capacity used to end its attempt with no word (eval live32 t03-J task 24: 0.02 s, no
// token, no notice), which looked like a hang.
test('a refusal that is not about capacity tells the user its reason', async () => {
	let manager: { getHeader: () => unknown } | undefined;
	const h = await harness({ at: 'prompt', complete: BAND + 100, host: HOST, onPrompt: () => { const real = manager!.getHeader.bind(manager); let missing = true; manager!.getHeader = () => (missing ? (missing = false, null) : real()); } });
	manager = h.manager as unknown as typeof manager;
	try {
		const r = await h.run();
		expect(r.requests, r.probe).toBe(0);
		expect(h.notices.join(' '), r.probe).toContain('pi-tuck could not plan this request (Missing native session header');
		expect(h.notices.join(' '), r.probe).not.toContain("lower Pi's compaction.reserveTokens");
	} finally { await h.cleanup(); }
});
