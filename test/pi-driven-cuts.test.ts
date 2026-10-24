import { test, expect } from 'vitest';
import { realpathSync } from 'node:fs';
import { BAND, HOST, ROOM, WINDOW, harness, nonSystem, receiptOf, referenceSystemPart, type Options } from './budget-fixture';

// A cut that Pi starts (the operator's /compact, Pi's own overflow recovery or usage threshold) must reserve what every request carries
// whatever is cut: the system prompt and tools, and the host input. Before this, the planner reserved the host input alone, so a cut
// could be admitted that the complete-context guard then rejected. The system prompt here is 12,052 tokens and the host input 6,000.
// Pi's system prompt carries the session directory, so its size follows the length of $TMPDIR. SYSTEM is pinned for a session directory
// of REFERENCE_DIR characters (a 48-character $TMPDIR, a slash, 'pi-host-input-' and the 6-character mkdtemp suffix). Each run pins that
// the prompt with its real directory swapped for a placeholder of that length measures SYSTEM, and uses its own measure for the receipts.
const SYSTEM = 12052, REFERENCE_DIR = 69;

/** The run's real system part, after pinning that nothing but the session directory's length moved it away from SYSTEM. */
function pinnedSystem(h: Awaited<ReturnType<typeof harness>>) {
 const prompt = h.session.systemPrompt;
 const toolsJson = JSON.stringify(h.extension().getAllTools().filter(t => h.extension().getActiveTools().includes(t.name)).map(t => ({ name: t.name, description: t.description, parameters: t.parameters })));
 // Pi may show the directory as given or resolved (/var against /private/var): replace whichever form appears, longest first.
 const forms = [...new Set([h.dir, realpathSync(h.dir)])].filter(form => prompt.includes(form)).sort((a, b) => b.length - a.length);
 expect(forms.length, 'the session directory appears in the system prompt').toBeGreaterThan(0);
 const normalised = forms.reduce((text, form) => text.split(form).join('x'.repeat(REFERENCE_DIR)), prompt);
 expect(referenceSystemPart(h.saved(), normalised, toolsJson)).toBe(SYSTEM);
 return referenceSystemPart(h.saved(), prompt, toolsJson);
}

/** `scenario`, with the run's system part pinned and returned (and MANDATORY, the system part and the host input). */
async function scenario(options: Options) {
 const h = await harness(options);
 try { const system = pinnedSystem(h); return { ...await h.run(), MANDATORY: system + HOST }; } finally { await h.cleanup(); }
}

// The latest user input is protected from a manual cut (it stays native), so a large one leaves only a little room above it.
async function manual(latest: number) {
 const h = await harness({ at: 'prompt', complete: 60000, host: HOST });
 try {
  h.manager.appendMessage({ role: 'user', content: 'q'.repeat(4 * latest), timestamp: 0 });
  const system = pinnedSystem(h);
  let outcome = 'compacted';
  try { await h.session.compact(); } catch (error) { outcome = String(error); }
  // The conversation after a committed cut, counted independently by Pi's own functions: what the planner said it would be.
  return { MANDATORY: system + HOST, outcome, entries: h.compactions().map(receiptOf), faults: [...h.faults], notices: [...h.notices], conversation: nonSystem(h.saved()) };
 } finally { await h.cleanup(); }
}

test('an operator cut reserves the system part and the host input, and takes the room plan when it already lands below the band', async () => {
 const r = await manual(100000);
 const probe = JSON.stringify(r);
 expect(r.outcome, probe).toBe('compacted');
 expect(r.entries, probe).toHaveLength(1);
 const entry = r.entries[0]!;
 expect(entry.reason, probe).toBe('manual');
 expect(entry.mandatoryInputTokens, probe).toBe(r.MANDATORY);
 expect(entry.hostInputTokens, probe).toBe(HOST);
 expect(entry.target, probe).toBe('room');
 expect(entry.tokensAfter + r.MANDATORY, probe).toBeLessThan(BAND);
 expect(entry.tokensAfter, probe).toBe(r.conversation);
 expect(entry.draftReservedTokens, probe).toBe(WINDOW - ROOM + r.MANDATORY);
 expect(r.faults, probe).toEqual([]);
});

