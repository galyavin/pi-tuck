import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The models.json check: once per Pi process, in the background at session start, for a model of a provider defined in models.json,
 * read the server's own model list and compare the context window and the thinking levels with the config. With a UI each difference
 * is a yes/no question; yes edits only the reported fields (after a dated backup), no is remembered in pi-tuck.json for that server
 * value. Without a UI nothing is printed: the findings go to the session and to /tuck. It changes nothing the model sees.
 */
export const CONFIG_CHECK_ENTRY = "pi-tuck-config-check";
/** Pi's thinking levels that a server can list; "off" is never a server effort. */
const LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
type Map = Partial<Record<string, string | null>>;

/** What the server says about one model. Window from the first of these it reports; never n_ctx_train (the training length). */
export interface ServerModel { window?: number; efforts?: string[] }
export function serverModel(body: unknown, id: string): ServerModel | undefined {
	const data = (body as { data?: unknown } | null)?.data;
	const entry = Array.isArray(data) ? data.find(m => (m as { id?: unknown } | null)?.id === id) as Record<string, unknown> | undefined : undefined;
	if (!entry) return undefined;
	const window = ["max_model_len", "context_length", "context_window", "n_ctx"].map(k => entry[k]).find(v => Number.isSafeInteger(v) && (v as number) > 0) as number | undefined;
	const raw = (entry.reasoning as { efforts?: unknown } | null | undefined)?.efforts;
	const efforts = Array.isArray(raw) && raw.every(e => typeof e === "string") ? raw as string[] : undefined;
	return { window, efforts };
}

