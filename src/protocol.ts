import type { convertToLlm } from "@earendil-works/pi-coding-agent";
type AgentMessage = Parameters<typeof convertToLlm>[0][number];

/** Native unfinished calls remain Pi-owned; never invent receipts or repair source data. */
export function assertNativeToolRounds(messages: readonly AgentMessage[]) {
 let calls = new Map<string, string>();
 let results = new Set<string>();
 for (const message of messages) {
  if (message.role === "assistant") {
   if (message.stopReason === "error" || message.stopReason === "aborted") continue;
   calls = new Map(); results = new Set();
   for (const block of message.content) if (block.type === "toolCall") {
    if (calls.has(block.id)) throw new Error("Duplicate call in native tool round");
    calls.set(block.id, block.name);
   }
  } else if (message.role === "user") {
   calls.clear(); results.clear();
  } else if (message.role === "toolResult") {
   if (!calls.has(message.toolCallId)) throw new Error("Orphan result in native tool round");
   if (calls.get(message.toolCallId) !== message.toolName) throw new Error("Wrong tool name in native tool round");
   if (results.has(message.toolCallId)) throw new Error("Duplicate result in native tool round");
   results.add(message.toolCallId);
  }
 }
}
