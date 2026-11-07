import { test, expect } from 'vitest';
import { harness } from './budget-fixture';

// A prompt whose cut keeps nothing of the conversation before it: the last turn is too big for the tail, so the cut names no entry to keep from. The
// prompt was dropped from the request and from the session, with no notice, and the model went on answering the previous task.
const PROMPT = 'PROBEPROMPT do the new task';
const reply = (h: Awaited<ReturnType<typeof harness>>, text: string) => {
	const model = h.session.model!;
	return { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop', api: model.api, provider: model.provider, model: model.id, timestamp: 0,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
};
for (const turns of [1, 2])
test(`a prompt whose cut keeps nothing still reaches the model and stays in the session (${turns} earlier turn${turns > 1 ? 's' : ''})`, async () => {
	const h = await harness({ at: 'prompt', noHistory: true, limits: { contextWindow: 81920, maxTokens: 8192 }, reserveTokens: 16384, keepRecent: 20000, complete: 0, host: 0 });
	const requests: string[] = [];
	h.extension().on('context_with_system', event => { requests.push(JSON.stringify(event.messages)); });
	try {
		for (let t = 0; t < turns; t++) {
			h.manager.appendMessage({ role: 'user', content: `Task ${t}`, timestamp: 0 });
			h.manager.appendMessage(reply(h, 'word '.repeat(t === turns - 1 ? 53000 : 200)) as never);
		}
		await h.session.prompt(PROMPT);
		expect(h.manager.getEntries().filter(entry => entry.type === 'compaction')).toHaveLength(1);
		expect(requests.at(-1)).toContain(PROMPT);
		// The request does not also carry the old turn the cut removed, and a reload sees what the model saw.
		expect(requests.at(-1)!.length).toBeLessThan(150_000);
		const saved = JSON.stringify(h.manager.buildSessionProjection().messages);
		expect(saved).toContain(PROMPT);
		expect(saved).toContain('Finished');
	} finally { await h.cleanup(); }
}, 120000);
