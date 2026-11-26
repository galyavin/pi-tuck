import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPatch, checkModel, editText, findings, serverModel, stripComments, CONFIG_CHECK_ENTRY } from '../src/config-check';
import { statusText } from '../src/status';

// A real mac-studio /v1/models reply, recorded 2026-11-20 (only the model entry was logged; the list wrapper is added).
const recorded = JSON.parse(readFileSync(join(__dirname, 'fixtures/mac-studio-models-20261120.json'), 'utf8'));
// The same server after its 2026-11-25 change, with the fields as reported to us: max_model_len 272000, efforts high and xhigh.
const current = { object: 'list', data: [{ ...recorded.data[0], display_name: 'Inkling 2 Mini', max_model_len: 272_000, reasoning: { thinks: true, efforts: ['high', 'xhigh'], default: 'xhigh' } }] };
// m5-air (llama.cpp-based server) as reported: max_model_len and context_length both 98304.
const m5 = { object: 'list', data: [{ id: 'mba-main', object: 'model', max_model_len: 98_304, context_length: 98_304 }] };
const off = { off: null, minimal: null, low: null, medium: null };
const oldConfig = { id: 'main', name: 'Qwen', contextWindow: 131_072, reasoning: true, thinkingLevelMap: { ...off, high: null, xhigh: 'xhigh', max: null } };

test('reads the window and thinking levels the server reports', () => {
	expect(serverModel(recorded, 'main')).toEqual({ window: 131_072, efforts: ['xhigh'] });
	expect(serverModel(current, 'main')).toEqual({ window: 272_000, efforts: ['high', 'xhigh'] });
	expect(serverModel(m5, 'mba-main')).toEqual({ window: 98_304, efforts: undefined });
	expect(serverModel(current, 'other')).toBeUndefined();
	// n_ctx_train is the training length, not what the server allows.
	expect(serverModel({ data: [{ id: 'x', n_ctx_train: 131_072, meta: { n_ctx_train: 131_072 } }] }, 'x')).toEqual({ window: undefined, efforts: undefined });
	expect(serverModel({ data: [{ id: 'x', n_ctx: 8_192 }] }, 'x')!.window).toBe(8_192);
});

test('the old mac-studio config against the server: a bigger window and an unmapped thinking level', () => {
	const found = findings(oldConfig, serverModel(current, 'main')!);
	expect(found.map(f => f.question)).toEqual([
		'Server allows 272k, config says 131k. Use 272k?',
		'Server thinking levels: high, xhigh; config enables: xhigh. Match the server?',
	]);
	expect(found[0]!.patch).toEqual({ contextWindow: 272_000 });
	expect(found[1]!.patch).toEqual({ thinkingLevelMap: { high: 'high' } });
	expect(found.map(f => f.server)).toEqual(['272000', 'high,xhigh']);
});

test('a config window above the server is unsafe and says so; a matching config finds nothing', () => {
	const [over] = findings({ contextWindow: 272_000, reasoning: true, thinkingLevelMap: { ...off, high: null, xhigh: 'xhigh', max: null } }, serverModel(recorded, 'main')!);
	expect(over!.question).toBe('Config says 272k, but the server allows only 131k: requests past 131k will fail. Use 131k?');
	expect(findings({ contextWindow: 98_304, reasoning: true }, serverModel(m5, 'mba-main')!)).toEqual([]);
	expect(findings({ contextWindow: 272_000, reasoning: true, thinkingLevelMap: { ...off, high: 'high', xhigh: 'xhigh', max: null } }, serverModel(current, 'main')!)).toEqual([]);
	// A level the server does not list is turned off; a non-reasoning model's levels are not compared.
	expect(findings({ contextWindow: 131_072, reasoning: true, thinkingLevelMap: { ...off, high: 'high', xhigh: 'xhigh', max: null } }, serverModel(recorded, 'main')!)[0]!.patch)
		.toEqual({ thinkingLevelMap: { high: null } });
	expect(findings({ contextWindow: 131_072, reasoning: false }, serverModel(recorded, 'main')!)).toEqual([]);
});

