import { expect, test } from 'vitest';
import { BAND, HOST, ROOM, harness } from './budget-fixture';

// No failure carries over to the next prompt: each one ends with its attempt, and the next prompt plans afresh from the session as it is.
// Twice a single failure left a session unusable for good (an aborted reply that made an old result look unseen; Pi's "nothing to compact"
// passed on as a latched fault). Each case forces a failure at one refusal or throw site, then sends a prompt that fits: it must be planned
// and answered. small-room.test.ts does the same for the tool-loop refusal and the complete-context guard.
const sites: Record<string, { options: Parameters<typeof harness>[0]; invalidReserve?: true; prompt?: string; fault: string }> = {
	'the incoming prompt alone exceeds the room': { options: { at: 'prompt', complete: 20000, host: HOST }, prompt: 'q'.repeat((ROOM + 1000) * 4), fault: 'Incoming Pi prompt and response reserve cannot fit' },
	'a needed cut that Pi has nothing to make': { options: { at: 'prompt', complete: ROOM + 500, host: HOST, compactedLast: true }, fault: 'Already compacted' },
	// The planner's first read of the native session header after the first cut is asked for finds none, and the draft throws.
	'the planner throws': { options: { at: 'prompt', complete: BAND + 100, host: HOST, onBeforeCompact: (() => { let armed = true; return (_event, ctx) => {
		if (!armed) return; armed = false;
		const manager = ctx.sessionManager as unknown as { getHeader: () => unknown }, real = manager.getHeader.bind(manager);
		let missing = true; manager.getHeader = () => (missing ? (missing = false, null) : real()); }; })() }, fault: 'Missing native session header' },
	'the host reports an invalid reserve': { options: { at: 'prompt', complete: 20000, host: HOST }, invalidReserve: true, fault: 'Invalid host request reserve' },
};
for (const [name, site] of Object.entries(sites))
	test(`after a failure (${name}) the next prompt is planned afresh and answered`, async () => {
		let invalid = Boolean(site.invalidReserve);
		const h = await harness({ ...site.options, compaction: { requestReserve: () => invalid ? { response: -1 } : { response: 32768 } } });
		try {
			if (site.prompt) await h.session.prompt(site.prompt); else await h.run();
			expect(h.faults.join(' | ')).toContain(site.fault);
			invalid = false;
			const faults = h.faults.length, requests = h.state.requests;
			await h.session.prompt('A short prompt');
			expect(h.faults.slice(faults)).toEqual([]);
			expect(h.state.requests - requests).toBe(1);
			expect((h.session.messages.at(-1) as { stopReason?: string }).stopReason).toBe('stop');
		} finally { await h.cleanup(); }
	}, 120000);

// The one exception: a cut this compactor supplied that Pi failed to commit. The session holds a cut its file lacks, and what is written after
// would build on it, so the failure stays until the session restarts.
test('a cut Pi failed to commit stays a fault for the next prompt', async () => {
	const h = await harness({ at: 'prompt', complete: BAND + 100, host: HOST });
	try {
		const manager = h.manager as unknown as { _persist: (entry: { type: string }) => void };
		const persist = manager._persist.bind(manager);
		manager._persist = entry => { if (entry.type === 'compaction') throw new Error('ENOSPC: no space left on device'); persist(entry); };
		await h.run();
		expect(h.faults.join(' | ')).toContain('Compaction failed: ENOSPC');
		const requests = h.state.requests;
		await h.session.prompt('A short prompt');
		expect(h.state.requests - requests, JSON.stringify(h.faults)).toBe(0);
		expect(h.faults.at(-1)).toContain('Compaction failed: ENOSPC');
	} finally { await h.cleanup(); }
}, 120000);
