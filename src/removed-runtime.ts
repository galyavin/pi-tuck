import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { access, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { notify } from "./notify.js";

const pending = new Map<string, Promise<void>>();
const defaultRoot = () => resolve(join(getAgentDir(), "pi-tuck"));

/** Compatibility command for one release; only inspect the leftovers, never start or remove them. */
export async function removedRuntimeStatus(root = defaultRoot()): Promise<string> {
    let present = false;
    try { present = (await stat(root)).isDirectory(); } catch { /* Missing or inaccessible. */ }
    return "Semantic search was removed from pi-tuck. " + (present
        ? `Its runtime folder ${root} can be deleted by hand.`
        : `No runtime folder exists at ${root}.`);
}

/** Size only for the operator's deletion notice. The old runtime is never started, changed or deleted. */
async function sizeHint(root: string): Promise<string> {
    const started = performance.now();
    return new Promise(resolveHint => {
        execFile("du", ["-sk", root], { timeout: 1000, maxBuffer: 1024 }, (error, stdout) => {
            const kib = Number(/^\s*(\d+)\s/.exec(stdout)?.[1]);
            resolveHint(!error && performance.now() - started <= 1000 && Number.isFinite(kib)
                ? ` (about ${Math.round(kib / 1024)} MB)` : "");
        });
    });
}

/** Persist the notice only after it was delivered; share concurrent session starts in this process. */
export function showRemovedRuntimeNotice(ctx: ExtensionContext, root = defaultRoot()): Promise<void> {
    const held = pending.get(root);
    if (held) return held;
    const notice = (async () => {
        const marker = root + ".notice-shown";
        try {
            try { await access(marker); return; } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
            }
            if (!(await stat(root)).isDirectory()) return;
            const hint = await sizeHint(root);
            if (notify(ctx, `pi-tuck no longer uses semantic search; its runtime folder ${root}${hint} can be deleted.`, "info"))
                await writeFile(marker, "", { flag: "wx", mode: 0o600 });
        } catch { /* Missing/inaccessible leftovers or an unwritable marker must not break a session. */ }
    })();
    pending.set(root, notice);
    void notice.finally(() => { pending.delete(root); });
    return notice;
}