const temp = () => mkdtempSync(join(tmpdir(), 'pi-tuck-config-'));
const modelsFile = (dir: string, text?: string) => {
	const path = join(dir, 'models.json');
	writeFileSync(path, text ?? JSON.stringify({ providers: {
		'mac-studio': { baseUrl: 'http://studio.test/v1', api: 'openai-completions', apiKey: 'K', models: [{ ...oldConfig, maxTokens: 65_536, compat: { thinkingFormat: 'chat-template' } }] },
		other: { baseUrl: 'http://other.test/v1', models: [{ id: 'keep', contextWindow: 1 }] },
	} }, null, 2) + '\n');
	return path;
};

test('apply: a dated backup next to models.json, then only the reported fields change', () => {
	const dir = temp(), path = modelsFile(dir), before = readFileSync(path, 'utf8');
	const told = applyPatch(path, 'mac-studio', 'main', { contextWindow: 272_000, thinkingLevelMap: { high: 'high' } }, new Date('2026-11-26T05:30:00Z'));
	expect(told).toEqual({ outcome: 'updated', text: `pi-tuck: updated ${path} (backup ${path}.before-pi-tuck-20261126-053000). Restart Pi to use it.` });
	expect(readFileSync(`${path}.before-pi-tuck-20261126-053000`, 'utf8')).toBe(before);
	const after = JSON.parse(readFileSync(path, 'utf8')), was = JSON.parse(before);
	was.providers['mac-studio'].models[0].contextWindow = 272_000;
	was.providers['mac-studio'].models[0].thinkingLevelMap.high = 'high';
	expect(after).toEqual(was);
});

test('apply with comments in models.json: nothing written, the exact edit shown', () => {
	const dir = temp(), text = '// my models\n' + readFileSync(modelsFile(temp()), 'utf8'), path = modelsFile(dir, text);
	const told = applyPatch(path, 'mac-studio', 'main', { contextWindow: 272_000, thinkingLevelMap: { high: 'high' } });
	expect(told.outcome).toBe('edit shown');
	expect(told.text).toBe(`pi-tuck: ${path} has comments, so pi-tuck did not change it. In ${path}, provider "mac-studio", model "main": set thinkingLevelMap.high to "high"; set contextWindow to 272000. Then restart Pi.`);
	expect(readFileSync(path, 'utf8')).toBe(text);
	expect(readdirSync(dir)).toEqual(['models.json']);
	expect(JSON.parse(stripComments('{"a": "x // not a comment", /* b */ "c": 1}'))).toEqual({ a: 'x // not a comment', c: 1 });
	expect(editText('m.json', 'p', 'i', { contextWindow: 5 })).toBe('In m.json, provider "p", model "i": set contextWindow to 5.');
});

afterEach(() => { vi.restoreAllMocks(); });

function session(dir: string, opts: { hasUI: boolean; answers?: boolean[]; body?: unknown; provider?: string; registry?: unknown }) {
	const entries: { customType: string; data: unknown }[] = [], notices: string[] = [], asked: string[] = [], urls: string[] = [], auths: unknown[] = [];
	const answers = [...(opts.answers ?? [])];
	const model = { ...oldConfig, provider: opts.provider ?? 'mac-studio', baseUrl: 'http://studio.test/v1', api: 'openai-completions', maxTokens: 65_536 };
	const ctx = {
		hasUI: opts.hasUI, model,
		modelRegistry: opts.registry ?? { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: 'K', headers: { 'X-Extra': '1' } }) },
		ui: { confirm: async (_t: string, q: string) => { asked.push(q); return answers.shift() ?? false; }, notify: (m: string) => { notices.push(m); } },
	};
	const pi = { appendEntry: (customType: string, data: unknown) => { entries.push({ customType, data }); } };
	const fetch = (async (url: string, init: { headers: unknown }) => { urls.push(url); auths.push(init.headers); return new Response(JSON.stringify(opts.body ?? current)); }) as never;
	return { run: () => checkModel(pi as never, ctx as never, { agentDir: dir, fetch, now: () => new Date('2026-11-26T05:30:00Z') }), entries, notices, asked, urls, auths };
}

