import { expect, test } from 'vitest';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { installCompaction } from '../src/compaction';
import { bandOf } from '../src/budget';
import { footerLines, gauge, installFooter, type FooterFigures } from '../src/footer';

// The footer replaces Pi's: its cut mark is pi-tuck's own cut point (the number /tuck gives), and a render only reads cached figures.
const plain = { fg: (_color: string, text: string) => text };
const colored = { fg: (color: string, text: string) => `<${color}>${text}</${color}>` };
const model = { provider: 'p', id: 'm', api: 'openai-completions', contextWindow: 68_000, maxTokens: 8_192, reasoning: true };

async function fixture(branch: unknown[] = []) {
	const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
	const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
	const pi = {
		on: (name: string, h: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, [...(handlers.get(name) ?? []), h]); return () => {}; },
		registerCommand: (name: string, c: { handler: (args: string, ctx: unknown) => Promise<void> }) => { commands.set(name, c.handler); },
		registerTool: () => {}, getActiveTools: () => [], getAllTools: () => [], appendEntry: () => {}, getThinkingLevel: () => 'high',
	} as unknown as ExtensionAPI;
	const handle = await installCompaction(pi, {});
	installFooter(pi, ctx => handle.cutPoint(ctx));
	const reads = { usage: 0, entries: 0 }, notices: string[] = [];
	let factory: ((tui: unknown, theme: unknown, data: unknown) => { render(width: number): string[] }) | undefined;
	const entries = [
		{ type: 'message', message: { role: 'assistant', usage: { input: 2_000, output: 3_400, cacheRead: 10_000, cacheWrite: 0, cost: { total: 0.12 } } } },
		...branch,
	];
	const ctx = {
		hasUI: true, cwd: '/work/repo', model,
		ui: { notify: (m: string) => notices.push(m), setFooter: (f: typeof factory) => { factory = f; } },
		sessionManager: { getBranch: () => branch, getEntries: () => { reads.entries++; return entries; }, getSessionName: () => undefined },
		getContextUsage: () => { reads.usage++; return { tokens: 41_000, contextWindow: model.contextWindow, percent: 60 }; },
	};
	const fire = async (name: string) => { for (const h of handlers.get(name) ?? []) { try { await h({}, ctx); } catch { /* other handlers need a fuller context */ } } };
	await fire('session_start');
	const renders = { requested: 0 };
	const footer = factory!({ requestRender: () => { renders.requested++; } }, plain,
		{ getGitBranch: () => 'main', getExtensionStatuses: () => new Map([['b', 'second'], ['a', 'first']]), onBranchChange: () => () => {} });
	return { handle, ctx, footer, reads, renders, fire, notices, commands };
}

test('the cut mark is pi-tuck\'s cut point, the number /tuck gives', async () => {
	const f = await fixture();
	const cut = f.handle.cutPoint(f.ctx as never)!;
	// Pi's default reserve (16,384) leaves a room of 51,616; the default cuts at the room less the 2% margin.
	expect(cut).toBe(bandOf(68_000 - 16_384));
	expect(cut).toBe(50_583);
	const [pwd, stats, statuses] = f.footer.render(160);
	expect(pwd).toBe('/work/repo (main)');
	expect(stats).toContain(`context ${gauge({ tokens: 41_000, cut, window: 68_000 }, 12)} 41k · cut ~51k · window 68k · 0 cuts │ in 2.0k out 3.4k cache 83% $0.12`);
	expect(stats).toMatch(/ {2,}m · high$/);
	expect(statuses).toBe('first second');
	await f.commands.get('tuck')!('', f.ctx);
	expect(f.notices.at(-1)).toContain('Cut point: the room less a 2% margin (about 50,583 tokens with this model).');
});

test('the mark sits at the cut point\'s share of the window', () => {
	expect(gauge({ tokens: 41_000, cut: 50_583, window: 68_000 }, 12)).toBe('███████░░┊░░░');
	expect(gauge({ tokens: 0, cut: 68_000, window: 68_000 }, 4)).toBe('░░░░┊');
	expect(gauge({ tokens: 90_000, cut: undefined, window: 68_000 }, 4)).toBe('████');
});

test('renders do not recompute: only a reply, a cut or a model change does', async () => {
	const f = await fixture();
	const before = { ...f.reads };
	for (let i = 0; i < 50; i++) for (const width of [200, 80, 30]) f.footer.render(width);
	expect(f.reads).toEqual(before);
	await f.fire('turn_end');
	expect(f.reads).toEqual({ usage: before.usage + 1, entries: before.entries + 1 });
	expect(f.renders.requested).toBe(1);
	for (const event of ['session_compact', 'model_select', 'thinking_level_select']) await f.fire(event);
	expect(f.reads).toEqual({ usage: before.usage + 4, entries: before.entries + 4 });
});

const figures: FooterFigures = { tokens: 41_000, estimated: false, cut: 50_583, window: 68_000, cuts: 2, input: 12_000, output: 3_400,
	cacheRead: 85, cacheWrite: 0, cacheHit: 85, cost: 0.12, model: 'model · high', pwd: '~/repo', session: undefined };

test('narrow terminals get the short form', () => {
	const stats = footerLines(figures, 40, plain, null, new Map())[1];
	expect(stats).toBe('███████░░┊░░ 41k/51k · 2 cuts'.replace('███████░░┊░░', gauge(figures, 9)));
	expect(stats.length).toBeLessThanOrEqual(40);
});

test('dim when healthy, yellow near the cut point, never red', () => {
	const healthy = footerLines(figures, 160, colored, null, new Map())[1]!;
	expect(healthy).not.toContain('<warning>');
	const near = footerLines({ ...figures, tokens: 45_000 }, 160, colored, null, new Map())[1]!;
	expect(near).toContain(`<warning>${gauge({ ...figures, tokens: 45_000 }, 12)} 45k</warning>`);
	expect(near + healthy).not.toContain('<error>');
});

test('right after a cut, before the next reply, the size is the cut\'s own estimate', async () => {
	const f = await fixture([{ type: 'compaction', tokensBefore: 50_000, details: { compactor: 'pi-tuck', tokensAfter: 9_000 } }]);
	f.ctx.getContextUsage = () => ({ tokens: null, contextWindow: 68_000, percent: null }) as never;
	await f.fire('session_compact');
	expect(f.footer.render(160)[1]).toContain(' ~9.0k · cut ~51k · window 68k · 1 cut │');
});

test('no UI, no footer', async () => {
	const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
	const pi = { on: (name: string, h: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, [...(handlers.get(name) ?? []), h]); } } as unknown as ExtensionAPI;
	installFooter(pi, () => 1);
	let set = 0;
	for (const h of handlers.get('session_start')!) await h({}, { hasUI: false, ui: { setFooter: () => { set++; } } });
	expect(set).toBe(0);
});
