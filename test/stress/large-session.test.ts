import { afterAll, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager, type ExtensionAPI, type ExtensionToolContext, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { installCompaction } from '../../src/compaction';
import { MAX_RECALL_CHARACTERS, type RecallPage } from '../../src/recall';
import { MAX_RANKED_RESPONSE_CHARACTERS, type tuckRecall } from '../../src/tuck';

// The v1.1.1 large-session generator: real-sized rounds, cuts every 400 rounds, and growth between searches. At this size three field
// defects lived in tuck_search: keyword timeouts failed the call, a fully indexed plan looked empty, and results went stale after growth.
// Exercise the registered keyword-only tuck_recall now, including exact source reads. Runs only with STRESS=1; no model or encoder.
const RUN = /^(1|true|yes)$/i.test(process.env.STRESS ?? '');
const TARGET_MB = Number(process.env.LARGE_SESSION_MB) || 85;
const GROWTH_BYTES = 5e6;
const WITNESS = 'large_session_witness';
const QUERY_WORDS = ['accela', 'export', 'capped', 'grid', WITNESS];
const QUERY = QUERY_WORDS.join(' ');
type RankedPage = Extract<ReturnType<typeof tuckRecall>, { hits: unknown }>;

const root = mkdtempSync(join(tmpdir(), 'large-session-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let seed = 0x1a2b3c;
const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32; };
const WORDS = 'permit contractor ledger invoice accela portal record status window export capped grid source index change store probe tenant license address parcel'.split(' ');
const text = (n: number) => Array.from({ length: n }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(' ');
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
let at = 0, calls = 0;

/** One agent round: a short thought and tool call, a few-kilobyte receipt, and a cut every 400 rounds. */
function round(m: SessionManager, i: number, witness = false) {
 const id = 'call_' + (++calls);
 m.appendMessage({ role: 'assistant', content: [
  { type: 'thinking', thinking: text(40), thinkingSignature: 'reasoning_content' },
  { type: 'text', text: text(12) },
  { type: 'toolCall', id, name: 'bash', arguments: { command: 'grep -n ' + WORDS[i % WORDS.length] + ' data/file_' + i + '.txt' } },
 ], api: 'openai-completions', provider: 'fixture', model: 'fixture', usage, stopReason: 'toolUse', timestamp: ++at });
 const resultText = 'line ' + i + ': ' + (witness ? WITNESS + ' ' : '') + text(380);
 const entryId = m.appendMessage({ role: 'toolResult', toolCallId: id, toolName: 'bash', content: [{ type: 'text', text: resultText }], isError: false, timestamp: ++at });
 if (i % 400 === 399) m.appendCompaction('summary through round ' + i, 'no-such-entry', 100, undefined, true);
 // The user is message #0; compaction entries do not consume message indices.
 return { entryId, index: 2 * i + 2, text: resultText };
}

test.skipIf(!RUN)(`recall on a ~${TARGET_MB} MB session that grows by ~5 MB between searches`, async () => {
 // SEARCH_BUDGET_MS is private. Read its declaration rather than changing src or inventing a separate wall-time allowance.
 const declaration = readFileSync(new URL('../../src/tuck/core/search-entries.ts', import.meta.url), 'utf8')
  .match(/\bconst SEARCH_BUDGET_MS\s*=\s*([\d_]+)\s*;/);
 expect(declaration, 'Find the recall search budget in src').not.toBeNull();
 const budgetMs = Number(declaration![1]!.replaceAll('_', ''));
 const m = SessionManager.inMemory(join(root, 'project'));
 m.appendMessage({ role: 'user', content: 'Long-running task: ' + text(60), timestamp: ++at });
 let i = 0;
 const old = round(m, i++, true);
 const bytes = () => Buffer.byteLength(JSON.stringify(m.getEntries()), 'utf8');
 while (i % 2000 !== 0 || bytes() < TARGET_MB * 1e6) {
  round(m, i++);
  if (i > 200000) throw new Error('size not reached');
 }
 let sessionBytes = bytes();
 expect(sessionBytes).toBeGreaterThanOrEqual(TARGET_MB * 1e6);
 expect(m.getBranch().filter(e => e.type === 'compaction')).toHaveLength(Math.floor(i / 400));

 // Independent fixture oracle: readable message text plus serialized calls, without hidden thinking or saved summaries.
 const originalText = (entryId: string) => {
  const entry = m.getEntry(entryId);
  if (entry?.type !== 'message') throw new Error('Expected an original fixture message: ' + entryId);
  const message = entry.message;
  if (message.role !== 'user' && message.role !== 'assistant' && message.role !== 'toolResult')
   throw new Error('Unexpected fixture message role: ' + message.role);
  const content = message.content;
  if (typeof content === 'string') return content;
  return content.flatMap(block => block.type === 'text' ? [block.text] : block.type === 'toolCall'
   ? [JSON.stringify({ toolCall: { name: block.name, id: block.id, arguments: block.arguments } })] : []).join('\n');
 };
 const matchingIds = () => new Set(m.getEntries().flatMap(entry => {
  if (entry.type !== 'message') return [];
  const source = originalText(entry.id);
  return QUERY_WORDS.some(word => source.includes(word)) ? [entry.id] : [];
 }));
 const checkSearch = (page: RankedPage, matches: Set<string>, witnesses: typeof old[]) => {
  expect(page.normalizedQuery).toBe(QUERY);
  expect(page.throughEntryId).toBe(m.getBranch().findLast(entry => entry.type === 'message')!.id);
  expect(page.totalMatches).toBe(matches.size);
  expect(page.hits.length).toBeGreaterThan(0);
  for (const hit of page.hits) {
   expect(matches.has(hit.entryId)).toBe(true);
   expect(hit.read.entryId).toBe(hit.entryId);
   const source = originalText(hit.entryId);
   expect(hit.totalCharacters).toBe(source.length);
   expect(hit.snippet).toBe(source.slice(hit.read.offset, hit.read.offset + hit.read.limit));
  }
  for (const source of witnesses) {
   const hit = page.hits.find(hit => hit.entryId === source.entryId);
   expect(hit, `Round at #${source.index} is findable in this snapshot`).toBeDefined();
   expect(hit!.index).toBe(source.index);
   expect(hit!.snippet).toContain(WITNESS);
  }
 };

 let tool: ToolDefinition | undefined;
 const handle = await installCompaction({ registerCommand: () => {}, registerTool: (t: ToolDefinition) => {
  if (t.name === 'tuck_recall') tool = t;
 }, on: () => () => {} } as unknown as ExtensionAPI);
 try {
  expect(tool, 'installCompaction registers tuck_recall').toBeDefined();
  const ctx = { sessionManager: m, cwd: join(root, 'project') } as unknown as ExtensionToolContext;
  const invoke = async <T,>(label: string, input: unknown): Promise<T> => {
   const start = performance.now();
   let result: Awaited<ReturnType<ToolDefinition['execute']>>;
   let elapsedMs: number;
   try {
    // A thrown call fails the test, as does an explicit error result below.
    result = await tool!.execute(label, input, undefined, undefined, ctx);
   } finally {
    elapsedMs = performance.now() - start;
    process.stderr.write(`large-session: ${JSON.stringify({ call: label, sessionBytes, sessionMB: sessionBytes / 1e6, rounds: i, elapsedMs, budgetMs })}\n`);
   }
   expect(result.isError, label).not.toBe(true);
   expect.soft(elapsedMs, label + ' wall time against the recall search budget').toBeLessThanOrEqual(budgetMs);
   expect(result.content).toHaveLength(1);
   const block = result.content[0]!;
   expect(block.type).toBe('text');
   if (block.type !== 'text') throw new Error('Expected a recall text page');
   expect(block.text.length, label + ' serialized page').toBeLessThanOrEqual(MAX_RANKED_RESPONSE_CHARACTERS);
   return JSON.parse(block.text) as T;
  };

  const beforeMatches = matchingIds();
  const first = await invoke<RankedPage>('keyword-before-growth', { query: QUERY });
  checkSearch(first, beforeMatches, [old]);
  const indexed = await invoke<RecallPage>('index', { index: old.index });
  expect(indexed.status).toBe('ok');
  expect(indexed.matchedEntries).toBe(1);
  expect(indexed.entries).toHaveLength(1);
  expect(indexed.entries[0]).toMatchObject({ entryId: old.entryId, textOffset: 0, text: old.text, totalCharacters: old.text.length });
  expect(indexed.nextOffset).toBeNull();
  expect(indexed.entries[0]!.text.length).toBeLessThanOrEqual(MAX_RECALL_CHARACTERS);

  const offset = Math.floor(old.text.length / 3), limit = Math.floor(old.text.length / 3);
  const paged = await invoke<RecallPage>('entryId-offset', { entryId: old.entryId, offset, limit });
  expect(paged.status).toBe('ok');
  expect(paged.entries).toHaveLength(1);
  expect(paged.entries[0]).toMatchObject({ entryId: old.entryId, textOffset: offset, text: old.text.slice(offset, offset + limit), totalCharacters: old.text.length });
  expect(paged.totalCharacters).toBe(old.text.length);
  expect(paged.nextOffset).toBe(offset + limit);
  expect(paged.entries[0]!.text.length).toBeLessThanOrEqual(MAX_RECALL_CHARACTERS);

  const initialBytes = sessionBytes, initialRounds = i;
  do {
   for (let k = 0; k < 100; k++) round(m, i++);
   sessionBytes = bytes();
  } while (sessionBytes - initialBytes < GROWTH_BYTES);
  const fresh = round(m, i++, true);
  sessionBytes = bytes();
  // At most one 100-round measurement batch plus the final witness overshoots the requested growth.
  expect(sessionBytes - initialBytes).toBeGreaterThanOrEqual(GROWTH_BYTES);
  expect(sessionBytes - initialBytes).toBeLessThan(GROWTH_BYTES + 101 * (sessionBytes / i));
  const afterMatches = matchingIds();
  expect(afterMatches.size).toBeGreaterThan(beforeMatches.size);
  expect(afterMatches.has(fresh.entryId) && !beforeMatches.has(fresh.entryId)).toBe(true);
  expect(i).toBeGreaterThan(initialRounds);
  const grown = await invoke<RankedPage>('keyword-after-growth', { query: QUERY });
  checkSearch(grown, afterMatches, [old, fresh]);
  expect(grown.totalMatches).toBeGreaterThan(first.totalMatches);
  expect(grown.throughEntryId).not.toBe(first.throughEntryId);
 } finally {
  await handle.close();
 }
}, 30 * 60 * 1000);
