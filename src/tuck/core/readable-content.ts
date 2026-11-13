export interface ReadableContentPart {
  kind: "text" | "toolCall" | "thinking";
  text: string;
  offset: number;
  toolName?: string;
  arguments?: unknown;
}

/** Pi stores opaque/encrypted reasoning in thinkingSignature. The one exception: pi-ai's openai-completions adapter stores only the name of the
 * response field the plain reasoning came from (OPENAI_COMPLETIONS_REASONING_FIELDS), which signs or encrypts nothing. Also refuse explicit
 * redaction/encryption markers in imported session blocks. */
const PLAIN_REASONING_FIELDS: ReadonlySet<unknown> = new Set(["reasoning", "reasoning_content", "reasoning_text"]);
export function isPlainThinking(block: unknown): block is { type: "thinking"; thinking: string } {
  if (!block || typeof block !== "object") return false;
  const value = block as Record<string, unknown>;
  return value.type === "thinking" && typeof value.thinking === "string" && (value.thinkingSignature === undefined || PLAIN_REASONING_FIELDS.has(value.thinkingSignature)) &&
    (value.redacted === undefined || value.redacted === false) &&
    (value.encrypted === undefined || value.encrypted === false) &&
    value.encryptedContent === undefined && value.encrypted_content === undefined;
}

/** Keep the existing text/tool-call prefix byte for byte, including empty text
 * parts. Append plain thinking in block order so older recall offsets remain valid. */
export function readableContentParts(content: unknown, assistant = false): ReadableContentPart[] {
  if (typeof content === "string") return [{ kind: "text", text: content, offset: 0 }];
  if (!Array.isArray(content)) return [];
  const parts: Omit<ReadableContentPart, "offset">[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") parts.push({ kind: "text", text: block.text });
    else if (assistant && block.type === "toolCall" && typeof block.name === "string" && typeof block.id === "string" && "arguments" in block)
      parts.push({ kind: "toolCall", toolName: block.name, arguments: block.arguments,
        text: JSON.stringify({ toolCall: { name: block.name, id: block.id, arguments: block.arguments } }) });
  }
  if (assistant) for (const block of content)
    if (isPlainThinking(block) && block.thinking.length) parts.push({ kind: "thinking", text: block.thinking });
  let offset = 0;
  return parts.map((part, at) => {
    if (at) offset++;
    const located = { ...part, offset };
    offset += part.text.length;
    return located;
  });
}
