import type { convertToLlm } from "@earendil-works/pi-coding-agent";

/** Includes Pi bash executions as well as ordinary LLM messages. */
export type CompilerMessage = Parameters<typeof convertToLlm>[0][number];


export interface ReceiptLink {
  status: "missing" | "ambiguous" | "error" | "non-error";
  sourceIndices: number[];
  /** Every original call/receipt contributing to the derived status. */
  dependencyIndices: number[];
}

export interface HistoricalReceipt {
  text: string;
  isError: boolean;
  producer: { sourceIndex: number; toolName: string; toolCallId: string } & (
    { arguments: Record<string, unknown>; argumentsOmitted?: never } |
    { arguments?: never; argumentsOmitted: true }
  );
}

/** `startsSource`: the block's original text begins the message's readable text, so an offset into it is a tuck_recall offset into the source. */
export type NormalizedBlock = { sourceTimes?: Record<number, import("./core/source-time").SourceTime> } & (
  | { kind: "user"; text: string; originalText?: string; sourceIndex?: number; startsSource?: true }
  | { kind: "assistant"; text: string; originalText?: string; sourceIndex?: number; startsSource?: true }
  | { kind: "notice"; text: string; originalText?: string; sourceIndex?: number; sourceEntryId?: string; startsSource?: true }
  | { kind: "tool_call"; name: string; args: Record<string, unknown>; callId?: string; receipt?: ReceiptLink; sourceIndex?: number }
  | { kind: "tool_result"; name: string; text: string; sourceIndex?: number; recallExport?: true; originalReceipt?: HistoricalReceipt }
  | { kind: "bash"; command: string; output: string; exitCode: number | undefined; cancelled?: boolean; truncated?: boolean; sourceIndex?: number });
