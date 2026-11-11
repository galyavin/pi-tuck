import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SemanticState } from "./semantic-recall";

/** The version of the package this code was loaded from: the open session keeps it until Pi restarts, whatever is installed since. */
export const LOADED_VERSION: string = (() => {
    try {
        const path = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../package.json" : "../../package.json", import.meta.url));
        const version = (JSON.parse(readFileSync(path, "utf8")) as { version?: unknown }).version;
        return typeof version === "string" ? version : "unknown";
    } catch { return "unknown"; }
})();

/** `/tuck`: what an operator needs to know in words, from what is already recorded. It reads; it changes nothing the model sees. */
export function statusText(input: {
    version: string;
    active: boolean;
    branch: readonly { type: string; tokensBefore?: unknown; details?: unknown; customType?: unknown; data?: unknown }[];
    pending?: boolean;
    cutAt: number | undefined;
    search: boolean;
    semantic: { state: SemanticState; lastError: string | null };
}): string {
    if (!input.active) return `pi-tuck ${input.version} is loaded but inactive in this host; Pi's own compaction runs.`;
    const cuts = input.branch.filter(e => e.type === "compaction"), ours = cuts.filter(e => (e.details as { compactor?: unknown } | null | undefined)?.compactor === "pi-tuck");
    const last = ours.at(-1), before = last?.tokensBefore, after = (last?.details as { tokensAfter?: unknown } | undefined)?.tokensAfter;
    const count = (n: number) => n.toLocaleString("en-US");
    const cutLine = ours.length === 0 ? input.pending ? "Cuts: none saved yet in this session." : "Cuts: none yet in this session. The recall tools appear after the first cut."
        : `Cuts: ${ours.length} by pi-tuck in this session` + (typeof before === "number" && typeof after === "number" ? `, the last from ${count(before)} to ${count(after)} tokens.` : ".");
    const native = cuts.length - ours.length;
    const retries = input.branch.filter(entry => entry.type === "custom" && entry.customType === "pi-tuck-capacity" &&
        (entry.data as { kind?: unknown } | null | undefined)?.kind === "retry").length;
    const searchLine = !input.search ? "Search: by keyword (search by meaning needs macOS on Apple silicon)."
        : input.semantic.state === "ready" || input.semantic.state === "waiting" ? "Search: by meaning and keyword."
        : input.semantic.state === "preparing" ? "Search: by meaning and keyword; indexing history in the background."
        : `Search: by keyword; ${lower(input.semantic.lastError ?? "semantic recall is off in this session (/tuck-semantic on)")}.`.replace(/\.\.$/, ".");
    return [
        `pi-tuck ${input.version} (the version this session loaded; restart Pi after an update).`,
        cutLine,
        ...(retries ? [`Retries: ${retries} after thinking-only length stops in this session.`] : []),
        ...(input.pending ? ["A cut is pending: requests already carry it; the first boundary saves it."] : []),
        ...(native > 0 ? [`Pi's own compaction cut ${native} time${native === 1 ? "" : "s"} in this session.`] : []),
        input.cutAt === undefined ? "Cut point: adapts by itself." : `Cut point: fixed at cutAt ${input.cutAt} of the input room. Remove cutAt from pi-tuck.json to let it adapt.`,
        searchLine,
    ].join("\n");
}

const lower = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
