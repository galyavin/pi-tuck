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
