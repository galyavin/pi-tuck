import { expect, test } from 'vitest';
import type { Context, UserMessage } from '@earendil-works/pi-ai';
import { harness } from './budget-fixture';
import { inputPresence } from './lifecycle-sequence-fixture';
import { carriesPrompt } from '../src/request-capacity';
import { serializeRecord } from '../src/tuck/core/transcript';
import type { Messages } from '../src/budget';

// First/last witnesses and escapes make a partial or JSON-escaped quote fail.
const parts = ['CUSTOM-START "keep the whole instruction"\nC:\\task\r', 'run instruction '.repeat(250) + ' CUSTOM-END'];
const prompt = parts.join('\n');

for (const version of [1, 2]) test(`the guard accepts only whole decoded custom prompt quotes (transcript v${version})`, () => {
  const summary = (text: string, role: 'user' | 'custom' | 'assistant' = 'custom', omission = false): Messages => {
    const record = omission ? { kind: 'omission' as const, role, reason: text }
      : { kind: 'excerpt' as const, role, text, ...(role === 'custom' ? { sourceEntryId: 'starting-entry' } : {}) };
    return [{ role: 'compactionSummary', summary: `TUCK-TRANSCRIPT/${version}\n${version === 1 ? JSON.stringify(record) : serializeRecord(record)}\n\n---\n\nContinue.`,
      tokensBefore: 0, timestamp: 0 }];
  };
  const native: Messages = [{ role: 'custom', customType: 'run-instruction', content: parts.map(text => ({ type: 'text', text })), display: false, timestamp: 0 }];
  expect(carriesPrompt(native, prompt, 'custom')).toBe(true);
  expect(carriesPrompt(summary(prompt), prompt, 'custom')).toBe(true);
  expect(carriesPrompt(summary(prompt.slice(0, -1)), prompt, 'custom')).toBe(false);
  expect(carriesPrompt(summary(JSON.stringify(prompt)), prompt, 'custom')).toBe(false);
  expect(carriesPrompt(summary(prompt, 'assistant'), prompt, 'custom')).toBe(false);
  expect(carriesPrompt(summary(prompt, 'custom', true), prompt, 'custom')).toBe(false);
  expect(carriesPrompt(summary(prompt, 'user'), prompt, 'custom')).toBe(false);
  expect(carriesPrompt(summary(prompt), prompt)).toBe(false);
  expect(carriesPrompt(native, prompt)).toBe(false);
});

for (const display of [true, false]) for (const blocks of [false, true])
test(`a custom run keeps its whole starting text across tool-loop cuts (display=${display}, blocks=${blocks})`, async () => {
  const requests: Context[] = [], cuts: number[] = [];
  const h = await harness({ at: 'tool', complete: 0, host: 0, noHistory: true, noOpening: true,
    systemTokens: 200, stableHost: true, liveTools: true, reserveTokens: 4096, keepRecent: 0,
    limits: { contextWindow: 32768, maxTokens: 4096 }, cutAtDefault: true,
    rounds: 3, toolResultTokens: () => 14000,
    onWire: context => { requests.push(structuredClone(context as Context)); cuts.push(h.compactions().length); } });
  try {
    for (let i = 0; i < 8; i++) {
      h.manager.appendMessage({ role: 'user', content: `Earlier task ${i} ` + 'history '.repeat(250), timestamp: 0 });
      h.manager.appendMessage(h.answer([{ type: 'text', text: `Earlier answer ${i} ` + 'history '.repeat(250) }]));
    }
    h.session.agent.state.messages = h.manager.buildSessionProjection().messages;
    await h.session.sendCustomMessage({ customType: 'run-instruction', display,
      content: blocks ? parts.map(text => ({ type: 'text' as const, text })) : prompt }, { triggerTurn: true });

    expect(h.faults).toEqual([]);
    expect(requests).toHaveLength(4);
    expect(cuts[0], 'the run starts before any cut').toBe(0);
    expect(cuts.slice(1).some(count => count > 0), 'a cut happens inside the tool loop').toBe(true);
    const presence = requests.map(context => inputPresence(context, prompt, 'custom'));
    expect(presence[0]).toBe('original');
    for (let i = 1; i < presence.length; i++)
      expect(presence[i], `request ${i + 1} lost the custom instruction`).toBeDefined();
    expect(presence, 'exercise the whole-prompt summary quote').toContain('quote');
  } finally { await h.cleanup(); }
});

for (const content of ['', [], [{ type: 'image' as const, mimeType: 'image/png', data: 'aGVsbG8=' }]] satisfies UserMessage['content'][])
test(`a custom run with no text needs no prompt quote (${typeof content === 'string' ? 'empty string' : content.length ? 'image only' : 'empty blocks'})`, async () => {
  const h = await harness({ at: 'prompt', complete: 0, host: 0, noHistory: true, noOpening: true,
    systemTokens: 200, limits: { contextWindow: 32768, maxTokens: 4096 }, reserveTokens: 4096 });
  try {
    await h.session.sendCustomMessage({ customType: 'no-text', content, display: false }, { triggerTurn: true });
    expect(h.faults).toEqual([]);
    expect(h.state.requests).toBe(1);
  } finally { await h.cleanup(); }
});
