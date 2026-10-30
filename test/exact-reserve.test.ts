import { test, expect, vi } from 'vitest';
import { SettingsManager, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { installCompaction, type CompactionOptions } from '../src/compaction';
import { bandOf } from '../src/budget';
import { BAND, BAND_EXACT, EXACT_RESERVE, HOST, ROOM, ROOM_EXACT, WINDOW, expectParity, nonSystem, receiptOf, referenceGuardSystem, scenario } from './budget-fixture';
import { scriptedModelRuntime } from './model-fixture';

// The reply reserve (C1). By default the room is the window less the model's catalogue maximum output (128,000 here), because a
// transport may omit the output cap and the reply can then grow to that maximum. A host that knows its transport declares an exact
// reserve with `responseExact: true`; the room is then the window less that reserve, whatever the catalogue says. Window 272,000.
const PROMPT = 2; // 'Continue'
const AROUND = [-3, -2, -1, 0, 1, 2, 3];
// At the tool boundary the first request must stay below the band, or the prompt would be cut first: the first tool result takes 100,000 of the request.
const TOOL = { fresh: 100000 };

// The guard's room, driven directly: a request is built to an exact measure by Pi's own functions and offered to context_with_system.
async function offered(requestReserve: CompactionOptions['requestReserve'], settingsReserve: number, tokens: number) {
 const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
 const pi = { on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
  registerCommand: () => {}, registerTool: () => {}, getSettings: () => ({}), getAllTools: () => [], getActiveTools: () => [] } as unknown as ExtensionAPI;
 const errors: unknown[] = [];
 const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: true, reserveTokens: settingsReserve, keepRecentTokens: 0 } });
 const handle = await installCompaction(pi, { settings, ...(requestReserve ? { requestReserve } : {}), fail: error => errors.push(error) });
 const runtime = await scriptedModelRuntime(), model = runtime.getModel('openai-codex', 'gpt-6.1-sol')!;
 const ctx = { model, cwd: '/x', abort: vi.fn(), getSystemPrompt: () => 'system', ui: { notify: () => {} }, sessionManager: { getBranch: () => [], getEntries: () => [] } } as unknown as ExtensionContext;
 // A user message whose measure, with the system part, is exactly `tokens` (the estimator is four characters per token, rounded up).
 const messages = [{ role: 'user' as const, content: 'x'.repeat(4 * (tokens - referenceGuardSystem([], 'system'))), timestamp: 0 }];
 expect(referenceGuardSystem(messages, 'system') + nonSystem(messages)).toBe(tokens);
 try { for (const handler of handlers.get('context_with_system') ?? []) await handler({ messages }, ctx); return errors.map(String); }
 finally { await handle.close(); vi.restoreAllMocks(); }
}
const CAPACITY = 'Complete Pi context and response reserve exceed the estimated request budget';

test.each([32768, 200000, 0])('the guard admits up to the window less an exact reserve of %i, whatever the model\'s maximum output, and no further', async response => {
 const exact = () => ({ response, responseExact: true as const });
 for (const d of [-2, -1]) expect(await offered(exact, 0, WINDOW - response + d), `${d}`).toEqual([]);
 for (const d of [0, 1]) expect((await offered(exact, 0, WINDOW - response + d)).join(' '), `${d}`).toContain(CAPACITY);
});

test('without the flag the model\'s maximum output stays the floor of the reserve, as for any other host', async () => {
 const declared = () => ({ response: 32768 });
 for (const d of [-2, -1]) expect(await offered(declared, 0, ROOM + d), `${d}`).toEqual([]);
 for (const d of [0, 1]) expect((await offered(declared, 0, ROOM + d)).join(' '), `${d}`).toContain(CAPACITY);
 expect((await offered(declared, 0, 200000)).join(' ')).toContain(CAPACITY);
 // A host that sets the flag to anything but true is not exact.
 for (const flag of [false, 1, 'true'])
  expect((await offered(() => ({ response: 32768, responseExact: flag as never }), 0, 200000)).join(' '), String(flag)).toContain(CAPACITY);
 // The same for a host that declares nothing: Pi's reserveTokens, never less than the maximum output.
 expect(await offered(undefined, 32768, ROOM - 1)).toEqual([]);
 expect((await offered(undefined, 32768, ROOM)).join(' ')).toContain(CAPACITY);
 expect((await offered(undefined, 32768, 200000)).join(' ')).toContain(CAPACITY);
 // A larger Pi setting than the maximum output is honored.
 expect(await offered(undefined, 200000, WINDOW - 200000 - 1)).toEqual([]);
 expect((await offered(undefined, 200000, WINDOW - 200000)).join(' ')).toContain(CAPACITY);
});

test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])('a reserve of %s is invalid, exact or not', async response => {
 for (const responseExact of [true, undefined]) {
  const errors = await offered(() => ({ response, ...(responseExact ? { responseExact } : {}) }), 0, 20000);
  expect(errors.join(' '), `${response} ${responseExact}`).toContain('Invalid host request reserve');
 }
});

