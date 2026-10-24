import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, expect, vi } from 'vitest';
import { SettingsManager, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { installCompaction } from '../src/compaction';
import { BAND_EXACT, EXACT_RESERVE, HOST, ROOM_EXACT, WINDOW, expectParity, harness, receiptOf, scenario } from './budget-fixture';

// Pi's own recovery for a provider overflow error and for a recoverable length stop (a length stop whose output is below the model's
// maximum): it omits the failed reply, compacts with reason "overflow" through the package's session_before_compact, and retries once
// (agent-session.js _checkCompaction, _overflowRecoveryAttempted). If the retry fails the same way, Pi reports the used-up recovery as a
// failed "overflow" compaction that was neither aborted nor supplied by an extension, and the run ends with the provider's own message.
// That is not a compactor failure: the package must not call fail() (no latch) and must not abort (an abort would end the run as aborted
// and hide the provider's message from the host). AB1 declares the exact 32,768 reply reserve, so these paths are reachable there.
// Window 272,000 less the exact reserve leaves a room of 239,232.
const base = { at: 'prompt' as const, complete: 60000, host: HOST, reserveTokens: 0, compaction: EXACT_RESERVE };

for (const kind of ['length', 'overflow'] as const)
test(`a recoverable ${kind === 'length' ? 'length stop' : 'provider overflow'}: Pi compacts through the package with the system part reserved, retries once, and the retry succeeds`, async () => {
 const r = await scenario({ ...base, replies: [kind] });
 const probe = r.probe;
 expect(r.faults, probe).toEqual([]);
 expect(r.aborts, probe).toBe(0);
 expect(r.requests, probe).toBe(2);
 expect(r.cuts, probe).toBe(1);
 const entry = receiptOf(r.entries[0]!);
 expect(entry.reason, probe).toBe('overflow');
 expect(entry.responseReserveTokens, probe).toBe(32768);
 expect(entry.target, probe).toBe('room');
 expect(entry.calibrationFactor, probe).toBe(1);
 // The system part and the host input are charged (draft reserved, cut arithmetic, the retry as the guard counts it).
 expectParity(r, { host: HOST }, { room: ROOM_EXACT, band: BAND_EXACT });
 expect(entry.tokensAfter + r.system + HOST, probe).toBeLessThan(ROOM_EXACT);
 expect(r.guard.at(-1)!, probe).toBeLessThan(ROOM_EXACT);
 expect(r.last, probe).toMatchObject({ stopReason: 'stop' });
});

for (const kind of ['length', 'overflow'] as const)
test(`recovery at the edge of the larger room: a ${kind === 'length' ? 'length stop' : 'provider overflow'} on a request just below the band (${BAND_EXACT - 20} estimated tokens) is cut through the package and retried`, async () => {
 const r = await scenario({ ...base, complete: BAND_EXACT - 20, replies: [kind] });
 const probe = r.probe;
 expect(r.measured!.complete, probe).toBe(BAND_EXACT - 20);
 expect(r.faults, probe).toEqual([]);
 expect(r.aborts, probe).toBe(0);
 expect(r.requests, probe).toBe(2);
 expect(r.cuts, probe).toBe(1);
 const entry = receiptOf(r.entries[0]!);
 expect(entry.reason, probe).toBe('overflow');
 expect(entry.target, probe).toBe('room');
 // The recovery cut charges the system part and the host input exactly as the 239,232 room's other cuts do, and lands below the band. A provider
 // overflow also taught the factor: the request exceeded the window by at least a token, so the planner reserved on (window + 1) over the estimate.
 // The package's message_end runs before Pi's recovery check; were it the other way, the receipt would show the factor 1 the request was counted with.
 // (The 60,000-token request above, whose bound exceeds CALIBRATION_CEILING, is not learned: its receipt keeps factor 1.)
 const factor = kind === 'overflow' ? (WINDOW + 1) / r.guard[0]! : 1;
 expect(entry.calibrationFactor, probe).toBe(factor);
 expectParity(r, { host: HOST }, { room: ROOM_EXACT, band: BAND_EXACT }, factor);
 expect(entry.tokensAfter + r.system + HOST, probe).toBeLessThan(BAND_EXACT);
 for (const guarded of r.guard) expect(guarded, probe).toBeLessThan(ROOM_EXACT);
 expect(r.last, probe).toMatchObject({ stopReason: 'stop' });
});

for (const kind of ['length', 'overflow'] as const)
test(`a second consecutive ${kind === 'length' ? 'length stop' : 'provider overflow'} ends the run with that message: no fail(), no abort, no latch in the package`, async () => {
 const h = await harness({ ...base, replies: [kind, kind] });
 try {
  const r = await h.run();
  const probe = r.probe;
  // One compaction and one retry; then Pi reports the used-up recovery and stops.
  expect(r.requests, probe).toBe(2);
  expect(r.cuts, probe).toBe(1);
  expect(r.faults, probe).toEqual([]);
  expect(r.aborts, probe).toBe(0);
  // The session's last assistant message is the provider's own, not an aborted one.
  if (kind === 'length') expect(r.last, probe).toMatchObject({ stopReason: 'length' });
  else expect(r.last, probe).toMatchObject({ stopReason: 'error', errorMessage: expect.stringContaining('exceeds the context window') });
  expect(r.last!.stopReason, probe).not.toBe('aborted');
  // The package did not latch a failure: the next prompt on the same session is admitted and answered.
  await h.session.prompt('Continue after the stop');
  expect(h.faults).toEqual([]);
  expect(h.state.requests).toBe(3);
  expect(h.state.aborts).toBe(0);
  expect(h.session.messages.findLast(m => m.role === 'assistant')).toMatchObject({ stopReason: 'stop' });
 } finally { await h.cleanup(); }
});

test('a failure after the package supplied the cut (the commit throws) still fails the attempt and aborts', async () => {
 const h = await harness({ ...base, replies: ['overflow'] });
 try {
  // Pi reports this as an "overflow" failure too, but fromExtension is true: the compactor was consulted, and what it proposed did not commit.
  vi.spyOn(h.manager, 'appendCompaction').mockImplementationOnce(() => { throw new Error('commit refused'); });
  const r = await h.run();
  const probe = r.probe;
  expect(r.faults.join(' '), probe).toContain('Context overflow recovery failed: commit refused');
  expect(r.aborts, probe).toBe(1);
  expect(r.cuts, probe).toBe(0);
 } finally { vi.restoreAllMocks(); await h.cleanup(); }
});

// The event fields alone decide. The handlers are driven directly so that every combination, and any text, can be offered.
async function installed(diagnostics?: { directory: string }) {
 const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
 const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
 const pi = { on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
  registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => unknown }) => { commands.set(name, command.handler); },
  registerTool: () => {}, getSettings: () => ({}), getAllTools: () => [], getActiveTools: () => [] } as unknown as ExtensionAPI;
 const errors: unknown[] = [], notices: string[] = [], abort = vi.fn();
 const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 } });
 const handle = await installCompaction(pi, { settings, ...EXACT_RESERVE, ...(diagnostics ? { diagnostics } : {}), fail: error => errors.push(error) });
 const ctx = { model: { provider: 'p', api: 'a', id: 'm', contextWindow: WINDOW, maxTokens: 128000 }, cwd: '/x', abort, getSystemPrompt: () => 'system', ui: { notify: (message: string) => { notices.push(message); } } } as unknown as ExtensionContext;
 return {
  errors, notices, aborts: () => abort.mock.calls.length, close: () => handle.close(),
  emit: async (name: string, event: unknown) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); },
  command: async (name: string, args: string) => { await commands.get(name)!(args, ctx); },
 };
}
async function driven(event: Record<string, unknown>) {
 const h = await installed();
 try { await h.emit('session_compact_failed', event); return { errors: h.errors, aborts: h.aborts() }; }
 finally { await h.close(); }
}
const EXHAUSTED = 'Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.';
const TRUNCATED = 'Truncated response recovery failed after one compact-and-retry attempt.';
const failed = (reason: string, errorMessage: string | undefined, over: { aborted?: boolean; fromExtension?: boolean } = {}) =>
 ({ reason, errorMessage, aborted: false, willRetry: false, fromExtension: false, ...over });
