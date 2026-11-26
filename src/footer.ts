import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { tuckCuts } from "./status.js";

/**
 * pi-tuck's footer in place of Pi's: the folder and branch line, then how full the context is against pi-tuck's trim point (a full bar
 * means pi-tuck trims), the trim count once there is one, the cost when there is one, and the model; other extensions' statuses below. The figures are computed only after
 * a reply, a trim, or a model or thinking change, and cached; a render reads the cache and Pi's own cached branch and statuses. It reads;
 * it changes nothing the model sees.
 */
export interface FooterFigures {
	/** Context tokens as Pi reports them, or the last trim's size (estimated) right after a trim, before the next reply. */
	tokens: number | null;
	estimated: boolean;
	/** pi-tuck's trim point in tokens (the band), when pi-tuck is active for this model. */
	cut: number | undefined;
	/** pi-tuck trims on this branch so far. */
	cuts: number;
	window: number;
	cost: number;
	model: string;
	pwd: string;
	session: string | undefined;
}
/** The part of Pi's theme the footer uses. */
export interface FooterTheme { fg(color: "dim" | "warning", text: string): string }
/** Context at or above this share of the trim point shows in the warning color. */
export const NEAR_CUT = 0.85;
const BAR = 10;

/** Pi's compact token format (its footer's formatTokens). */
export const formatTokens = (n: number): string => n < 1000 ? `${n}` : n < 10_000 ? `${(n / 1000).toFixed(1)}k` : n < 1_000_000 ? `${Math.round(n / 1000)}k`
	: n < 10_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1_000_000)}M`;

type Usage = { cost?: { total?: unknown } };
const num = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;

/** Everything a render needs, from the session as it is now. The one place the footer reads the session. */
export function footerFigures(ctx: ExtensionContext, cutPoint: number | undefined, thinking: string | undefined): FooterFigures {
	let cost = 0;
	// As Pi's footer: cost from all entries (every branch), including usage carried by summaries and tool results.
	for (const entry of ctx.sessionManager.getEntries() as readonly { type: string; usage?: Usage; message?: { usage?: Usage } }[])
		cost += num((entry.type === "message" ? entry.message?.usage : entry.usage)?.cost?.total);
	const ours = tuckCuts(ctx.sessionManager.getBranch() as readonly { type: string; details?: unknown }[]), usage = ctx.getContextUsage();
	let tokens = usage?.tokens ?? null, estimated = false;
	// Pi does not know the context size between a trim and the next reply; pi-tuck's trim recorded what it left.
	const after = (ours.at(-1)?.details as { tokensAfter?: unknown } | undefined)?.tokensAfter;
	if (tokens === null && typeof after === "number") { tokens = after; estimated = true; }
	const home = process.env.HOME || process.env.USERPROFILE;
	const pwd = home && (ctx.cwd === home || ctx.cwd.startsWith(home + "/") || ctx.cwd.startsWith(home + "\\")) ? "~" + ctx.cwd.slice(home.length) : ctx.cwd;
	const model = ctx.model ? ctx.model.reasoning ? `${ctx.model.id} · ${thinking && thinking !== "off" ? thinking : "thinking off"}` : ctx.model.id : "no-model";
	return { tokens, estimated, cut: cutPoint, cuts: ours.length, window: usage?.contextWindow ?? ctx.model?.contextWindow ?? 0, cost, model, pwd, session: ctx.sessionManager.getSessionName?.() };
}

/** A bar of `cells` cells that fills toward the trim point: full means pi-tuck trims. */
export function gauge(f: Pick<FooterFigures, "tokens" | "cut">, cells: number): string {
	const filled = f.cut && f.cut > 0 ? Math.min(cells, Math.max(0, Math.round((f.tokens ?? 0) / f.cut * cells))) : 0;
	return "█".repeat(filled) + "░".repeat(cells - filled);
}

/** The footer's lines at this width, from the cached figures. Dim when healthy; the bar and size turn yellow near the trim point. */
export function footerLines(f: FooterFigures, width: number, theme: FooterTheme, branch: string | null, statuses: ReadonlyMap<string, string>): string[] {
	const dim = (s: string) => theme.fg("dim", s);
	const near = f.tokens !== null && f.cut !== undefined && f.tokens >= f.cut * NEAR_CUT;
	const hot = (s: string) => theme.fg(near ? "warning" : "dim", s);
	const size = f.tokens === null ? "?" : (f.estimated ? "~" : "") + formatTokens(f.tokens);
	// Against the trim point; with no trim point (pi-tuck off, or no window), against the window when Pi knows it.
	const of = f.cut ?? (f.window > 0 ? f.window : undefined);
	const amount = (f.cut === undefined ? "" : `${gauge(f, BAR)} `) + size + (of === undefined ? "" : ` of ${formatTokens(of)}`);
	const cost = f.cost > 0 ? ` · $${f.cost.toFixed(f.cost < 0.01 ? 3 : 2)}` : "";
	const trims = f.cuts > 0 ? ` · ${f.cuts} trim${f.cuts === 1 ? "" : "s"}` : "";
	const wide = dim("context ") + hot(amount) + dim(trims + cost);
	const room = width - visibleWidth(wide) - visibleWidth(f.model);
	// The whole line when it fits, else only the bar and the sizes.
	const stats = room >= 2 ? wide + dim(" ".repeat(room) + f.model) : truncateToWidth(hot(amount), width, dim("..."));
	const pwd = f.pwd + (branch ? ` (${branch})` : "") + (f.session ? ` • ${f.session}` : "");
	const lines = [truncateToWidth(dim(pwd), width, dim("...")), stats];
	if (statuses.size > 0) lines.push(truncateToWidth([...statuses.entries()].sort(([a], [b]) => a.localeCompare(b))
		.map(([, text]) => text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim()).join(" "), width, dim("...")));
	return lines;
}

/** Replace Pi's footer while a UI is present. `cutPoint` is the compactor's own trim point (the number `/tuck` shows). */
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
	// After a reply, a trim, a tree move, or a model or thinking change. pi-tuck saves its trims as turn_end and agent_before_settle entries,
	// which Pi appends after every handler has run; the next turn_start and agent_settled come after both the reply and the trim are saved.
	for (const event of ["turn_start", "agent_settled", "session_compact", "session_tree", "model_select", "thinking_level_select"] as const)
		pi.on(event as "turn_start", (_event, ctx) => refresh(ctx));
}
