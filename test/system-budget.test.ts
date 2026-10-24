import { expect, test } from 'vitest';
import type { Tool } from '@earendil-works/pi-ai';
import { estimateTokens } from '@earendil-works/pi-coding-agent';
import { guardSystemTokens, observedSystemTokens, requestTokens, systemPart, type Messages } from '../src/budget';
import { referenceGuardSystem, referenceSystemPart } from './budget-fixture';

// Cross every prompt/tool JSON length residue, not only the rendered prompt's residue.
for (const p of [0, 1, 2, 3]) for (const t of [0, 1, 2, 3]) {
 const prompt = 'p'.repeat(8 + p);
 const tools: Tool[] = [{ name: 'effect', description: 'd'.repeat(t), parameters: {} }];
 const json = JSON.stringify(tools);
 test(`combined system estimate and unchanged request: prompt residue ${p}, tool padding ${t}`, () => {
  expect(prompt.length % 4).toBe(p);
  const unpadded = JSON.stringify([{ ...tools[0], description: '' }]);
  expect(json.length % 4).toBe((unpadded.length + t) % 4);
  const expected = Math.ceil((prompt.length + json.length) / 4);
  const saved: Messages = [{ role: 'system', content: prompt, toolsAdded: tools, timestamp: 0 }];
  const messages: Messages = [...saved, { role: 'user', content: 'unchanged', timestamp: 0 }];
  expect(observedSystemTokens(prompt, tools)).toBe(expected);
  expect(referenceSystemPart(saved, prompt, json)).toBe(expected);
  expect(systemPart(prompt, tools, saved, prompt)).toBe(expected);
  expect(guardSystemTokens(saved, prompt)).toBe(expected);
  expect(referenceGuardSystem(saved, prompt)).toBe(expected);
  expect(requestTokens(messages, prompt)).toBe(expected + Math.ceil('unchanged'.length / 4));
  // The old observed formula may overcharge by one; it must not define the guard.
  const separatelyRounded = Math.ceil(prompt.length / 4) + Math.ceil(json.length / 4);
  expect(separatelyRounded - expected).toBeGreaterThanOrEqual(0);
  expect(separatelyRounded - expected).toBeLessThanOrEqual(1);
 });
}

for (const p of [0, 1, 2, 3]) {
 test(`empty tools omit the declaration entirely: prompt residue ${p}`, () => {
  const prompt = 'p'.repeat(8 + p), expected = Math.ceil(prompt.length / 4);
  const saved: Messages = [{ role: 'system', content: prompt, timestamp: 0 }];
  expect(observedSystemTokens(prompt, [])).toBe(expected);
  expect(referenceSystemPart(saved, prompt, '[]')).toBe(expected);
  expect(systemPart(prompt, [], saved, prompt)).toBe(expected);
  expect(requestTokens(saved, prompt)).toBe(expected);
  expect(estimateTokens({ role: 'system', content: prompt, toolsAdded: [], timestamp: 0 })).toBe(Math.ceil((prompt.length + 2) / 4));
 });
 test(`deactivation preserves saved declarations and both saved/live maxima: residue ${p}`, () => {
  const prompt = 'p'.repeat(8 + p);
  const tools: Tool[] = [{ name: 'ballast', description: 'b'.repeat(400), parameters: {} }];
  const saved: Messages = [{ role: 'system', content: prompt, toolsAdded: tools, timestamp: 0 }];
  const savedEstimate = Math.ceil((prompt.length + JSON.stringify(tools).length) / 4);
  expect(savedEstimate).toBeGreaterThan(observedSystemTokens(prompt, []));
  expect(systemPart(prompt, [], saved, prompt)).toBe(savedEstimate);
  expect(referenceSystemPart(saved, prompt, '[]')).toBe(savedEstimate);
  const longLive = prompt + 'l'.repeat(800);
  const liveEstimate = Math.ceil((longLive.length + JSON.stringify(tools).length) / 4);
  expect(systemPart(prompt, [], saved, longLive)).toBe(liveEstimate);
  expect(referenceSystemPart(saved, prompt, '[]', longLive)).toBe(liveEstimate);
  const longSaved: Messages = [{ role: 'system', content: longLive, toolsAdded: tools, timestamp: 0 }];
  expect(guardSystemTokens(longSaved, prompt)).toBe(liveEstimate);
  expect(systemPart(prompt, [], longSaved, prompt)).toBe(liveEstimate);
  // A later request without the deactivated declarations is genuinely smaller, not universally equal.
  expect(requestTokens([{ role: 'system', content: prompt, timestamp: 0 }], prompt)).toBeLessThan(savedEstimate);
 });
}