const CASES: { name: string; event: Record<string, unknown>; fails: boolean }[] = [
 { name: 'overflow, not aborted, not from an extension: Pi\'s used-up overflow recovery', event: failed('overflow', EXHAUSTED), fails: false },
 { name: 'overflow, not aborted, not from an extension: Pi\'s used-up truncated-response recovery', event: failed('overflow', TRUNCATED), fails: false },
 { name: 'the same fields with any other text are the same case (never keyed on the message)', event: failed('overflow', 'Something else entirely'), fails: false },
 { name: 'overflow, aborted: not a failure (cancelled)', event: failed('overflow', undefined, { aborted: true }), fails: false },
 { name: 'overflow after the extension supplied the cut (fromExtension) is a failure, whatever the text says', event: failed('overflow', EXHAUSTED, { fromExtension: true }), fails: true },
 { name: 'a threshold failure is still a failure, even with the used-up text', event: failed('threshold', EXHAUSTED), fails: true },
 { name: 'a manual failure with the used-up text', event: failed('manual', EXHAUSTED), fails: true },
];
for (const c of CASES)
test(`session_compact_failed is classified by its fields: ${c.name}`, async () => {
 const r = await driven(c.event);
 if (c.fails) { expect(r.errors).toHaveLength(1); expect(r.aborts).toBe(1); }
 else { expect(r.errors).toEqual([]); expect(r.aborts).toBe(0); }
});