test('without a UI: the findings go to the session and /tuck, nothing to stdout or stderr, nothing written', async () => {
	const dir = temp(), path = modelsFile(dir), before = readFileSync(path, 'utf8');
	const out = vi.spyOn(process.stdout, 'write'), err = vi.spyOn(process.stderr, 'write');
	const s = session(dir, { hasUI: false });
	await s.run();
	expect(out).not.toHaveBeenCalled();
	expect(err).not.toHaveBeenCalled();
	expect(s.urls).toEqual(['http://studio.test/v1/models']);
	expect(s.auths).toEqual([{ Authorization: 'Bearer K', 'X-Extra': '1' }]);
	expect(s.entries).toEqual([{ customType: CONFIG_CHECK_ENTRY, data: { model: 'mac-studio/main', outcome: 'not asked (no UI)',
		lines: ['Server allows 272k, config says 131k. Use 272k.', 'Server thinking levels: high, xhigh; config enables: xhigh. Match the server.'] } }]);
	expect(readFileSync(path, 'utf8')).toBe(before);
	const status = statusText({ version: '1.6.0', active: true, branch: s.entries.map(e => ({ type: 'custom', ...e })), cutAt: undefined });
	expect(status).toContain('models.json check for mac-studio/main (not asked (no UI)):\n  Server allows 272k, config says 131k. Use 272k.\n  Server thinking levels');
});

test('with a UI: yes edits models.json and says restart; no is remembered for that server value only', async () => {
	const dir = temp(), path = modelsFile(dir);
	const first = session(dir, { hasUI: true, answers: [true, false] });
	await first.run();
	expect(first.asked).toHaveLength(2);
	expect(JSON.parse(readFileSync(path, 'utf8')).providers['mac-studio'].models[0].contextWindow).toBe(272_000);
	expect(first.notices).toEqual([`pi-tuck: updated ${path} (backup ${path}.before-pi-tuck-20261126-053000). Restart Pi to use it.`]);
	expect(JSON.parse(readFileSync(join(dir, 'pi-tuck.json'), 'utf8'))).toEqual({ configCheck: { 'mac-studio/main': { thinking: 'high,xhigh' } } });
	expect(first.entries.at(-1)!.data).toMatchObject({ outcome: 'updated' });
	// The session still runs on the old window, so the window is asked again; the declined thinking levels are not.
	const second = session(dir, { hasUI: true, answers: [false] });
	await second.run();
	expect(second.asked).toEqual(['Server allows 272k, config says 131k. Use 272k?']);
	expect(JSON.parse(readFileSync(join(dir, 'pi-tuck.json'), 'utf8'))).toEqual({ configCheck: { 'mac-studio/main': { thinking: 'high,xhigh', window: '272000' } } });
	const third = session(dir, { hasUI: true });
	await third.run();
	expect(third.asked).toEqual([]);
	// A new server value asks again.
	const changed = { object: 'list', data: [{ ...current.data[0], max_model_len: 200_000, reasoning: { efforts: ['xhigh', 'max'] } }] };
	const fourth = session(dir, { hasUI: true, body: changed });
	await fourth.run();
	expect(fourth.asked).toHaveLength(2);
});

test('a remembered no keeps the rest of pi-tuck.json', async () => {
	const dir = temp();
	modelsFile(dir);
	writeFileSync(join(dir, 'pi-tuck.json'), JSON.stringify({ cutAt: 0.8 }));
	await session(dir, { hasUI: true, answers: [false, false] }).run();
	expect(JSON.parse(readFileSync(join(dir, 'pi-tuck.json'), 'utf8'))).toEqual({ cutAt: 0.8, configCheck: { 'mac-studio/main': { window: '272000', thinking: 'high,xhigh' } } });
});

test('no request for a provider outside models.json, or on a Pi without request auth for extensions', async () => {
	const dir = temp();
	modelsFile(dir);
	const builtIn = session(dir, { hasUI: false, provider: 'openai' });
	await builtIn.run();
	expect(builtIn.urls).toEqual([]);
	const oldPi = session(dir, { hasUI: false, registry: {} });
	await oldPi.run();
	expect(oldPi.urls).toEqual([]);
	const noFile = session(temp(), { hasUI: false });
	await noFile.run();
	expect(noFile.urls).toEqual([]);
});
