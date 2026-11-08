import { getCurrentTools } from "@earendil-works/pi-ai";
import { convertToLlm, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Messages, ToolShape } from "./budget.js";

const own = (name: string) => name === "tuck_recall" || name === "tuck_search";
/** Native Pi compactions do not make pi-tuck history available. No session-wide activation state. */
export const hasTuckCut = (branch: readonly { type: string; details?: unknown }[]): boolean => branch.some(entry =>
    entry.type === "compaction" && (entry.details as { compactor?: unknown } | null)?.compactor === "pi-tuck");

/** Preserve the host's loadout and its order; only our registered tools may change. */
export function historyToolNames(pi: ExtensionAPI, names: readonly string[], enabled: boolean): string[] {
    if (!enabled) return names.filter(name => !own(name));
    const registered = new Set(pi.getAllTools().map(tool => tool.name));
    return [...names, ...["tuck_recall", "tuck_search"].filter(name => registered.has(name) && !names.includes(name))];
}

export function applyHistoryTools(pi: ExtensionAPI, enabled: boolean): void {
    const current = pi.getActiveTools(), next = historyToolNames(pi, current, enabled);
    if (current.length !== next.length || current.some((name, index) => name !== next[index])) pi.setActiveTools(next);
}

/** Pi has already declared the request's tools before queued user messages are appended. A prompt cut planned on such a message needs its declarations
 * in that very request. Change only our declarations, leaving all other system content and tools in their original places. */
export function historyToolDeclarations(messages: Messages, tools: readonly ToolShape[], enabled: boolean): Messages {
    let changed = false;
    const filtered = messages.map(message => {
        if (message.role !== "system") return message;
        const added = message.toolsAdded?.filter(tool => !own(tool.name));
        const removed = message.toolsRemoved?.filter(tool => !own(tool.name));
        if (added?.length === message.toolsAdded?.length && removed?.length === message.toolsRemoved?.length) return message;
        changed = true;
        const { toolsAdded: _, toolsRemoved: __, ...rest } = message;
        return { ...rest, ...(added?.length ? { toolsAdded: added } : {}), ...(removed?.length ? { toolsRemoved: removed } : {}) };
    });
    // Leave an already-correct transcript byte-identical, including the original placement of our declarations.
    const declared = getCurrentTools(convertToLlm(messages));
    const wanted = enabled ? tools.filter(tool => own(tool.name)) : [];
    if (enabled && wanted.every(tool => declared.some(current => own(current.name) && current.name === tool.name)) &&
        declared.filter(tool => own(tool.name)).length === wanted.length) return messages;
    if (!enabled || !wanted.length) return changed ? filtered : messages;
    const at = filtered.findLastIndex(message => message.role === "system");
    if (at < 0) throw new Error("Missing Pi system message for history tool declarations");
    const system = filtered[at]!;
    if (system.role !== "system") throw new Error("Missing Pi system message");
    filtered[at] = { ...system, toolsAdded: [...(system.toolsAdded ?? []), ...wanted as NonNullable<typeof system.toolsAdded>] };
    return filtered;
}