for (const at of ['prompt', 'tool'] as const)
test(`${at} boundary, exact reserve: a cut is triggered from the first token inside the band of the exact room, and the room is the window less 32,768`, async () => {
 const seen: { d: number; cuts: number }[] = [];
 for (const d of AROUND) {
  const r = await scenario({ at, complete: BAND_EXACT + d, ...(at === 'tool' ? TOOL : {}), host: HOST, reserveTokens: 0, compaction: EXACT_RESERVE });
  expect(r.measured!.complete, r.probe).toBe(BAND_EXACT + d);
  expect(r.faults, r.probe).toEqual([]);
  expect(r.requests, r.probe).toBe(at === 'tool' ? 2 : 1);
  for (const guarded of r.guard) expect(guarded, r.probe).toBeLessThan(ROOM_EXACT);
  for (const entry of r.entries) { expect(receiptOf(entry).responseReserveTokens, r.probe).toBe(32768); expect(receiptOf(entry).tokensAfter + receiptOf(entry).mandatoryInputTokens!, r.probe).toBeLessThan(BAND_EXACT); }
  expectParity(r, { host: HOST, incoming: at === 'prompt' ? PROMPT : 0 }, { room: ROOM_EXACT, band: BAND_EXACT });
  seen.push({ d, cuts: r.cuts });
 }
 const probe = JSON.stringify(seen);
 for (const s of seen) expect(s.cuts > 0, probe).toBe(s.d >= 0);
});

for (const at of ['prompt', 'tool'] as const)
test(`${at} boundary, exact reserve: around the exact room the request is cut and sent, never rejected`, async () => {
 for (const d of AROUND) {
  const r = await scenario({ at, complete: ROOM_EXACT + d, ...(at === 'tool' ? TOOL : {}), host: HOST, reserveTokens: 0, compaction: EXACT_RESERVE });
  expect(r.measured!.complete, r.probe).toBe(ROOM_EXACT + d);
  expect(r.faults, r.probe).toEqual([]);
  expect(r.cuts, r.probe).toBe(1);
  expect(r.requests, r.probe).toBe(at === 'tool' ? 2 : 1);
  for (const guarded of r.guard) expect(guarded, r.probe).toBeLessThan(ROOM_EXACT);
  expectParity(r, { host: HOST, incoming: at === 'prompt' ? PROMPT : 0 }, { room: ROOM_EXACT, band: BAND_EXACT });
 }
});

test('the same request, 200,000 estimated tokens, is sent as it stands under an exact reserve and cut first without the flag', async () => {
 const exact = await scenario({ at: 'prompt', complete: 200000, host: HOST, reserveTokens: 0, compaction: EXACT_RESERVE });
 expect(exact.faults, exact.probe).toEqual([]);
 expect(exact.cuts, exact.probe).toBe(0);
 expect(exact.requests, exact.probe).toBe(1);
 expect(exact.guard[0], exact.probe).toBe(200000);
 // A host that declares 32,768 without the flag has the catalogue maximum as the floor: its room is 144,000.
 const floored = await scenario({ at: 'prompt', complete: 200000, host: HOST });
 expect(floored.faults, floored.probe).toEqual([]);
 expect(floored.cuts, floored.probe).toBe(1);
 expect(receiptOf(floored.entries[0]!).responseReserveTokens, floored.probe).toBe(128000);
 for (const guarded of floored.guard) expect(guarded, floored.probe).toBeLessThan(ROOM);
 expectParity(floored, { host: HOST, incoming: PROMPT }, { room: ROOM, band: BAND });
});

test('an exact reserve larger than the floor shrinks the room, and a cut keeps the request inside it', async () => {
 // Response 200,000 leaves a room of 72,000. The planner reserves what it declares, so the cut lands inside that room.
 const room = WINDOW - 200000, band = bandOf(room);
 const compaction = { requestReserve: () => ({ response: 200000, responseExact: true as const }) };
 for (const [d, cuts] of [[-1, 0], [0, 1]] as const) {
  const r = await scenario({ at: 'prompt', complete: band + d, host: HOST, reserveTokens: 0, compaction });
  expect(r.faults, r.probe).toEqual([]);
  expect(r.cuts, r.probe).toBe(cuts);
  for (const guarded of r.guard) expect(guarded, r.probe).toBeLessThan(room);
  for (const entry of r.entries) expect(receiptOf(entry).responseReserveTokens, r.probe).toBe(200000);
 }
});

// A host can set Pi's `compaction.reserveTokens` to 0, which puts Pi's usage threshold at the whole window. threshold-gate.test.ts covers
// what the compactor does when Pi asks anyway.
test('reserveTokens 0 survives Pi\'s settings unchanged', async () => {
 const runtime = await scriptedModelRuntime(), model = runtime.getModel('openai-codex', 'gpt-6.1-sol')!;
 expect(SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 0 } }).getCompactionSettings(model)).toMatchObject({ enabled: true, reserveTokens: 0 });
});

test('silent overflow (usage above the window on a completed reply) compacts only when the real input exceeds the whole window: within it nothing happens', async () => {
 // Pi's isContextOverflow case 2: a reply with stopReason "stop" whose input plus cache reads exceed the context window.
 for (const usage of [WINDOW - 1, WINDOW]) {
  const r = await scenario({ at: 'prompt', complete: 60000, host: HOST, reserveTokens: 0, compaction: EXACT_RESERVE, usageFirst: usage });
  expect(r.faults, r.probe).toEqual([]);
  expect(r.cuts, `usage ${usage}: ${r.probe}`).toBe(0);
  expect(r.requests, r.probe).toBe(1);
 }
 // Beyond the window Pi compacts through the package with reason "overflow" and does not retry the completed reply.
 const beyond = await scenario({ at: 'prompt', complete: 60000, host: HOST, reserveTokens: 0, compaction: EXACT_RESERVE, usageFirst: WINDOW + 1 });
 expect(beyond.faults, beyond.probe).toEqual([]);
 expect(beyond.entries.map(e => receiptOf(e).reason), beyond.probe).toEqual(['overflow']);
 expect(beyond.requests, beyond.probe).toBe(1);
});

