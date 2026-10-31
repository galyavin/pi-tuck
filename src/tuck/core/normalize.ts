import { isSourceExport } from "./recall-operation";
import type { CompilerMessage, NormalizedBlock } from "../types";
import { textOf } from "./content";
import { sanitize } from "./sanitize";

const normalizeOne = (msg: CompilerMessage, msgIndex: number | undefined): NormalizedBlock[] => {
  if (msg.role === "custom") return [{ kind: "notice", text: sanitize(textOf(msg.content)), originalText: textOf(msg.content), sourceIndex: msgIndex, startsSource: true }];
  if (msg.role === "user") {
    const blocks: NormalizedBlock[] = [];
    const text = sanitize(textOf(msg.content));
    if (text) blocks.push({ kind: "user", text, originalText: textOf(msg.content), sourceIndex: msgIndex, startsSource: true });
    if (msg.content && typeof msg.content !== "string") {
      for (const part of msg.content) {
        if (part.type === "image") {
          blocks.push({ kind: "user", text: `[image: ${part.mimeType}]`, sourceIndex: msgIndex });
        }
      }
    }
    return blocks.length > 0 ? blocks : [{ kind: "user", text: "", sourceIndex: msgIndex }];
  }

  if (msg.role === "bashExecution") return [{ kind: "bash", sourceIndex: msgIndex }];

  if (msg.role === "toolResult") return [{ kind: "tool_result", name: msg.toolName, sourceIndex: msgIndex }];

  if (msg.role === "assistant") {
    if (!msg.content) return [];
    if (typeof msg.content === "string") {
      return [{ kind: "assistant", text: sanitize(msg.content), originalText: msg.content, sourceIndex: msgIndex, startsSource: true }];
    }

    const blocks: NormalizedBlock[] = [];
    // The readable text of a message is its text and tool-call parts in order: only the first part starts it.
    let readable = false;
    for (const part of msg.content) {
      if (part.type === "text") {
        blocks.push({ kind: "assistant", text: sanitize(part.text), originalText: part.text, sourceIndex: msgIndex, ...(readable ? {} : { startsSource: true as const }) });
        readable = true;
      } else if (part.type === "toolCall") {
        readable = true;
        blocks.push({
          kind: "tool_call",
          name: part.name,
          args: part.arguments,
          sourceIndex: msgIndex,
        });
      }
    }
    return blocks;
  }

  return [];
};

/**
 * Normalize messages to blocks. `sourceIndices`, when provided, supplies the
 * session-global `#N` index per input position (see src/core/global-indices.ts).
 * A missing entry yields `sourceIndex: undefined`, which downstream renderers
 * display as no ref — never a window-relative number. Omitted entirely, the
 * legacy positional behavior is preserved (used by callers/tests that have no
 * index space to map into).
 */
/** Pair against eligible original history, not only the selected prefix. Never infer effects. */
export const normalize = (
  messages: CompilerMessage[],
  sourceIndices?: Array<number | undefined>,
  receiptContext?: { messages: CompilerMessage[]; sourceIndices: Array<number | undefined> },
  sourceEntryIds?: readonly string[],
  sourceTimes?: readonly import("./source-time").SourceTime[],
): NormalizedBlock[] => {
  if (sourceEntryIds && sourceEntryIds.length !== messages.length) throw new Error("Original entry IDs must align with compiler messages");
  if (sourceTimes && sourceTimes.length !== messages.length) throw new Error("Original times must align with compiler messages");
  const timeByIndex = Object.fromEntries((sourceIndices ?? messages.map((_, i) => i)).flatMap((index, i) => index === undefined || !sourceTimes ? [] : [[index, sourceTimes[i]]]));
  const context = receiptContext ?? { messages, sourceIndices: sourceIndices ?? messages.map((_, i) => i) };
  const pairs = new Map<string, { calls: { name: string; order: number; index: number | undefined; args: Record<string, unknown> }[];
    receipts: { name: string; order: number; index: number | undefined; isError: boolean; content: Extract<CompilerMessage, { role: "toolResult" }>["content"] }[] }>();
  const group = (id: string) => {
    if (typeof id !== "string" || !id) throw new Error("Tool history lacks a recorded call identity");
    let pair = pairs.get(id);
    if (!pair) { pair = { calls: [], receipts: [] }; pairs.set(id, pair); }
    return pair;
  };
  context.messages.forEach((msg, order) => {
    if (msg.role === "assistant" && Array.isArray(msg.content)) for (const part of msg.content) {
      if (part.type === "toolCall") group(part.id).calls.push({ name: part.name, order, index: context.sourceIndices[order], args: part.arguments });
    }
    if (msg.role === "toolResult") {
      if (typeof msg.isError !== "boolean") throw new Error("Tool receipt lacks a recorded error status");
      group(msg.toolCallId).receipts.push({ name: msg.toolName,
        order, index: context.sourceIndices[order], isError: msg.isError, content: msg.content });
    }
  });
  // A call paired with exactly one later receipt of the same tool has a recorded outcome. An export through recall keeps its outcome block.
  const paired = (id: string): boolean => {
    const pair = pairs.get(id), call = pair?.calls[0], receipt = pair?.receipts[0];
    return Boolean(pair && call && receipt && pair.calls.length === 1 && pair.receipts.length === 1 && receipt.name === call.name && receipt.order > call.order);
  };
  return messages.flatMap((msg, i) => normalizeOne(msg, sourceIndices ? sourceIndices[i] : i).map(block => {
    if (block.kind === "tool_result" && msg.role === "toolResult" && paired(msg.toolCallId) &&
      isSourceExport(pairs.get(msg.toolCallId)?.calls[0]?.args)) block = { ...block, recallExport: true };
    if (sourceTimes) block = { ...block, sourceTimes: timeByIndex };
    return block.kind === "notice" && sourceEntryIds?.[i] !== undefined ? { ...block, sourceEntryId: sourceEntryIds[i] } : block; }));
};
