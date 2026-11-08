import { SessionManager, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { measurableConversationTokens, planningReserve, bandOf, DEFAULT_CUT_AT } from '../src/budget';

const WORDS = 'parser cache index token budget summary recall branch module schema router worker queue retry timeout config build test lint deploy migrate session window ledger anchor cursor shard vector'.split(' ');
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
/** Frozen low-prose workload shared with the regression bench. */
export function part3Fixture(turns = 240, window = 131072, response = 16384, mandatory = 12000) {
  const manager = SessionManager.inMemory('/part3-synthetic');
  let seed = 7, clock = 1700000000000, calls = 0;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const words = (n: number) => Array.from({ length: n }, () => WORDS[Math.floor(random() * WORDS.length)]).join(' ');
  const stamp = () => clock += 1000;
  const answer = (content: unknown[], stopReason = 'toolUse') => manager.appendMessage({ role: 'assistant', content, stopReason,
    timestamp: stamp(), api: 'openai-completions', provider: 'probe', model: 'probe', usage } as never);
  const result = (id: string, toolName: string, text: string, isError = false) => manager.appendMessage({ role: 'toolResult', toolCallId: id,
    toolName, content: [{ type: 'text', text }], isError, timestamp: stamp() });
  const call = (id: string, name: string, args: object) => ({ type: 'toolCall', id, name, arguments: args });
  for (let turn = 1; turn <= turns; turn++) {
    const file = `src/${WORDS[turn % WORDS.length]}/${WORDS[turn * 7 % WORDS.length]}-${turn % 97}.ts`;
    if (turn % 60 === 1) manager.appendMessage({ role: 'user', content: `Task ${turn}: please ${words(40)}`, timestamp: stamp() });
    const a = `c${++calls}`, b = `c${++calls}`, e = `c${++calls}`;
    answer([{ type: 'text', text: `Checking ${file}. ${words(12)}` }, call(a, 'read', { path: file }),
      call(b, 'bash', { command: `npm test -- ${WORDS[turn % 11]} && rg ${WORDS[turn % 13]} src` })]);
    result(a, 'read', words(500)); result(b, 'bash', words(250), turn % 9 === 0);
    answer([call(e, 'edit', { path: file, oldText: words(12), newText: words(14) })]); result(e, 'edit', 'Edited.');
    answer([{ type: 'text', text: `Round ${turn} done. ${words(15)}` }], turn % 60 === 0 ? 'stop' : 'toolUse');
  }
  manager.appendMessage({ role: 'user', content: 'Continue the current task.', timestamp: stamp() });
  const ctx = { sessionManager: manager, cwd: '/part3-synthetic', model: { contextWindow: window, maxTokens: response } } as unknown as ExtensionContext;
  const measure = (messages: Parameters<typeof measurableConversationTokens>[0]) => measurableConversationTokens(messages, ctx);
  const before = measure(manager.buildSessionProjection().messages);
  const reserve = planningReserve(window, bandOf(window - response, DEFAULT_CUT_AT), 1, mandatory);
  return { manager, ctx, measure, before, reserve };
}
