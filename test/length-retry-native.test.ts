import { expect, test } from 'vitest';
import { MODEL } from './calibration-fixture';
import { harness } from './budget-fixture';

const model = { provider: MODEL.provider, id: MODEL.id };
const build = (stops: number[], extra: { tools?: number[]; continuation?: boolean; systemTokens?: number } = {}) => harness({
 at: 'prompt', complete: 0, noHistory: true, noOpening: true, host: 200, systemTokens: extra.systemTokens ?? 19_000, model,
 limits: { contextWindow: 32_768, maxTokens: 16_384 }, reserveTokens: 2_048, piRequestPath: true,
 thinkingOnlyLength: n => stops.includes(n), toolCalls: n => extra.tools?.includes(n) ?? false,
 compaction: { requestReserve: undefined, ...(extra.continuation ? { continuationModel: `${model.provider}/${model.id}` } : {}) } });
const receipts = (h: Awaited<ReturnType<typeof build>>) => h.manager.getBranch().flatMap(entry =>
 entry.type === 'custom' && entry.customType === 'pi-tuck-capacity' && (entry.data as { kind?: string }).kind === 'retry' ? [entry.data as any] : []);

test.each([
 { name: 'a stop that no cut can help is retried uncut', stops: [1], tools: [], prompts: 1, replies: ['length', 'stop'], retries: 1 },
 // A stop that is not retried gets an act-now turn, at most two in a row.
 { name: 'a second stop in a row is not retried; act-now turns follow', stops: [1, 2, 3], tools: [], prompts: 1, replies: ['length', 'length', 'length', 'stop'], retries: 1 },
 { name: 'a good reply re-arms the retry', stops: [1, 3], tools: [2], prompts: 1, replies: ['length', 'toolUse', 'length', 'stop'], retries: 2 },
 { name: 'a new prompt re-arms the retry', stops: [1, 2, 3, 4, 5], tools: [], prompts: 2, replies: ['length', 'length', 'length', 'length', 'length', 'stop'], retries: 2 },
])('$name', async cell => {
 const h = await build(cell.stops, { tools: cell.tools });
 try {
  for (let n = 0; n < cell.prompts; n++) await h.session.prompt(`Task ${n}`);
  expect(h.faults).toEqual([]);
  expect(h.state.answers.map(answer => answer.stopReason)).toEqual(cell.replies);
  expect(receipts(h).map(data => data.cut)).toEqual(Array(cell.retries).fill(false));
  expect(h.compactions()).toEqual([]);
  expect(h.state.answers[0]!.usage.output).toBeLessThan(16_384);
 } finally { await h.cleanup(); }
});

test('the llama continuation model gets no uncut retry; its stall gets the act-now turn', async () => {
 const h = await build([1], { continuation: true });
 try {
  await h.session.prompt('Task');
  expect(h.faults).toEqual([]);
  expect(h.state.answers.map(answer => answer.stopReason)).toEqual(['length', 'stop']);
  expect(receipts(h)).toEqual([]);
 } finally { await h.cleanup(); }
});

test('a steering message re-arms the retry', async () => {
 const h = await build([1, 2, 3]);
 try {
  let steered = false;
  h.extension().on('turn_end', async () => { if (h.state.requests === 2 && !steered) { steered = true; await h.session.steer('Steered task'); } });
  await h.session.prompt('Task');
  expect(h.faults).toEqual([]);
  expect(h.state.answers.map(answer => answer.stopReason)).toEqual(['length', 'length', 'length', 'stop']);
  expect(receipts(h)).toHaveLength(2);
 } finally { await h.cleanup(); }
});

test('a stop at the model allowance is not retried; the act-now turn follows', async () => {
 const h = await build([1], { systemTokens: 800 });
 try {
  await h.session.prompt('Task');
  expect(h.faults).toEqual([]);
  expect(h.state.answers.map(answer => [answer.stopReason, answer.usage.output])).toEqual([['length', 16_384], ['stop', 0]]);
  expect(receipts(h)).toEqual([]);
 } finally { await h.cleanup(); }
});

// Pi's own retry decisions, with only its cut replaced: every reply order of two prompts, each compared with pi-tuck's.
// The act-now turn is pi-tuck's own addition, with no native counterpart: it is off here (Pi refuses the queued turn).
const orders = Array.from({ length: 3 ** 5 }, (_, n) => [...n.toString(3).padStart(5, '0')].map(Number));
test('retry decisions match native Pi for every order of length stop, tool call and finished reply', async () => {
 let nativeRetries = 0;
 const replies = async (order: number[], native: boolean) => {
  const at = (kind: number) => order.flatMap((value, index) => value === kind ? [index + 1] : []);
  const h = await build(at(1), { tools: at(2) });
  try {
   if (!native) (h.extension() as any).sendUserMessage = () => { throw new Error('act-now off for the parity check'); };
   if (native) {
    const session = h.session as any;
    session._extensionRunner.extensions.length = 0;
    session._runAutoCompaction = async (_reason: string, willRetry: boolean) => { if (willRetry) nativeRetries++; return willRetry; };
   }
   for (let n = 0; n < 2; n++) await h.session.prompt(`Task ${n}`);
   expect(h.faults).toEqual([]);
   return h.state.answers.map(answer => answer.stopReason);
  } finally { await h.cleanup(); }
 };
 for (const order of orders) expect(await replies(order, false), order.join()).toEqual(await replies(order, true));
 expect(nativeRetries).toBeGreaterThan(0);
}, 120_000);
