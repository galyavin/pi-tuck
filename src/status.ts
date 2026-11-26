import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const CONTINUATION_CACHE_MISS = "Native continuation stopped because the server could not reuse the unfinished response without rebuilding context.";

/** The version of the package this code was loaded from: the open session keeps it until Pi restarts, whatever is installed since. */
export const LOADED_VERSION: string = (() => {
    try {
        const path = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../package.json" : "../../package.json", import.meta.url));
        const version = (JSON.parse(readFileSync(path, "utf8")) as { version?: unknown }).version;
        return typeof version === "string" ? version : "unknown";
    } catch { return "unknown"; }
})();

/** pi-tuck's own cuts on a branch: what `/tuck` and the footer count. */
export const tuckCuts = <E extends { type: string; details?: unknown }>(branch: readonly E[]): E[] =>
    branch.filter(e => e.type === "compaction" && (e.details as { compactor?: unknown } | null | undefined)?.compactor === "pi-tuck");

/** `/tuck`: what an operator needs to know in words, from what is already recorded. It reads; it changes nothing the model sees. */
export function statusText(input: {
    version: string;
    active: boolean;
    compaction?: import('./compaction').CompactionState;
    branch: readonly { type: string; tokensBefore?: unknown; details?: unknown; customType?: unknown; data?: unknown }[];
    pending?: boolean;
    cutAt: number | undefined;
    cacheSensitive?: boolean;
    /** The trim point in tokens for the current model, the footer's full bar; absent when it cannot be computed. */
    cutPoint?: number;
}): string {
    if (!input.active) return `pi-tuck ${input.version} is inactive in this host.`;
    if (input.compaction?.kind === 'standingDown') return `pi-tuck ${input.version} is standing down (${input.compaction.reason}). Pi controls compaction.`;
    const cuts = input.branch.filter(e => e.type === "compaction"), ours = tuckCuts(input.branch);
    const last = ours.at(-1), before = last?.tokensBefore, after = (last?.details as { tokensAfter?: unknown } | undefined)?.tokensAfter;
    const count = (n: number) => n.toLocaleString("en-US");
    const cutLine = ours.length === 0 ? input.pending ? "Trims: none saved yet in this session." : "Trims: none yet in this session. Recall becomes available after the first pi-tuck trim on this branch."
        : `Trims: ${ours.length} by pi-tuck in this session` + (typeof before === "number" && typeof after === "number" ? `, the last from ${count(before)} to ${count(after)} tokens.` : ".");
    const native = cuts.length - ours.length;
    const now = input.cutPoint === undefined ? "" : ` (about ${count(input.cutPoint)} tokens with this model)`;
    const retries = input.branch.filter(entry => entry.type === "custom" && entry.customType === "pi-tuck-capacity" &&
        (entry.data as { kind?: unknown } | null | undefined)?.kind === "retry").length;
    return [
        `pi-tuck ${input.version} (the version this session loaded; restart Pi after an update).`,
        cutLine,
        ...(retries ? [`Capacity retries on this branch: ${retries}.`] : []),
        ...(input.pending ? ["A trim is pending: requests already carry it; the first boundary saves it."] : []),
        ...(native > 0 ? [`Pi's own compaction ran ${native} time${native === 1 ? "" : "s"} in this session.`] : []),
        input.cacheSensitive ? "Trim point: preserves the active prefix while the reply reserve fits." : input.cutAt === undefined
            ? `Trim point: the room less a 2% margin${now}.` : `Trim point: cutAt ${input.cutAt} of the room, subject to the standard margin${now}. Remove cutAt from pi-tuck.json to use the default.`,
        "Search: by keyword.",
    ].join("\n");
}
