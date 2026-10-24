import { randomUUID } from 'node:crypto';
import { expect, vi } from 'vitest';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { SessionManager, SettingsManager, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { installCompaction, type CompactionOptions } from '../src/compaction';
import { serializeTranscript } from '../src/pi-tuck/core/transcript';
import { SUMMARY_SUFFIX } from '../src/pi-tuck/core/format';
import { EXACT_RESERVE, ROOM_EXACT, WINDOW, referenceGuardSystem } from './budget-fixture';
import { scriptedModelRuntime } from './model-fixture';

// The calibration factor, observed from outside: through the complete-context guard, which admits a request of T estimated tokens exactly when
// ceil(T x factor) is below the room. A factor is read off by two probes on either side of the largest request it admits. A rejection latches the
// compactor's failure, so each probe is a fresh installation that replays the same preparation.
export const MODEL = (await scriptedModelRuntime()).getModel('openai-codex', 'gpt-6.1-sol')!;
/** The accounting identity of MODEL: the key the compactor binds its factor to. */
export const KEY = JSON.stringify([MODEL.provider, MODEL.api, MODEL.id]);
export const CAPACITY = 'Complete Pi context and response reserve exceed the estimated request budget';

/** The largest request, in the guard's estimated tokens, that the exact room admits at calibration factor f. */
export function edge(f: number) {
 let t = Math.ceil(ROOM_EXACT / f);
 while (Math.ceil(t * f) >= ROOM_EXACT) t--;
 return t;
}

/** The details of a compaction entry as this compactor writes them, with a receipt whose settings are as given. */
export function receipted(settings: Record<string, unknown>) {
 return { compactor: 'pi-tuck', version: 2, adapter: 'standalone', keptUserTurns: 0,
  diagnosticReceipt: { id: randomUUID(), build: 'any-build', reason: 'tool-loop', selectedView: 'view', boundary: 'entry', settings: { draftReservedTokens: 0, contextWindow: WINDOW, ...settings } } };
}
/** A valid current-schema receipt for the factor, under the identity (default: MODEL's). */
export const stamp = (calibrationFactor: unknown, calibrationIdentity: unknown = KEY) => receipted({ calibrationFactor, calibrationIdentity });
/** A receipt as this compactor writes it now: the window beside the factor (default: the window's maximum, at least 1), under the identity (default: MODEL's). */
export const stampWindow = (calibrationWindow: unknown, calibrationIdentity: unknown = KEY, calibrationFactor: unknown = Array.isArray(calibrationWindow) ? Math.max(1, ...calibrationWindow) : 1) =>
 receipted({ calibrationFactor, calibrationIdentity, calibrationWindow });
/** Where a compaction entry's summary format is this compactor's own. */
export const SUMMARY = serializeTranscript([{ kind: 'omission', reason: 'Earlier work, summarized.' }]) + SUMMARY_SUFFIX;

const user = { role: 'user' as const, content: 'Opening task', timestamp: 0 };
/** A session whose branch holds, in order, the given compaction details (a `null` is a foreign entry: Pi's own shape, no receipt). */
export function sessionWith(details: unknown[]) {
 const manager = SessionManager.inMemory('/x'), first = manager.appendMessage(user);
 for (const d of details) manager.appendCompaction(SUMMARY, first, 1000, d === null ? { readFiles: [], modifiedFiles: [] } : d, true);
 return { manager, first };
}

export interface Drive {
 errors: unknown[];
 ctx: ExtensionContext;
 start: () => Promise<void>;
 /** A request of exactly `tokens` estimated tokens, offered to the guard; the messages are returned so that a test can change them. */
 offer: (tokens: number) => Promise<{ role: 'user'; content: string; timestamp: number }[]>;
 /** The reply to the last offered request. */
 reply: (message?: Partial<AssistantMessage>) => Promise<void>;
 close: () => Promise<void>;
}
/** The compactor driven directly through its handlers, on a context whose session manager is `session` (a real one, so that an entry off the active branch is really there to be misread). */
export async function drive(session: SessionManager, options: Partial<CompactionOptions> = {}): Promise<Drive> {
 const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
 const pi = { on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
  registerCommand: () => {}, registerTool: () => {}, getSettings: () => ({}), getAllTools: () => [], getActiveTools: () => [] } as unknown as ExtensionAPI;
 const errors: unknown[] = [];
 const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 } });
 const handle = await installCompaction(pi, { settings, ...EXACT_RESERVE, fail: error => errors.push(error), ...options });
 const ctx = { model: MODEL, cwd: '/x', abort: vi.fn(), getSystemPrompt: () => 'system', ui: { notify: () => {} }, sessionManager: session } as unknown as Drive['ctx'];
 const emit = async (name: string, event: unknown) => { for (const handler of handlers.get(name) ?? []) await handler(event, ctx); };
 return { errors, ctx, close: () => handle.close(),
  start: () => emit('session_start', { type: 'session_start', reason: 'resume' }),
  offer: async tokens => {
   // A user message whose measure, with the system part, is exactly `tokens` (four characters to the token).
   const messages = [{ role: 'user' as const, content: 'x'.repeat(4 * (tokens - referenceGuardSystem([], 'system'))), timestamp: 0 }];
   await emit('context_with_system', { messages });
   return messages;
  },
  reply: message => emit('message_end', { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], provider: ctx.model!.provider, api: ctx.model!.api, model: ctx.model!.id,
   stopReason: 'stop', timestamp: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, ...message } }),
 };
}
/** An assistant reply that reports `input` tokens of usage. */
export const reporting = (input: number): Partial<AssistantMessage> => ({ usage: { input, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: input, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });

/**
 * What the guard says to a request of `tokens` after the preparation (a Resume, then whatever `prepare` does): the failures it raised.
 * The same preparation in a fresh installation each time.
 */
export async function guarded(session: SessionManager, tokens: number, prepare: (d: Drive) => Promise<void> = async () => {}, options: Partial<CompactionOptions> = {}) {
 const d = await drive(session, options);
 try { await d.start(); await prepare(d); const before = d.errors.length; await d.offer(tokens); return d.errors.slice(before).map(String); }
 finally { await d.close(); vi.restoreAllMocks(); }
}
/** The factor after the preparation is f: the guard admits `edge(f)` tokens and rejects one more. */
export async function expectFactor(f: number, session: SessionManager, label = '', prepare?: (d: Drive) => Promise<void>, options?: Partial<CompactionOptions>) {
 expect(await guarded(session, edge(f), prepare, options), `${label}: factor ${f} admits ${edge(f)}`).toEqual([]);
 expect((await guarded(session, edge(f) + 1, prepare, options)).join(' '), `${label}: factor ${f} rejects ${edge(f) + 1}`).toContain(CAPACITY);
}
