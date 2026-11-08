import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isDiscardedResponse } from "./protocol";
import { isTextOnly, textOf } from "./tuck/core/content";
import { extractPath } from "./tuck/core/tool-args";
import { readableContentParts } from "./tuck/core/readable-content";
import type { TranscriptRecord } from "./tuck/core/transcript";
import { MAX_RECALL_CHARACTERS } from "./recall";

export const MAX_OUTPUT_TAIL_LINES = 3;
export const MAX_OUTPUT_TAIL_CHARACTERS = 200;
export const MAX_DEFINITION_LINES = 40;
export const MAX_DEFINITION_CHARACTERS = 800;

/** Mechanical line matches only; no language detection or inferred symbols. */
export const DEFINITION_PATTERNS: readonly RegExp[] = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:func|def|function)\b/u,
  /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:type|struct|interface|class)\b/u,
  /^\s*export\s+(?:const|let)\b/u,
  /^\s*var\s*\(/u,
];

/** The last nonempty physical lines, with a leading marker whenever earlier text was cut.
 * The marker and embedded newlines spend the same 200-character allowance. */
export function outputTail(output: string): string | undefined {
  const lines = output.split(/\r\n|\n|\r/u).filter(line => line.trim());
  if (!lines.length) return undefined;
  let text = lines.slice(-MAX_OUTPUT_TAIL_LINES).join("\n");
  const cut = lines.length > MAX_OUTPUT_TAIL_LINES || text.length > MAX_OUTPUT_TAIL_CHARACTERS;
  if (text.length > MAX_OUTPUT_TAIL_CHARACTERS - Number(cut)) {
    let start = text.length - (MAX_OUTPUT_TAIL_CHARACTERS - 1);
    if (/[\uDC00-\uDFFF]/u.test(text[start]!)) start++;
    text = text.slice(start);
  }
  return (cut ? "…" : "") + text;
}

/** Whole matching source lines, numbered in the file. Both caps include numbers and newlines. */
export function definitionLines(content: string, firstLine = 1): string | undefined {
  const selected: string[] = [];
  let characters = 0;
  for (const [at, line] of content.split(/\r\n|\n|\r/u).entries()) {
    if (!DEFINITION_PATTERNS.some(pattern => pattern.test(line))) continue;
    const numbered = `${firstLine + at}: ${line}`;
    const cost = numbered.length + Number(selected.length > 0);
    if (selected.length === MAX_DEFINITION_LINES || characters + cost > MAX_DEFINITION_CHARACTERS) break;
    selected.push(numbered); characters += cost;
  }
  return selected.length ? selected.join("\n") : undefined;
}

export interface FileObservation { text: string; sourceIndex: number }

/** The newest available content for each requested path, including operations in the kept tail.
 * An edit or a write without content invalidates older content. A read result can supply only
 * its recorded lines, and never survive a mutation after its call, even if its result arrives later. */
export function fileObservations(paths: ReadonlySet<string>, entries: readonly SessionEntry[], indices: ReadonlyMap<string, number>,
  failedCalls: ReadonlySet<string>): Map<string, FileObservation> {
  const known = new Map<string, FileObservation>(), generations = new Map<string, number>();
  if (!paths.size) return known;
  const reads = new Map<string, { path: string; generation: number; firstLine: number }>();
  const remember = (path: string, content: string, sourceIndex: number | undefined, firstLine = 1) => {
    known.delete(path);
    const text = sourceIndex === undefined ? undefined : definitionLines(content, firstLine);
    if (text && sourceIndex !== undefined) known.set(path, { text, sourceIndex });
  };
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "assistant" && !isDiscardedResponse(message)) for (const block of message.content) {
      if (block.type !== "toolCall" || !["read", "write", "edit"].includes(block.name) || failedCalls.has(block.id)) continue;
      const args = block.arguments as Record<string, unknown> | undefined;
      const path = args && extractPath(args);
      if (!path || !paths.has(path)) continue;
      if (block.name === "read") {
        const offset = args!.offset;
        // Unknown coordinate conventions cannot produce file line numbers.
        if (offset !== undefined && (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 1)) continue;
        reads.set(block.id, { path, generation: generations.get(path) ?? 0, firstLine: typeof offset === "number" ? offset : 1 });
      } else {
        generations.set(path, (generations.get(path) ?? 0) + 1);
        known.delete(path);
        if (block.name === "write" && typeof args!.content === "string") remember(path, args!.content, indices.get(entry.id));
      }
    }
    if (message.role === "toolResult") {
      const read = reads.get(message.toolCallId);
      if (read && !message.isError && read.generation === (generations.get(read.path) ?? 0)) {
        // Image/unknown content supplies no textual file snapshot.
        remember(read.path, isTextOnly(message.content) ? textOf(message.content) : "", indices.get(entry.id), read.firstLine);
      }
    }
  }
  return known;
}

/** Plain-thinking openings before the final kept tail, newest block first.
 * Each pointer addresses the exact block in the message's readable text. */
export function* thinkingRecords(entries: readonly SessionEntry[], indices: ReadonlyMap<string, number>, openingLength: number): Generator<TranscriptRecord> {
  for (let at = entries.length - 1; at >= 0; at--) {
    const entry = entries[at]!;
    if (entry.type !== "message" || entry.message.role !== "assistant" || isDiscardedResponse(entry.message)) continue;
    const sourceIndex = indices.get(entry.id);
    if (sourceIndex === undefined) continue;
    const parts = readableContentParts(entry.message.content, true);
    for (let block = parts.length - 1; block >= 0; block--) {
      const part = parts[block]!;
      if (part.kind !== "thinking" || !part.text.trim()) continue;
      let end = Math.min(part.text.length, openingLength);
      if (end < part.text.length && /[\uD800-\uDBFF]/u.test(part.text[end - 1]!)) end++;
      const locator = { index: sourceIndex, offset: part.offset, limit: Math.min(MAX_RECALL_CHARACTERS, part.text.length) };
      yield { kind: "section", title: "Thinking", sourceIndex,
        text: `Plain thinking opening (tuck_recall ${JSON.stringify(locator)}):\n${part.text.slice(0, end)}` };
    }
  }
}
