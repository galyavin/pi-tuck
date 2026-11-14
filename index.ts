import { VERSION, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { installCompaction } from "./src/compaction";
import { validCutAt } from "./src/budget";
import { notify } from "./src/notify";
import { cleanupLegacyFiles } from "./src/legacy-cleanup";

export type { CompactionOptions } from "./src/compaction";
export { installCompaction } from "./src/compaction";
export { inspectIncident, readableIncident } from "./src/diagnostic-replay.js";

/** pi-tuck as a Pi extension: compaction and history recall. `"cutAt"` in `pi-tuck.json` in Pi's agent folder (a number above 0 and at most
 * 1) fixes the cut point as a fraction of the input room; without it, the cut point adapts. */
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
	const settings = readSettings(join(getAgentDir(), "pi-tuck.json"));
	const handle = await installCompaction(pi, { cutAt: settings.cutAt });
	let said = false;
	pi.on("session_start", async (_event, ctx) => {
		await cleanupLegacyFiles(ctx);
		if (handle.state?.(ctx).kind === "standingDown") return;
		if (settings.error && !said) {
			said = notify(ctx, `pi-tuck: ${settings.error}; using the defaults.`, "warning");
		}
	});
}

function readSettings(path: string): { cutAt?: number; error?: string } {
	let text: string;
	try { text = readFileSync(path, "utf8"); } catch { return {}; }
	try {
		const value = JSON.parse(text);
		if (value && typeof value === "object" &&
			(value.cutAt === undefined || validCutAt(value.cutAt))) return { cutAt: value.cutAt };
	} catch { /* reported below */ }
	return { error: `${path} should be a JSON object like {"cutAt": 0.8}, with cutAt a number above 0 and at most 1` };
}