test('an operator cut with no band plan falls back to the room plan', async () => {
 const r = await manual(123000);
 const probe = JSON.stringify(r);
 expect(r.outcome, probe).toBe('compacted');
 const entry = r.entries[0]!;
 expect(entry.target, probe).toBe('room');
 expect(entry.tokensAfter + r.MANDATORY, probe).toBeGreaterThanOrEqual(BAND);
 expect(entry.tokensAfter + r.MANDATORY, probe).toBeLessThan(ROOM);
 expect(entry.tokensAfter, probe).toBe(r.conversation);
 expect(entry.draftReservedTokens, probe).toBe(WINDOW - ROOM + r.MANDATORY);
 expect(r.faults, probe).toEqual([]);
});

test('an operator cut that would leave a request the guard must reject is refused without a fault, and commits nothing', async () => {
 // The latest input and the system part together leave no room. The old reserve (the host input alone) admitted this cut, and the
 // conversation after it plus the system part and the host input is over the room: a committed cut that cannot help any request.
 const r = await manual(126000);
 const probe = JSON.stringify(r);
 expect(r.outcome, probe).toBe('Error: Compaction cancelled');
 expect(r.entries, probe).toEqual([]);
 expect(r.notices.join(' '), probe).toContain("pi-tuck's mandatory context cannot fit or reduce the request budget");
 // A refused operator cut is a notice, not a fault.
 expect(r.faults, probe).toEqual([]);
});

test("Pi's overflow recovery reserves the system part and the host input too, and the retry passes the guard", async () => {
 // The provider says the input exceeds its window. Pi drops the failed reply, cuts through the compactor, and retries once. The request
 // is a protected prompt of 122,000 tokens plus a little history: only the room, not the band, can be reached.
 const r = await scenario({ at: 'prompt', complete: BAND + 2000, host: HOST, history: 1500, replies: ['overflow'] });
 const probe = r.probe;
 expect(r.faults, probe).toEqual([]);
 expect(r.requests, probe).toBe(2);
 expect(r.cuts, probe).toBe(1);
 const entry = receiptOf(r.entries[0]!);
 expect(entry.reason, probe).toBe('overflow');
 expect(entry.mandatoryInputTokens, probe).toBe(r.MANDATORY);
 expect(entry.hostInputTokens, probe).toBe(HOST);
 expect(entry.target, probe).toBe('room');
 expect(entry.tokensAfter + r.MANDATORY, probe).toBeGreaterThanOrEqual(BAND);
 expect(entry.tokensAfter + r.MANDATORY, probe).toBeLessThan(ROOM);
 expect(entry.draftReservedTokens, probe).toBe(WINDOW - ROOM + r.MANDATORY);
 expect(r.guard.at(-1)!, probe).toBeLessThan(ROOM);
});

test("Pi's usage threshold cut reserves the system part and the host input too", async () => {
 // The reply reports 250,000 input tokens, above Pi's own threshold (window less 32,768). Pi cuts after the reply, through the compactor.
 const r = await scenario({ at: 'prompt', complete: 60000, host: HOST, usageFirst: 250000 });
 const probe = r.probe;
 expect(r.faults, probe).toEqual([]);
 expect(r.cuts, probe).toBe(1);
 const entry = receiptOf(r.entries[0]!);
 expect(entry.reason, probe).toBe('threshold');
 expect(entry.mandatoryInputTokens, probe).toBe(r.MANDATORY);
 expect(entry.target, probe).toBe('room');
 // The reply reported far more input than estimated, so the calibration factor is 250,000 over the estimate of the request that was sent;
 // the planner reserves on that factor, like every other consumer.
 expect(entry.calibrationFactor, probe).toBe(250000 / r.guard[0]!);
 expect(entry.draftReservedTokens, probe).toBe(WINDOW - Math.floor(ROOM / entry.calibrationFactor!) + r.MANDATORY);
});
