import { expect, test } from 'vitest';
import { SessionManager, convertToLlm } from '@earendil-works/pi-coding-agent';
import { DIALOGUE_SUFFIX } from '../../src/tuck/core/format';
import { serializeTranscript, type TranscriptRecord } from '../../src/tuck/core/transcript';
import { checkCut, checkPrompt, checkRefusal } from './checks';
import { shapes, text, WINDOWS } from './generator';
import { harness } from '../budget-fixture';

function fixture() {
  const manager = SessionManager.inMemory('/testbed');
  const first = text('first', 100), second = text('second', 100);
  manager.appendMessage({ role: 'user', content: first, timestamp: 1 });
  manager.appendMessage({ role: 'toolResult', toolName: 'effect', toolCallId: 'call', isError: false, timestamp: 1,
    content: [{ type: 'text', text: second }] });
  const request = (records: TranscriptRecord[]) => convertToLlm([{ role: 'compactionSummary', summary: serializeTranscript(records) + DIALOGUE_SUFFIX, tokensBefore: 0, timestamp: 0 }]);
  return { manager, first, second, request };
}

test('the grid has seven shapes per window, exact sizes, hundreds of steering turns and long steps exceeding their task', () => {
  for (const window of WINDOWS) {
    const grid = shapes(window);
    expect(grid).toHaveLength(7);
    for (const shape of grid) for (const turn of shape.turns) expect(text(turn.label, turn.tokens, turn.format).length).toBe(turn.tokens * 4);
    for (const shape of grid.filter(shape => shape.name.startsWith('spec-'))) expect(shape.turns.length).toBeGreaterThan(200);
    expect(text('log-shape', 1_000, 'logs')).toContain('WARN [log-shape]');
    const tasks = grid.find(shape => shape.name === 'tasks-long-steps')!.turns;
    let task = 0, steps = 0;
    for (const turn of tasks) {
      if (!turn.label.includes('-step-')) { if (task) expect(steps).toBeGreaterThan(task); task = turn.tokens; steps = 0; }
      else steps += turn.tokens;
    }
    expect(steps).toBeGreaterThan(task);
    expect(grid.find(shape => shape.name === 'huge-tool-results')!.turns[1]!.results.every(size => size > window)).toBe(true);
  }
});

test('v2 summary escapes are undone, and the whole current input is required', () => {
  const { first, request } = fixture();
  const whole = request([{ kind: 'excerpt', role: 'user', sourceIndex: 0, text: first }]);
  expect(checkPrompt(whole, first)).toEqual([]);
  expect(checkPrompt(request([{ kind: 'excerpt', role: 'user', sourceIndex: 0, text: first.slice(0, 80) }]), first)[0]?.rule).toBe('current-prompt');
});

test('v1 JSON quotes, tabs, newlines and literal backslashes are decoded exactly once', () => {
  const first = text('v1-escaped-input', 100);
  const summary = `TUCK-TRANSCRIPT/1\n${JSON.stringify({ kind: 'excerpt', role: 'user', sourceIndex: 0, text: first })}${DIALOGUE_SUFFIX}`;
  expect(checkPrompt(convertToLlm([{ role: 'compactionSummary', summary, tokensBefore: 0, timestamp: 0 }]), first)).toEqual([]);
});

test('a count and source pointer account for a clipped turn; a tool heading cannot account for a dropped result', () => {
  const { manager, first, request } = fixture();
  const records: TranscriptRecord[] = [
    { kind: 'excerpt', role: 'user', sourceIndex: 0, text: first.slice(0, 80) },
    { kind: 'omission', role: 'user', sourceIndex: 0, reason: 'The rest is at tuck_recall {"index":0,"offset":80}' },
    { kind: 'omission', reason: 'Historical tool observations omitted; read originals with tuck_recall' },
  ];
  expect(checkCut(request(records), manager.getEntries()).map(finding => finding.rule)).toEqual(['omissions']);
  records.push({ kind: 'omission', sourceIndex: 1, reason: 'One result omitted; tuck_recall {"index":1}' });
  expect(checkCut(request(records), manager.getEntries())).toEqual([]);
  records.pop();
  records.push({ kind: 'omission', reason: `One result omitted; tuck_recall {"entryId":"${manager.getEntries().at(-1)!.id}"}` });
  expect(checkCut(request(records), manager.getEntries())).toEqual([]);
});

