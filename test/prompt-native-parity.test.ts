import { expect, test, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { harness } from './budget-fixture';
import * as compiler from '../src/tuck';
import * as clipping from '../src/clip';
import { carriesPrompt } from '../src/request-capacity';
import type { Messages } from '../src/budget';

test.each([false, true])('the whole starting prompt is refused only after every reduction is exhausted (irreducible=%s)', async irreducible => {
 const events: { kind: string; allowance?: number; floor?: number; full?: boolean; clips?: number }[] = [];
 let whole = '';
 const originalDraft = compiler.tuckObservedDraft, originalClip = clipping.clipFor;
 vi.spyOn(compiler, 'tuckObservedDraft').mockImplementation((...args) => {
  const draft = originalDraft(...args);
  const floorMessages = !draft.compaction ? draft.floorMessages : undefined;
  if (args[1].protectedPromptEntryId) events.push({ kind: 'draft', allowance: args[2].model!.contextWindow - args[3],
   ...(floorMessages ? { floor: args[4](floorMessages), full: carriesPrompt(floorMessages, whole) } : {}) });
  return draft;
 });
 vi.spyOn(clipping, 'clipFor').mockImplementation((...args) => {
  const clips = originalClip(...args); events.push({ kind: 'clip', allowance: args[2], clips: clips.length }); return clips;
 });
 const wire: boolean[] = [], response = irreducible ? 8192 : 3584, limit = 32768 - response;
 const h = await harness({ at: 'prompt', complete: 0, noHistory: true, noOpening: true, stableHost: true,
  limits: { contextWindow: 32768, maxTokens: 8192 }, reserveTokens: response, host: 200, systemTokens: 800,
  compaction: { requestReserve: () => ({ response, responseExact: true }), cutAt: 1 },
  afterDecision: (at, api) => { if (at === 0) void api.steer(200); },
  toolCalls: n => n === 1, toolResultTokens: () => irreducible ? 100 : 18000,
  replyTokens: n => irreducible && n === 1 ? 8000 : 0,
  onBoundary: (_event, ctx) => { expect(ctx.sessionManager.getBranch().filter(e => e.type === 'message' && e.message.role === 'user').length).toBeGreaterThanOrEqual(2); },
  onWire: ctx => { wire.push(carriesPrompt((ctx as { messages: Messages }).messages, whole)); },
 });
 try {
  whole = 'START_ORIGINAL ' + h.sized((irreducible ? 20000 : 15000) - 4);
  await h.session.prompt(whole);
  expect(wire.every(Boolean)).toBe(true);
  const drafts = events.filter(e => e.kind === 'draft');
  expect(drafts.length).toBeGreaterThanOrEqual(2);
  expect(drafts[0]!.allowance).toBeLessThan(drafts[1]!.allowance!); // band, then room
  expect(drafts.slice(0,2).every(e => e.full && e.floor! > e.allowance!)).toBe(true); // minimum summary still retains the whole prompt
  expect(events.findIndex(e => e.kind === 'clip')).toBeGreaterThanOrEqual(2);
  if (irreducible) {
   expect(h.state.requests).toBe(1);
   expect(h.faults.join(' ')).toContain('Prompt check failed: the whole starting prompt cannot fit after');
   expect(h.notices.join(' ')).toContain('Shorten the prompt or choose a model with a larger context window, then retry');
   // Text of the fresh assistant is not clippable: even no result and no summary leave more than the final room.
   expect((whole.length / 4) + 8000 + h.mandatory).toBeGreaterThan(limit);
   expect(events.some(e => e.kind === 'clip' && e.clips === 0)).toBe(true);
  } else {
   expect(h.faults).toEqual([]);
   expect(h.state.requests).toBe(2);
   expect(h.state.clips).toBeGreaterThan(0);
   expect(events.some(e => e.kind === 'clip' && e.clips! > 0)).toBe(true);
  }
  if (process.env.PROMPT_PROOF_REPORT) writeFileSync(`${process.env.PROMPT_PROOF_REPORT}-${irreducible}.json`, JSON.stringify({ irreducible, limit, events, requests: h.state.requests, wire, faults: h.faults, notices: h.notices }, null, 2));
 } finally { await h.cleanup(); vi.restoreAllMocks(); }
});
