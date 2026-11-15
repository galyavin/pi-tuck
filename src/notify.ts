import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Operator notices stay outside model context; an ended UI or closed stderr cannot break the session. */
export function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): boolean {
    try {
        if (ctx.hasUI === false) process.stderr.write(message + "\n");
        else ctx.ui.notify(message, level);
        return true;
    } catch { return false; }
}