test('a failure that is already latched stays latched when the exhausted-recovery event arrives: no second failure, no abort, and the latch holds', async () => {
 const h = await installed();
 try {
  await h.emit('session_compact_failed', failed('threshold', 'Auto-compaction failed: refused'));
  expect(h.errors).toHaveLength(1);
  expect(h.aborts()).toBe(1);
  await h.emit('session_compact_failed', failed('overflow', EXHAUSTED));
  expect(h.errors).toHaveLength(1);
  expect(h.aborts()).toBe(1);
  // The next request is still refused with the very failure that was latched; a skip that cleared it would let this request through.
  await h.emit('context_with_system', { messages: [{ role: 'user', content: 'hello', timestamp: 0 }] });
  expect(h.errors).toHaveLength(2);
  expect(String(h.errors[1])).toContain('Auto-compaction failed: refused');
 } finally { await h.close(); }
});

// An operator's incident recording ends with a label that says what ended it: the used-up recovery is not a failed cut.
for (const c of [
 { name: 'the used-up recovery', event: failed('overflow', EXHAUSTED), state: 'pi-recovery-exhausted' },
 { name: 'a failure after the compactor supplied the cut', event: failed('overflow', 'Context overflow recovery failed: commit refused', { fromExtension: true }), state: 'cut-failed' },
 { name: 'a cancelled cut', event: failed('overflow', undefined, { aborted: true }), state: 'cut-cancelled' },
])
test(`the incident recorder is stopped with its own reason: ${c.name} -> ${c.state}`, async () => {
 const directory = mkdtempSync(join(tmpdir(), 'pi-recorder-'));
 const h = await installed({ directory });
 try {
  await h.command('compaction-incident', 'on');
  await h.emit('session_compact_failed', c.event);
  expect(h.notices).toContain('Compaction incident: ' + c.state);
  await h.command('compaction-incident', 'status');
  expect(JSON.parse(h.notices.at(-1)!).state).toBe(c.state);
 } finally { await h.close(); await new Promise(resolve => setTimeout(resolve, 100)); rmSync(directory, { recursive: true, force: true }); }
});

test('a threshold ask the compactor declined (cancelled, not from an extension) leaves a running incident recording running; a cancelled cut of its own still ends it', async () => {
 const directory = mkdtempSync(join(tmpdir(), 'pi-recorder-'));
 const h = await installed({ directory });
 try {
  await h.command('compaction-incident', 'on');
  await h.emit('session_compact_failed', failed('threshold', undefined, { aborted: true }));
  await h.command('compaction-incident', 'status');
  expect(JSON.parse(h.notices.at(-1)!).state).toBe('recording');
  await h.emit('session_compact_failed', failed('threshold', undefined, { aborted: true, fromExtension: true }));
  expect(h.notices).toContain('Compaction incident: cut-cancelled');
 } finally { await h.close(); await new Promise(resolve => setTimeout(resolve, 100)); rmSync(directory, { recursive: true, force: true }); }
});
