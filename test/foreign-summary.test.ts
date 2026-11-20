import { expect, test } from 'vitest';
import { SessionManager, type SessionEntry } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { harness, type Options } from './budget-fixture';
import { MODEL } from './calibration-fixture';

// GitHub issue #1 (2026-11-19): pi-tuck loaded into a session whose branch already holds a Pi-native compaction summary (not a
// TUCK-TRANSCRIPT) failed every prompt in preflight: the strict projection threw on the foreign summary, so the session could neither send a
// prompt nor reach the cut that would replace it. Native Pi sends such a summary unchanged; pi-tuck now passes it through the same way.
const NATIVE_SUMMARY = '## Goal\nFix the parser.\n\n## Progress\n- Read src/parse.ts and found the off-by-one in readToken.\n\n## Next steps\n- Patch readToken and run the tests.';
const reply = (text: string): AssistantMessage => ({ role: 'assistant', api: MODEL.api, provider: MODEL.provider, model: MODEL.id,
 content: [{ type: 'text', text }], stopReason: 'stop', timestamp: 1,
 usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });

function nativeBranch(withOmission: boolean): SessionEntry[] {
 const m = SessionManager.inMemory('/virtual/pi-tuck-test/foreign-summary');
 m.appendMessage({ role: 'user', content: 'Please fix the parser in src/parse.ts.', timestamp: 1 });
 const old = m.appendMessage(reply('Looking at the parser now. ' + 'detail '.repeat(400)));
 const kept = m.appendMessage({ role: 'user', content: 'Keep going.', timestamp: 2 });
 m.appendMessage(reply('Continuing.'));
 // Pi's own /compact while pi-tuck was not loaded: a plain summary, not from an extension hook.
 m.appendCompaction(NATIVE_SUMMARY, kept, 4000, undefined, false);
 if (withOmission) m.appendContextEdit(old, null);
 m.appendMessage({ role: 'user', content: 'Anything else to check?', timestamp: 3 });
 m.appendMessage(reply('Only the tests.'));
 return m.getBranch();
}
const options = (branch: SessionEntry[]): Options => ({ at: 'prompt', complete: 0, noHistory: true, noOpening: true, persist: false, stableHost: true,
 limits: { contextWindow: 32_768, maxTokens: 8_192 }, host: 200, systemTokens: 800, reserveTokens: 8_192, keepRecent: 20_000, usageRatio: 1,
 cutAtDefault: true, branch, compaction: { requestReserve: undefined } });

for (const withOmission of [false, true]) {
 test(`a branch with a Pi-native summary${withOmission ? ' and a native omission' : ''} still sends prompts, the summary as Pi would send it`, async () => {
  const h = await harness(options(nativeBranch(withOmission)));
  try {
   await h.session.prompt(h.sized(1_000));
   expect(h.faults, JSON.stringify(h.notices)).toEqual([]);
   expect(h.state.requests).toBeGreaterThan(0);
   expect(JSON.stringify(h.session.messages)).toContain('found the off-by-one in readToken');
   expect(h.session.messages.findLast(m => m.role === 'assistant')).toMatchObject({ stopReason: 'stop' });
  } finally { await h.cleanup(); }
 });

 test(`a branch with a Pi-native summary${withOmission ? ' and a native omission' : ''} reaches a pi-tuck cut that replaces it`, async () => {
  const h = await harness(options(nativeBranch(withOmission)));
  try {
   for (let i = 0; i < 6; i++) await h.session.prompt(h.sized(4_000));
   expect(h.faults, JSON.stringify(h.notices)).toEqual([]);
   const cuts = h.compactions();
   expect(cuts.length).toBeGreaterThan(0);
   expect(cuts.at(-1)!.summary.startsWith('TUCK-TRANSCRIPT/')).toBe(true);
  } finally { await h.cleanup(); }
 });
}
