import { test, expect, vi } from 'vitest';
import { HOST, ROOM, harness } from './budget-fixture';

// A refusal that is not for want of room: the draft reports a structural reason (here the one tuck.ts gives when nothing can be cut away
// before a current input that must stay native), which carries no `capacityRejected`. The compactor refuses the run all the same, and the
// refusal is as much a verdict on that attempt as the one for want of room: the next run decides afresh. Before, it was held until the
// session restarted: every later prompt was aborted before its first request, with the old message, however much room there was.
const REASON = 'No reducible history before the current user input';
const draft = vi.hoisted(() => ({ structural: false }));
vi.mock('../src/tuck', async importOriginal => {
	const real = await importOriginal<typeof import('../src/tuck')>();
	return { ...real,
		tuckDraft: (...args: Parameters<typeof real.tuckDraft>) => draft.structural ? { unavailable: REASON } : real.tuckDraft(...args),
		tuckObservedDraft: (...args: Parameters<typeof real.tuckObservedDraft>) => draft.structural ? { unavailable: REASON } : real.tuckObservedDraft(...args) };
});

for (const trigger of ['a prompt', 'a custom message that triggers a turn'] as const)
	test(`a structural refusal of the cut is not held against the next run: ${trigger}`, async () => {
		// The request is over the room, so a cut is due; the draft cannot make one.
		const h = await harness({ at: 'prompt', complete: ROOM + 3000, host: HOST });
		try {
			draft.structural = true;
			const first = await h.run();
			expect(first.faults.join(' '), first.probe).toContain(REASON);
			expect(first.requests, first.probe).toBe(0);
			expect(first.aborts, first.probe).toBeGreaterThan(0);
			// The user changes to a model with a window the request fits without a cut.
			draft.structural = false;
			(h.session.model as { contextWindow: number }).contextWindow = 1_000_000;
			const aborts = h.state.aborts, faults = h.faults.length, requests = h.state.requests;
			if (trigger === 'a prompt') await h.session.prompt('Continue after the cause is gone');
			else await h.session.sendCustomMessage({ customType: 'report', content: 'A report that starts a turn', display: false }, { triggerTurn: true });
			expect(h.faults.slice(faults), first.probe).toEqual([]);
			expect(h.state.aborts - aborts, first.probe).toBe(0);
			expect(h.state.requests - requests, first.probe).toBeGreaterThan(0);
			expect((h.session.messages.at(-1) as { stopReason?: string }).stopReason, first.probe).toBe('stop');
		} finally { draft.structural = false; await h.cleanup(); }
	}, 120000);