test('a counted range covers all dropped units of its role and rejects wrong counts or bounds', () => {
  const { manager, first, request } = fixture();
  manager.appendMessage({ role: 'user', content: 'Kept intervening source.', timestamp: 1 });
  manager.appendMessage({ role: 'toolResult', toolName: 'effect', toolCallId: 'another', isError: false, timestamp: 1,
    content: [{ type: 'text', text: 'Another result.' }] });
  const retained: TranscriptRecord[] = [
    { kind: 'excerpt', role: 'user', sourceIndex: 0, text: first },
    { kind: 'excerpt', role: 'user', sourceIndex: 2, text: 'Kept intervening source.' },
  ];
  const range = (count: number, end = 3): TranscriptRecord => ({ kind: 'omission', role: 'toolResult', count,
    sourceRange: { start: 1, end }, reason: 'Historical tool results omitted; read the index range with tuck_recall.' });
  expect(checkCut(request([...retained, range(2)]), manager.getEntries())).toEqual([]);
  expect(checkCut(request([...retained, range(1)]), manager.getEntries()).some(finding => finding.detail.includes('does not equal 2'))).toBe(true);
  expect(checkCut(request([...retained, range(3)]), manager.getEntries()).some(finding => finding.detail.includes('does not equal 2'))).toBe(true);
  expect(checkCut(request([...retained, range(2, 900)]), manager.getEntries()).some(finding => finding.detail.includes('outside'))).toBe(true);
});

test('a range count includes partial units already named by an individual continuation note', () => {
  const { manager, first, request } = fixture();
  manager.appendMessage({ role: 'user', content: 'Another dropped input.', timestamp: 1 });
  const records: TranscriptRecord[] = [
    { kind: 'excerpt', role: 'user', sourceIndex: 0, text: first.slice(0, 80) },
    { kind: 'omission', role: 'user', sourceIndex: 0, reason: 'tuck_recall {"index":0,"offset":80}' },
    { kind: 'omission', role: 'toolResult', count: 1, sourceRange: { start: 1, end: 1 }, reason: 'tuck_recall' },
    { kind: 'omission', role: 'user', count: 2, sourceRange: { start: 0, end: 2 }, reason: 'tuck_recall' },
  ];
  expect(checkCut(request(records), manager.getEntries())).toEqual([]);
  records.at(-1)!.count = 1;
  expect(checkCut(request(records), manager.getEntries()).some(finding => finding.detail.includes('does not equal 2'))).toBe(true);
});

test('a user omission cannot cover a tool result, and a pointer outside the session fails', () => {
  const { manager, first, request } = fixture();
  manager.appendMessage({ role: 'user', content: text('third', 100), timestamp: 1 });
  const records: TranscriptRecord[] = [
    { kind: 'excerpt', role: 'user', sourceIndex: 0, text: first },
    { kind: 'omission', count: 1, role: 'user', sourceIndices: [1, 2], reason: 'Dropped' },
  ];
  expect(checkCut(request(records), manager.getEntries()).some(finding => finding.detail.startsWith('toolResult:'))).toBe(true);
  records.push({ kind: 'omission', sourceIndex: 900, reason: 'Wrong pointer' });
  expect(checkCut(request(records), manager.getEntries()).some(finding => finding.detail.includes('outside'))).toBe(true);
});

test('a native clipped result with its entryId locator is accounted for', () => {
  const { manager, first, second } = fixture();
  const result = manager.getEntries().findLast(entry => entry.type === 'message')!;
  const messages = convertToLlm(manager.buildSessionProjection().messages);
  const tool = messages.find(message => message.role === 'toolResult')!;
  tool.content = [{ type: 'text', text: second.slice(0, 80) + `\n[pi-tuck: characters 80-300 are not shown; tuck_recall {"entryId":"${result.id}","offset":80}]` }];
  expect(checkPrompt(messages, first)).toEqual([]);
  expect(checkCut(messages, manager.getEntries())).toEqual([]);
});

test('a refused input is excluded from the eight answered turns', async () => {
  const h = await harness({ at: 'prompt', complete: 0, host: 0, noHistory: true, noOpening: true,
    limits: { contextWindow: 32_768, maxTokens: 8_192 }, reserveTokens: 16_384, systemTokens: 100 });
  try {
    const first = text('answered-first', 100);
    await h.session.prompt(first);
    h.manager.appendMessage({ role: 'user', content: text('refused', 100), timestamp: 1 });
    h.manager.appendMessage(h.answer([], 'error'));
    const request = convertToLlm([{ role: 'user', content: first, timestamp: 1 }]);
    expect(checkCut(request, h.manager.getEntries()).filter(finding => finding.rule === 'openings')).toEqual([]);
  } finally { await h.cleanup(); }
  expect(checkRefusal(false, 100, 200)[0]?.rule).toBe('refusal');
  expect(checkRefusal(false, 201, 200)).toEqual([]);
});
