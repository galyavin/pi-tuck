import type { Message } from "@earendil-works/pi-ai";

/** Content that is a string or only text blocks: what quoting can deliver whole. */
export const isTextOnly = (content: string | readonly { type: string }[] | undefined): boolean =>
  typeof content === "string" || (Array.isArray(content) && content.every((part) => part.type === "text"));

export const textOf = (content: Message["content"]): string => {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
};
