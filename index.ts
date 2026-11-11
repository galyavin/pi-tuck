import { VERSION, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { installCompaction } from "./src/compaction";
import { validCutAt } from "./src/budget";
import { createSemanticRecall } from "./src/semantic-recall";
import { defaultRoot, runtimeConfigPath } from "./src/assets";
import { ensureSemanticRuntime } from "./src/setup";

export type { CompactionOptions } from "./src/compaction";
export { installCompaction } from "./src/compaction";
export { inspectIncident, readableIncident } from "./src/diagnostic-replay.js";
export { createSemanticRecall, SemanticRecallController } from "./src/semantic-recall";
export type { SemanticRecallConfig, PriorResult, SemanticState, SemanticSetup } from "./src/semantic-recall";
export { ensureSemanticRuntime } from "./src/setup";

/** pi-tuck as a Pi extension: compaction and history recall always; semantic recall too, unless `pi-tuck.json` in Pi's agent folder
 * says `{"semanticRecall": false}`. Its runtime is set up in the background the first time a session starts. The same file's `"cutAt"`
 * (a number above 0 and at most 1) is the fraction of the input room a cut is triggered at, 0.6 by default. */
/** The oldest Pi with every hook and API pi-tuck uses, and the oldest its tests pass on (Pi 1.2 added the custom message that starts a
 * run to before_agent_start, which the prompt's cut counts). */
export const PI_FLOOR = "1.2.0";
/** Whether a Pi version is at or above the floor. A version that does not parse is taken as supported. */
export function piSupported(version: string): boolean {
	const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version)?.slice(1).map(Number), floor = PI_FLOOR.split(".").map(Number);
	if (!parts) return true;
	for (let i = 0; i < 3; i++) if (parts[i] !== floor[i]) return parts[i]! > floor[i]!;
	return true;
}

export default async function (pi: ExtensionAPI) {
	// On an older Pi pi-tuck stays off, so Pi's own compaction runs, and says so once.
	if (!piSupported(VERSION)) {
		let told = false;
		pi.on("session_start", (_event, ctx) => {
			if (told) return;
			told = true;
			try { ctx.ui.notify(`pi-tuck needs Pi ${PI_FLOOR} or later (this is Pi ${VERSION}); it is off, and Pi's own compaction runs.`, "warning"); } catch { /* ended */ }
		});
		return;
	}
	const semanticRecall = createSemanticRecall();
	// `/tuck-semantic off` holds for the rest of the session, including over a setup that finishes later.
	const settings = readSettings(join(getAgentDir(), "pi-tuck.json"));
	// Semantic recall runs on Metal, so only on Apple silicon; elsewhere the model is not offered tuck_search at all.
	const appleSilicon = process.platform === "darwin" && process.arch === "arm64";
	const handle = await installCompaction(pi, { semanticRecall, search: appleSilicon, cutAt: settings.cutAt, onSemanticSetting: async enabled => {
		if (!enabled) semanticRecall.setSetup("off-user");
		else if (semanticRecall.status().setup === "off-user") semanticRecall.setSetup("starting", { installed: existsSync(runtimeConfigPath(defaultRoot())) });
	} });
	if (settings.semanticRecall === false) {
		semanticRecall.setSetup("off-settings");
		pi.on("session_start", () => { semanticRecall.setSetup("off-settings"); });
		return;
	}
	let session = 0, said = "", announced = false, setup: Promise<unknown> | undefined;
	// A context outlives its session (a setup can finish after /new); a notice to an ended session is dropped.
	// With no UI (pi -p), Pi shows no notices, so a settings error or an off or failing semantic recall would go unsaid: write each to stderr
	// instead, once per session. stderr is the operator's; it never enters the model's context.
	const stderrSaid = new Set<string>();
	const say = (ctx: ExtensionContext, message: string, level: "info" | "warning") => {
		if (!ctx.hasUI) { if (!stderrSaid.has(message)) { stderrSaid.add(message); try { process.stderr.write(message + "\n"); } catch { /* closed */ } } return; }
		try { ctx.ui.notify(message, level); } catch { /* ended */ }
	};
	const once = (ctx: ExtensionContext, message: string, level: "info" | "warning") => { if (said !== message) { said = message; say(ctx, message, level); } };
	const announce = (ctx: ExtensionContext, state: Parameters<typeof semanticRecall.setSetup>[0], detail?: Parameters<typeof semanticRecall.setSetup>[1]) => {
		semanticRecall.setSetup(state, detail);
		const notice = semanticRecall.setupNotice();
		if (notice) (state === "off-platform" || state === "off-project" ? once : say)(ctx, notice.message, notice.level);
	};
	pi.on("session_shutdown", () => { session++; });
	pi.on("session_start", (_event, ctx) => {
		const current = ++session;
		stderrSaid.clear();
		if (settings.error) once(ctx, `pi-tuck: ${settings.error}; using the defaults.`, "warning");
		if (!appleSilicon)
			return announce(ctx, "off-platform");
		// Semantic recall keeps its runtime and indexes outside the project it serves, so not when Pi runs in a folder that holds its
		// agent folder, such as the home folder.
		if (within(real(getAgentDir()), real(ctx.cwd)))
			return announce(ctx, "off-project");
		// A run with no UI (pi -p, RPC, JSON) uses a runtime that is already installed: that needs no download. It does not start a first-time
		// setup, which would outlast a one-shot run, and it says why, so tuck_search and /tuck name the real state.
		const installed = existsSync(runtimeConfigPath(defaultRoot()));
		if (!ctx.hasUI && !installed) return announce(ctx, "not-installed");
		// The download's announcement outlives the session that made it: a session that starts while the shared setup is still running
		// owes the "set up" notice once, as before the refactor.
		semanticRecall.setSetup("starting", { installed, announced });
		setup ??= ensureSemanticRuntime(defaultRoot(), message => {
			announced = true;
			if (current === session && semanticRecall.status().setup !== "off-user") announce(ctx, "starting", { installed, notice: message, announced: true });
		});
		setup.then(async () => {
			if (current !== session || semanticRecall.status().setup === "off-user") return;
			try {
				await handle.setSemanticEnabled(true, ctx);
				if (current === session && semanticRecall.status().setup !== "off-user") { announce(ctx, "ready", { announced }); announced = false; }
			} catch (error) {
				if (current === session && semanticRecall.status().setup !== "off-user") announce(ctx, "failed", { stage: "start", reason: reason(error) });
			}
		}, error => {
			setup = undefined; // the next session start tries again
			if (current === session && semanticRecall.status().setup !== "off-user") announce(ctx, "failed", { stage: "setup", reason: reason(error) });
		});
	});
}

function readSettings(path: string): { semanticRecall?: boolean; cutAt?: number; error?: string } {
	let text: string;
	try { text = readFileSync(path, "utf8"); } catch { return {}; }
	try {
		const value = JSON.parse(text);
		if (value && typeof value === "object" && (value.semanticRecall === undefined || typeof value.semanticRecall === "boolean") &&
			(value.cutAt === undefined || validCutAt(value.cutAt))) return value;
	} catch { /* reported below */ }
	return { error: `${path} should be a JSON object like {"semanticRecall": false, "cutAt": 0.8}, with cutAt a number above 0 and at most 1` };
}

const reason = (error: unknown) => error instanceof Error ? error.message : String(error);
const within = (path: string, folder: string) => path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep);
const real = (path: string) => { try { return realpathSync(path); } catch { return path; } };
