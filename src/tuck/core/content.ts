import type { Message } from "@earendil-works/pi-ai";

export const clip = (text: string, max = 200): string => {
  if (text.length <= max) return text;
  // Try to cut at a word boundary
  const cut = text.lastIndexOf(" ", max);
  let end = cut > max * 0.6 ? cut : max;
  // Avoid splitting a surrogate pair
  if (end > 0 && end < text.length) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end--;
  }
  return text.slice(0, end);
};

const textParts = (content: Message["content"]): string[] => {
  if (!content) return [];
  if (typeof content === "string") return [content];
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text);
};

export const textOf = (content: Message["content"]): string =>
  textParts(content).join("\n");

/**
 * Extract every scalar string argument from a tool call for search indexing
 * — command, query, content, oldText/newText, etc. Generic value walk (no
 * tool-name allowlist): top-level strings plus strings one level into
 * array-of-object fields (e.g. `edits`). Unbounded by design — a single
 * toolCall's raw argument text — so a message with several toolCalls doesn't
 * silently multiply an internal cap. The caller (search-entries.ts) applies
 * one shared budget across all toolCalls in a message.
 */
export const extractToolCallArgsText = (args: Record<string, unknown>): string => {
  if (!args || typeof args !== "object") return "";
  const parts: string[] = [];
  for (const value of Object.values(args)) {
    if (typeof value === "string") {
      parts.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") {
          parts.push(item);
        } else if (item && typeof item === "object") {
          for (const v of Object.values(item)) {
            if (typeof v === "string") parts.push(v);
          }
        }
      }
    }
  }
  return parts.join("\n");
};
