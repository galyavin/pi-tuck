import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { conversationTokens, type Messages } from "./budget.js";
import { MAX_RECALL_CHARACTERS } from "./recall.js";

/** What a request carries in place of one fresh tool result that the room cannot hold: its head and tail, and where the rest is. */
export interface Clip { toolCallId: string; content: ToolResultMessage["content"] }

/** The text `tuck_recall {entryId, offset}` reads from a text-only result; any other result is not clipped. */
const textOf = (message: ToolResultMessage) => message.content.every(block => block.type === "text")
    ? message.content.map(block => block.type === "text" ? block.text : "").join("\n") : undefined;

const clipped = (text: string, keep: number, entryId: string): ToolResultMessage["content"] => {
    const head = Math.ceil(keep / 2), tail = keep - head;
    return [{ type: "text", text: text.slice(0, head) +
        `\n[pi-tuck: characters ${head}-${text.length - tail} of ${text.length} are not shown, to fit the context window; read them with ` +
        `tuck_recall {"entryId":"${entryId}","offset":${head}}, up to ${MAX_RECALL_CHARACTERS} characters a call]\n` + text.slice(text.length - tail) }];
};

/** The budgets to offer a fresh round the room cannot hold whole, in the units the round and the mandatory input are counted in, tried in order.
 * The room is the provider's, so it is divided by the factor the provider's counts have been running at - the same conversion the planner's own
 * reserve makes (budget.ts) - before the input no cut can remove is taken out; counting the provider's room against an estimate asks the round for
 * more than the room holds at a factor above 1. The first try is half of what that leaves. `kept` is what the smallest cut leaves the request
 * besides the fresh results - the summary floor and its quote of the prompt - measured from the planner's own preview, not a new formula: a half
 * cannot spend it, so the second try is the whole free room less it. Omit it when the planner bailed before building a preview, and only the half
 * is tried. Nothing is offered when the mandatory input alone leaves no room. */
export const clipBudgets = (room: number, factor: number, mandatory: number, kept?: number): number[] => {
    const free = Math.floor(room / Math.max(1, factor)) - mandatory;
    if (free <= 0) return [];
    return [...new Set(kept === undefined ? [Math.floor(free / 2)] : [Math.floor(free / 2), free - kept - 1])].filter(budget => budget > 0);
};

/** The round's text results within `budget` tokens together: each result smaller than an equal share of what is left stays whole, and the
 * rest are clipped to that share, keeping the most head and tail characters that fit it. None when the round already fits, or when a share
 * cannot hold even the locator. A round of one result gets the whole budget. Deterministic: the same round and budget always clip the same way. */
export function clipFor(results: readonly ToolResultMessage[], entryIdOf: (toolCallId: string) => string | undefined, budget: number): Clip[] {
    const tokens = (message: ToolResultMessage) => conversationTokens([message] as Messages);
    const round = results.flatMap(result => { const text = textOf(result), entryId = entryIdOf(result.toolCallId);
        return text === undefined || !entryId ? [] : [{ result, text, entryId, size: tokens(result) }]; })
        .sort((a, b) => a.size - b.size);
    if (round.reduce((sum, item) => sum + item.size, 0) <= budget) return [];
    const clips: Clip[] = [];
    let left = budget;
    for (const [at, { result, text, entryId, size }] of round.entries()) {
        const share = Math.floor(left / (round.length - at));
        if (size <= share) { left -= size; continue; }
        const fits = (keep: number) => tokens({ ...result, content: clipped(text, keep, entryId) }) <= share;
        if (!fits(0)) return [];
        let low = 0, high = text.length;
        while (low < high) { const mid = Math.ceil((low + high) / 2); if (fits(mid)) low = mid; else high = mid - 1; }
        const content = clipped(text, low, entryId);
        clips.push({ toolCallId: result.toolCallId, content });
        left -= tokens({ ...result, content });
    }
    return clips;
}

/** The messages with each clipped result replaced; the same array when nothing is clipped. */
export const applyClips = <M extends { role: string }>(messages: M[], clips: ReadonlyMap<string, Clip>): M[] => !clips.size ? messages
    : messages.map(message => message.role === "toolResult" && clips.has((message as unknown as ToolResultMessage).toolCallId)
        ? { ...message, content: clips.get((message as unknown as ToolResultMessage).toolCallId)!.content } : message);
