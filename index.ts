import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";
import { installCompaction } from "./src/compaction";
import { createSemanticRecall } from "./src/semantic-recall";
import { defaultRoot } from "./src/assets";
import { ensureSemanticRuntime } from "./src/setup";

export type { CompactionOptions } from "./src/compaction";
export { installCompaction } from "./src/compaction";
export { inspectIncident, readableIncident } from "./src/diagnostic-replay.js";
export { createSemanticRecall, SemanticRecallController } from "./src/semantic-recall";
export type { SemanticRecallConfig, PriorResult, SemanticState } from "./src/semantic-recall";
export { ensureSemanticRuntime } from "./src/setup";

/** pi-tuck as a Pi extension: compaction and history recall always; semantic recall too, unless `pi-tuck.json` in Pi's agent folder
 * says `{"semanticRecall": false}`. Its runtime is set up in the background the first time a session starts. */
export default async function (pi: ExtensionAPI) {
	const semanticRecall = createSemanticRecall();
	// `/tuck-semantic off` holds for the rest of the session, including over a setup that finishes later.
	let off = false;
	const handle = await installCompaction(pi, { semanticRecall, onSemanticSetting: async enabled => { off = !enabled; } });
	const settings = readSettings(join(getAgentDir(), "pi-tuck.json"));
	if (settings.semanticRecall === false) return;
	let session = 0, said = "", setup: Promise<unknown> | undefined;
	// A context outlives its session (a setup can finish after /new); a notice to an ended session is dropped.
	const say = (ctx: ExtensionContext, message: string, level: "info" | "warning") => { try { ctx.ui.notify(message, level); } catch { /* ended */ } };
	const once = (ctx: ExtensionContext, message: string, level: "info" | "warning") => { if (said !== message) { said = message; say(ctx, message, level); } };
	pi.on("session_shutdown", () => { session++; });
	pi.on("session_start", (_event, ctx) => {
		const current = ++session;
		off = false;
		if (settings.error) once(ctx, `pi-tuck: ${settings.error}; using the defaults.`, "warning");
		if (process.platform !== "darwin" || process.arch !== "arm64")
			return once(ctx, "pi-tuck: semantic recall needs macOS on Apple silicon for now; compaction and word recall work.", "info");
		// Semantic recall keeps its runtime and indexes outside the project it serves, so not when Pi runs in a folder that holds its
		// agent folder, such as the home folder.
		if (within(real(getAgentDir()), real(ctx.cwd)))
			return once(ctx, "pi-tuck: semantic recall is off here because Pi's agent folder is inside this folder; open Pi in a project folder to use it.", "info");
		if (!ctx.hasUI) return; // a one-shot run (pi -p) would end before a first-time setup could
		if (!semanticRecall.status().configured) semanticRecall.refuse("Semantic recall is being set up; word recall works meanwhile");
		setup ??= ensureSemanticRuntime(defaultRoot(), message => say(ctx, message, "info"));
		setup.then(async () => {
			if (current !== session || off) return;
			try {
				await handle.setSemanticEnabled(true, ctx); // reads the runtime's configuration through the outside-project check
			} catch (error) {
				if (current === session) say(ctx, `pi-tuck: semantic recall could not start (${reason(error)}); it tries again when a session starts.`, "warning");
			}
		}, error => {
			setup = undefined; // the next session start tries again
			semanticRecall.refuse(`Semantic recall setup failed: ${reason(error)}`);
			if (current === session) say(ctx, `pi-tuck: semantic recall setup failed (${reason(error)}). Word recall works; setup retries when a session starts.`, "warning");
		});
	});
}

function readSettings(path: string): { semanticRecall?: boolean; error?: string } {
	let text: string;
	try { text = readFileSync(path, "utf8"); } catch { return {}; }
	try {
		const value = JSON.parse(text);
		if (value && typeof value === "object" && (value.semanticRecall === undefined || typeof value.semanticRecall === "boolean")) return value;
	} catch { /* reported below */ }
	return { error: `${path} should be a JSON object like {"semanticRecall": false}` };
}

const reason = (error: unknown) => error instanceof Error ? error.message : String(error);
const within = (path: string, folder: string) => path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep);
const real = (path: string) => { try { return realpathSync(path); } catch { return path; } };