export interface Finding {
	kind: "window" | "thinking";
	/** The server value a "no" is remembered against. */
	server: string;
	question: string;
	/** The fields to set on the model in models.json. */
	patch: { contextWindow?: number; thinkingLevelMap?: Map };
}
const k = (n: number) => n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`;

/** The differences between the config and the server; the thinking levels only for a reasoning model whose server lists efforts. */
export function findings(model: { contextWindow: number; reasoning?: boolean; thinkingLevelMap?: Map }, server: ServerModel): Finding[] {
	const out: Finding[] = [];
	const w = server.window, c = model.contextWindow;
	if (w !== undefined && w !== c) out.push({ kind: "window", server: String(w), patch: { contextWindow: w }, question: w > c
		? `Server allows ${k(w)}, config says ${k(c)}. Use ${k(w)}?`
		: `Config says ${k(c)}, but the server allows only ${k(w)}: requests past ${k(w)} will fail. Use ${k(w)}?` });
	if (model.reasoning && server.efforts) {
		const map: Map = {};
		for (const level of LEVELS) {
			const want = server.efforts.includes(level) ? level : null;
			if (model.thinkingLevelMap?.[level] !== want) map[level] = want;
		}
		const on = LEVELS.filter(l => typeof model.thinkingLevelMap?.[l] === "string").join(", ") || "none";
		if (Object.keys(map).length) out.push({ kind: "thinking", server: server.efforts.join(","), patch: { thinkingLevelMap: map },
			question: `Server thinking levels: ${server.efforts.join(", ") || "none"}; config enables: ${on}. Match the server?` });
	}
	return out;
}

/** JSON with // and /* comments removed outside strings (Pi accepts comments in models.json). */
export function stripComments(text: string): string {
	let out = "", i = 0, str = false;
	while (i < text.length) {
		const ch = text[i]!, next = text[i + 1];
		if (str) { out += ch; if (ch === "\\") { out += next ?? ""; i += 2; continue; } if (ch === '"') str = false; i++; continue; }
		if (ch === '"') { str = true; out += ch; i++; continue; }
		if (ch === "/" && next === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
		if (ch === "/" && next === "*") { const end = text.indexOf("*/", i + 2); i = end < 0 ? text.length : end + 2; continue; }
		out += ch; i++;
	}
	return out;
}

type ModelsFile = { providers?: Record<string, { baseUrl?: unknown; models?: { id?: unknown }[] }> };
const stamp = (d: Date) => d.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
/** The exact edit, for a models.json Pi accepts but pi-tuck will not rewrite (it has comments). */
export const editText = (path: string, provider: string, id: string, patch: Finding["patch"]) =>
	`In ${path}, provider "${provider}", model "${id}": ` + Object.entries(patch.thinkingLevelMap ?? {}).map(([l, v]) => `set thinkingLevelMap.${l} to ${JSON.stringify(v)}`)
		.concat(patch.contextWindow === undefined ? [] : [`set contextWindow to ${patch.contextWindow}`]).join("; ") + ".";

/** Apply the accepted fields: back up models.json next to it, then write only those fields. Says what to tell the operator. */
export function applyPatch(path: string, provider: string, id: string, patch: Finding["patch"], now = new Date()): { outcome: "updated" | "edit shown" | "unchanged"; text: string } {
	const text = readFileSync(path, "utf8");
	let file: ModelsFile;
	try { file = JSON.parse(text) as ModelsFile; } catch {
		return { outcome: "edit shown", text: `pi-tuck: ${path} has comments, so pi-tuck did not change it. ${editText(path, provider, id, patch)} Then restart Pi.` };
	}
	const model = file.providers?.[provider]?.models?.find(m => m.id === id) as Record<string, unknown> | undefined;
	if (!model) return { outcome: "unchanged", text: `pi-tuck: ${provider}/${id} is no longer in ${path}; nothing changed.` };
	if (patch.contextWindow !== undefined) model.contextWindow = patch.contextWindow;
	if (patch.thinkingLevelMap) model.thinkingLevelMap = { ...(model.thinkingLevelMap as Map | undefined), ...patch.thinkingLevelMap };
	const backup = `${path}.before-pi-tuck-${stamp(now)}`;
	copyFileSync(path, backup);
	writeFileSync(path, JSON.stringify(file, null, 2) + "\n");
	return { outcome: "updated", text: `pi-tuck: updated ${path} (backup ${backup}). Restart Pi to use it.` };
}

/** Remembered "no" answers in pi-tuck.json: {"configCheck": {"provider/model": {"window": "272000", "thinking": "high,xhigh"}}}. */
export function declined(settingsPath: string): Record<string, Partial<Record<Finding["kind"], string>>> {
	try {
		const value = JSON.parse(readFileSync(settingsPath, "utf8")) as { configCheck?: unknown };
		return value.configCheck && typeof value.configCheck === "object" ? value.configCheck as Record<string, Partial<Record<Finding["kind"], string>>> : {};
	} catch { return {}; }
}
export function rememberNo(settingsPath: string, ref: string, finding: Finding): void {
	let value: Record<string, unknown> = {};
	try { value = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>; } catch (error) {
		if ((error as { code?: unknown }).code !== "ENOENT") return; // an unreadable pi-tuck.json is left alone
	}
	const all = { ...declined(settingsPath) };
	all[ref] = { ...all[ref], [finding.kind]: finding.server };
	writeFileSync(settingsPath, JSON.stringify({ ...value, configCheck: all }, null, 2) + "\n");
}

export interface CheckDeps { agentDir: string; fetch?: typeof fetch; now?: () => Date }

/** One check of the session's model. Resolves when done; never throws. */
export async function checkModel(pi: Pick<ExtensionAPI, "appendEntry">, ctx: ExtensionContext, deps: CheckDeps): Promise<void> {
	try {
		const model = ctx.model, registry = ctx.modelRegistry as { getApiKeyAndHeaders?: (m: unknown) => Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string>; baseUrl?: string }> } | undefined;
		if (!model || typeof registry?.getApiKeyAndHeaders !== "function") return;
		const modelsPath = join(deps.agentDir, "models.json"), settingsPath = join(deps.agentDir, "pi-tuck.json");
		let file: ModelsFile;
		try { file = JSON.parse(stripComments(readFileSync(modelsPath, "utf8"))) as ModelsFile; } catch { return; }
		const provider = file.providers?.[model.provider];
		if (typeof provider?.baseUrl !== "string" || !provider.models?.some(m => m.id === model.id)) return;
		const auth = await registry.getApiKeyAndHeaders(model);
		if (!auth.ok) return;
		const base = (auth.baseUrl ?? model.baseUrl ?? provider.baseUrl).replace(/\/+$/, "");
		const headers: Record<string, string> = { ...(auth.apiKey ? { Authorization: `Bearer ${auth.apiKey}` } : {}), ...auth.headers };
		const response = await (deps.fetch ?? fetch)(`${base}/models`, { headers, signal: AbortSignal.timeout(10_000) });
		if (!response.ok) return;
		const server = serverModel(await response.json(), model.id);
		if (!server) return;
		const ref = `${model.provider}/${model.id}`, no = declined(settingsPath)[ref] ?? {};
		const open = findings(model as never, server).filter(f => no[f.kind] !== f.server);
		if (!open.length) return;
		const lines = open.map(f => f.question.replace(/\?$/, "."));
		if (!ctx.hasUI) { pi.appendEntry(CONFIG_CHECK_ENTRY, { model: ref, lines, outcome: "not asked (no UI)" }); return; }
		const accepted: Finding[] = [];
		for (const f of open) {
			if (await ctx.ui.confirm(`pi-tuck: ${ref} in models.json`, f.question)) accepted.push(f);
			else rememberNo(settingsPath, ref, f);
		}
		let outcome = "declined";
		if (accepted.length) {
			const patch = Object.assign({}, ...accepted.map(f => f.patch)) as Finding["patch"];
			const told = applyPatch(modelsPath, model.provider, model.id, patch, deps.now?.());
			ctx.ui.notify(told.text, told.outcome === "updated" ? "info" : "warning");
			outcome = told.outcome;
		}
		pi.appendEntry(CONFIG_CHECK_ENTRY, { model: ref, lines, outcome });
	} catch { /* a server that does not answer, or an ended session: no check */ }
}

/** Run the check once per Pi process, in the background: session start never waits for it. */
export function installConfigCheck(pi: ExtensionAPI, deps: CheckDeps): void {
	let done = false;
	pi.on("session_start", (_event, ctx) => {
		if (done) return;
		done = true;
		void checkModel(pi, ctx, deps);
	});
}
