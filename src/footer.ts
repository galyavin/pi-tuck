import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { tuckCuts } from "./status.js";

/**
 * pi-tuck's footer in place of Pi's: the context gauge with pi-tuck's cut mark, the cut count, Pi's token and cost figures, the model, the
 * pwd/branch line and other extensions' statuses. The figures are computed only after a reply, a cut, or a model or thinking change, and
 * cached; a render reads the cache and Pi's own cached branch and statuses. It reads; it changes nothing the model sees.
 */
export interface FooterFigures {
	/** Context tokens as Pi reports them, or the last cut's size (estimated) right after a cut, before the next reply. */
	tokens: number | null;
	estimated: boolean;
	/** pi-tuck's cut point in tokens (the band), when pi-tuck is active for this model. */
	cut: number | undefined;
	window: number;
	cuts: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** The latest reply's cache hit rate, in percent. */
	cacheHit: number | undefined;
	cost: number;
	model: string;
	pwd: string;
	session: string | undefined;
}
/** The part of Pi's theme the footer uses. */
export interface FooterTheme { fg(color: "dim" | "warning", text: string): string }
/** Context at or above this share of the cut point shows in the warning color. */
export const NEAR_CUT = 0.85;
const MARK = "┊";

/** Pi's compact token format (its footer's formatTokens). */
export const formatTokens = (n: number): string => n < 1000 ? `${n}` : n < 10_000 ? `${(n / 1000).toFixed(1)}k` : n < 1_000_000 ? `${Math.round(n / 1000)}k`
	: n < 10_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1_000_000)}M`;

type Usage = { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; cost?: { total?: unknown } };
const num = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;

/** Everything a render needs, from the session as it is now. The one place the footer reads the session. */
export function footerFigures(ctx: ExtensionContext, cutPoint: number | undefined, thinking: string | undefined): FooterFigures {
	const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	let cacheHit: number | undefined;
	// As Pi's footer: usage from all entries (every branch), including usage carried by summaries and tool results.
	for (const entry of ctx.sessionManager.getEntries() as readonly { type: string; usage?: Usage; message?: { role?: string; usage?: Usage } }[]) {
		const usage = entry.type === "message" ? entry.message?.usage : entry.usage;
		if (!usage) continue;
		totals.input += num(usage.input); totals.output += num(usage.output); totals.cacheRead += num(usage.cacheRead); totals.cacheWrite += num(usage.cacheWrite);
		totals.cost += num(usage.cost?.total);
		if (entry.type === "message" && entry.message?.role === "assistant") {
			const prompt = num(usage.input) + num(usage.cacheRead) + num(usage.cacheWrite);
			cacheHit = prompt > 0 ? num(usage.cacheRead) / prompt * 100 : undefined;
		}
	}
	const ours = tuckCuts(ctx.sessionManager.getBranch() as readonly { type: string; details?: unknown }[]), usage = ctx.getContextUsage();
	let tokens = usage?.tokens ?? null, estimated = false;
	// Pi does not know the context size between a cut and the next reply; pi-tuck's cut recorded what it left.
	const after = (ours.at(-1)?.details as { tokensAfter?: unknown } | undefined)?.tokensAfter;
	if (tokens === null && typeof after === "number") { tokens = after; estimated = true; }
	const home = process.env.HOME || process.env.USERPROFILE;
	const pwd = home && (ctx.cwd === home || ctx.cwd.startsWith(home + "/") || ctx.cwd.startsWith(home + "\\")) ? "~" + ctx.cwd.slice(home.length) : ctx.cwd;
	const model = ctx.model ? ctx.model.reasoning ? `${ctx.model.id} · ${thinking && thinking !== "off" ? thinking : "thinking off"}` : ctx.model.id : "no-model";
	return { tokens, estimated, cut: cutPoint, window: usage?.contextWindow ?? ctx.model?.contextWindow ?? 0, cuts: ours.length, ...totals, cacheHit, model, pwd, session: ctx.sessionManager.getSessionName?.() };
}

/** A gauge of `cells` cells for tokens over the window, with the cut mark inserted at the cut point. */
export function gauge(f: Pick<FooterFigures, "tokens" | "cut" | "window">, cells: number): string {
	const at = (n: number) => f.window > 0 ? Math.min(cells, Math.max(0, Math.round(n / f.window * cells))) : 0;
	const filled = at(f.tokens ?? 0), bar = "█".repeat(filled) + "░".repeat(cells - filled);
	if (f.cut === undefined) return bar;
	const mark = at(f.cut);
	return bar.slice(0, mark) + MARK + bar.slice(mark);
}

/** The footer's lines at this width, from the cached figures. Dim when healthy; the gauge and size turn yellow near the cut point. */
export function footerLines(f: FooterFigures, width: number, theme: FooterTheme, branch: string | null, statuses: ReadonlyMap<string, string>): string[] {
	const dim = (s: string) => theme.fg("dim", s);
	const near = f.tokens !== null && f.cut !== undefined && f.tokens >= f.cut * NEAR_CUT;
	const hot = (s: string) => theme.fg(near ? "warning" : "dim", s);
	const size = f.tokens === null ? "?" : (f.estimated ? "~" : "") + formatTokens(f.tokens);
	const cuts = `${f.cuts} cut${f.cuts === 1 ? "" : "s"}`;
	const spend = [`in ${formatTokens(f.input)}`, `out ${formatTokens(f.output)}`,
		...(f.cacheRead + f.cacheWrite > 0 && f.cacheHit !== undefined ? [`cache ${Math.round(f.cacheHit)}%`] : []),
		...(f.cost > 0 ? [`$${f.cost.toFixed(2)}`] : [])].join(" ");
	const wide = dim("context ") + hot(`${gauge(f, 12)} ${size}`) +
		dim(`${f.cut === undefined ? "" : ` · cut ~${formatTokens(f.cut)}`} · window ${formatTokens(f.window)} · ${cuts} │ ${spend}`);
	const narrow = hot(`${gauge(f, 9)} ${size}${f.cut === undefined ? "" : `/${formatTokens(f.cut)}`}`) + dim(` · ${cuts}`);
	const room = width - visibleWidth(wide) - visibleWidth(f.model);
	const stats = room >= 2 ? wide + dim(" ".repeat(room) + f.model) : visibleWidth(wide) <= width ? wide : truncateToWidth(narrow, width, dim("..."));
	const pwd = f.pwd + (branch ? ` (${branch})` : "") + (f.session ? ` • ${f.session}` : "");
	const lines = [truncateToWidth(dim(pwd), width, dim("...")), stats];
	if (statuses.size > 0) lines.push(truncateToWidth([...statuses.entries()].sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim()).join(" "), width, dim("...")));
	return lines;
}

/** Replace Pi's footer while a UI is present. `cutPoint` is the compactor's own (the number `/tuck` shows). */
export function installFooter(pi: ExtensionAPI, cutPoint: (ctx: ExtensionContext) => number | undefined): void {
	let figures: FooterFigures | undefined;
	let redraw: (() => void) | undefined;
	const refresh = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		try { figures = footerFigures(ctx, cutPoint(ctx), pi.getThinkingLevel?.()); redraw?.(); } catch { /* an ended session keeps the last figures */ }
	};
	const show = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		refresh(ctx);
		try {
			ctx.ui.setFooter((tui, theme, data) => {
				redraw = () => tui.requestRender();
				const unsubscribe = data.onBranchChange(() => tui.requestRender());
				return {
					render: (width: number) => figures ? footerLines(figures, width, theme, data.getGitBranch(), data.getExtensionStatuses()) : [],
					invalidate: () => {},
					dispose: () => { unsubscribe(); redraw = undefined; },
				};
			});
		} catch { /* a host without a footer keeps its own */ }
	};
	pi.on("session_start", (_event, ctx) => show(ctx));
	// After a reply (turn_end and agent_end run once Pi has saved it), a cut, a tree move, or a model or thinking change.
	for (const event of ["turn_end", "agent_end", "session_compact", "session_tree", "model_select", "thinking_level_select"] as const)
		pi.on(event as "turn_end", (_event, ctx) => refresh(ctx));
}
