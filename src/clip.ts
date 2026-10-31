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

/** The largest of the round's text results, clipped to the most head and tail characters that keep it within `budget` tokens. None when
 * it already fits, or when not even the locator alone fits. Deterministic: the same result and budget always clip the same way. */
export function clipFor(results: readonly ToolResultMessage[], entryIdOf: (toolCallId: string) => string | undefined, budget: number): Clip | undefined {
    const tokens = (message: ToolResultMessage) => conversationTokens([message] as Messages);
    const largest = results.filter(result => textOf(result) !== undefined).reduce<ToolResultMessage | undefined>((most, result) =>
        !most || tokens(result) > tokens(most) ? result : most, undefined);
    const entryId = largest && entryIdOf(largest.toolCallId);
    if (!largest || !entryId || tokens(largest) <= budget) return undefined;
    const text = textOf(largest)!, fits = (keep: number) => tokens({ ...largest, content: clipped(text, keep, entryId) }) <= budget;
    if (!fits(0)) return undefined;
    let low = 0, high = text.length;
    while (low < high) { const mid = Math.ceil((low + high) / 2); if (fits(mid)) low = mid; else high = mid - 1; }
    return { toolCallId: largest.toolCallId, content: clipped(text, low, entryId) };
}

/** The messages with each clipped result replaced; the same array when nothing is clipped. */
export const applyClips = <M extends { role: string }>(messages: M[], clips: ReadonlyMap<string, Clip>): M[] => !clips.size ? messages
    : messages.map(message => message.role === "toolResult" && clips.has((message as unknown as ToolResultMessage).toolCallId)
        ? { ...message, content: clips.get((message as unknown as ToolResultMessage).toolCallId)!.content } : message);
