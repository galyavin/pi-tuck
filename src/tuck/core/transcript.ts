import { validSourceTime } from "./source-time";
import { isDeepStrictEqual } from "node:util";
import type { HistoricalReceipt } from "../types";

export const MAX_RECEIPT_CHARACTERS = 8000;
export const MAX_PRODUCER_ARGUMENT_CHARACTERS = 1000;
export const RECEIPT_RANGE_NOTICE = "Incomplete original readable text at this range; omitted text may qualify it. tuck_recall {index,offset,limit} expands the original.";
/** Only complete JSON arguments; serialization must not coerce or omit values. */
export const smallOriginalArguments = (value: unknown, maxCharacters = MAX_PRODUCER_ARGUMENT_CHARACTERS): value is Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const encoded = JSON.stringify(value);
    return encoded.length <= maxCharacters && isDeepStrictEqual(value, JSON.parse(encoded));
  } catch { return false; }
};

interface RecordFields {
  sourceTime?: import("./source-time").SourceTime;
  sourceTimes?: ({ sourceIndex: number } & import("./source-time").SourceTime)[];
  sourceEntryId?: string;
  role?: "user" | "assistant" | "custom" | "bashExecution" | "toolResult";
  sourceIndex?: number;
  sourceIndices?: number[];
  text?: string;
  span?: { coordinateSpace: "sanitized-block"; start: number; end: number; totalCharacters: number };
  reason?: string;
  count?: number;
  title?: string;
}
export type TranscriptRecord = RecordFields & (
  { kind: "excerpt"; role: "user" | "assistant" | "custom"; text: string } |
  { kind: "tool_call"; role: "assistant"; text: string; arguments?: Record<string, unknown>;
    argumentsJSONPrefix?: string; completeArgumentMembers?: Record<string, unknown> } |
  { kind: "tool_receipt"; role: "toolResult"; sourceIndex: number; sourceIndices: [number, number]; historical: true; isError: boolean; text: string; producer: HistoricalReceipt["producer"] } |
  { kind: "tool_excerpt"; role: "toolResult"; sourceIndex: number; sourceIndices: [number, number]; historical: true; isError: boolean; text: string; producer: HistoricalReceipt["producer"]; complete: false; notice: typeof RECEIPT_RANGE_NOTICE; range: { coordinateSpace: "readable-entry-utf16"; start: number; end: number; totalCharacters: number } } |
  { kind: "bash"; role: "bashExecution"; text: string } |
  { kind: "omission"; reason: string } |
  { kind: "section"; title: string; text: string }
);

export const TRANSCRIPT_HEADER = "TUCK-TRANSCRIPT/1";
export const TRANSCRIPT_MAX_UNITS = 120;
export const TRANSCRIPT_UNIT_CHARACTERS = 120;
/** UTF-16 serialized characters, including JSON escapes, labels and framing. */
export const transcriptUnits = (text: string): number => text === "" ? 0 :
  text.split("\n").reduce((n, line) => n + Math.max(1, Math.ceil(line.length / TRANSCRIPT_UNIT_CHARACTERS)), 0);
export const serializeRecords = (records: TranscriptRecord[]): string => records.map(r => JSON.stringify(r)).join("\n");
export const serializeTranscript = (records: TranscriptRecord[]): string => records.length ?
  `${TRANSCRIPT_HEADER}\n${serializeRecords(records)}` : "";
/** Starts a summary's closing section, after the record lines. */
export const CLOSING_SEPARATOR = "\n\n---\n\n";
/** A summary in this format, split by structure: each record is one JSON line, so the first blank line after the header starts the
 * closing section. Any closing wording, from this build or an earlier one, is accepted; the records are returned byte for byte. */
export const splitSummary = (summary: string): { body: string; closing: string } | undefined => {
  const header = [TRANSCRIPT_HEADER, LEGACY_TRANSCRIPT_HEADER].find(h => summary.startsWith(h + "\n"));
  if (!header) return undefined;
  const at = summary.indexOf(CLOSING_SEPARATOR, header.length);
  if (at < 0) return undefined;
  // A summary saved before the rename keeps its records byte for byte (their lengths are checked); only its closing is pointed at the
  // tools the model has now.
  const closing = header === TRANSCRIPT_HEADER ? summary.slice(at) : summary.slice(at).replaceAll("vcc_recall", "tuck_recall").replaceAll("vcc_search", "tuck_search");
  return { body: summary.slice(header.length + 1, at), closing };
};
/** The header of summaries saved before the rename to pi-tuck. */
export const LEGACY_TRANSCRIPT_HEADER = "VCC-TRANSCRIPT/1";
const LEGACY_RECEIPT_RANGE_NOTICE = RECEIPT_RANGE_NOTICE.replace("tuck_recall", "vcc_recall");

/** Accept our explicit record protocol only. Never recover roles from payload text. */
export const parseRecords = (text: string): TranscriptRecord[] => {
  if (!text) return [];
  return text.split("\n").map(line => {
    const r: unknown = JSON.parse(line);
    if (!r || typeof r !== "object" || Array.isArray(r)) throw new Error("Invalid pi-tuck transcript record");
    const v = r as TranscriptRecord;
    const roles = ["user", "assistant", "custom", "bashExecution", "toolResult"];
    const integer = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
    if (!["excerpt", "tool_call", "tool_receipt", "tool_excerpt", "bash", "omission", "section"].includes(v.kind) ||
      (v.role !== undefined && !roles.includes(v.role)) ||
      (v.sourceTime !== undefined && (v.sourceEntryId === undefined || !validSourceTime(v.sourceTime))) ||
      (v.sourceTimes !== undefined && (!Array.isArray(v.sourceTimes) || !v.sourceTimes.length || v.sourceTimes.some(t => !integer(t.sourceIndex) || !validSourceTime(Object.fromEntries(Object.entries(t).filter(([key]) => key !== "sourceIndex")))))) ||
      (v.sourceIndex !== undefined && !integer(v.sourceIndex)) ||
      (v.sourceEntryId !== undefined && (typeof v.sourceEntryId !== "string" || !v.sourceEntryId || v.sourceEntryId.length > 200 ||
        v.role !== "custom" || !["excerpt", "omission"].includes(v.kind))) ||
      (v.sourceIndices !== undefined && (!Array.isArray(v.sourceIndices) || !v.sourceIndices.every(integer))) ||
      (v.kind !== "omission" && typeof v.text !== "string") ||
      (v.kind === "omission" && typeof v.reason !== "string") ||
      (v.kind === "excerpt" && !["user", "assistant", "custom"].includes(v.role)) ||
      (v.kind === "tool_call" && v.role !== "assistant") ||
      (v.kind === "bash" && v.role !== "bashExecution") ||
      (v.kind === "section" && typeof v.title !== "string") ||
      (v.count !== undefined && !integer(v.count)) ||
      (v.span !== undefined && (v.span.coordinateSpace !== "sanitized-block" || !integer(v.span.start) || !integer(v.span.end) || !integer(v.span.totalCharacters) ||
        v.span.start > v.span.end || v.span.end > v.span.totalCharacters ||
        (v.kind === "excerpt" && v.text!.length !== v.span.end - v.span.start))))
      throw new Error("Invalid pi-tuck transcript record");
    if (v.sourceTimes) {
      const expected = v.sourceIndices ?? (v.sourceIndex === undefined ? [] : [v.sourceIndex]);
      if (v.sourceTimes.length !== expected.length || v.sourceTimes.some((t, i) => t.sourceIndex !== expected[i])) throw new Error("Mismatched source times");
    }
    if (["arguments", "argumentsJSONPrefix", "completeArgumentMembers"].some(key => Object.hasOwn(v, key))) {
      if (v.kind !== "tool_call" ||
        (Object.hasOwn(v, "arguments") && (!smallOriginalArguments(v.arguments, Number.MAX_SAFE_INTEGER) ||
          Object.hasOwn(v, "argumentsJSONPrefix") || Object.hasOwn(v, "completeArgumentMembers"))) ||
        (Object.hasOwn(v, "argumentsJSONPrefix") && (typeof v.argumentsJSONPrefix !== "string" || !v.argumentsJSONPrefix)) ||
        (Object.hasOwn(v, "completeArgumentMembers") && (!Object.hasOwn(v, "argumentsJSONPrefix") ||
          !smallOriginalArguments(v.completeArgumentMembers, Number.MAX_SAFE_INTEGER) || !Object.keys(v.completeArgumentMembers).length)))
        throw new Error("Invalid historical argument fields");
    }
    if (v.kind === "tool_receipt" || v.kind === "tool_excerpt") {
      const p = v.producer;
      const keys = [...(v.sourceTimes ? ["sourceTimes"] : []), "kind", "role", "sourceIndex", "sourceIndices", "historical", "isError", "text", "producer", ...(v.kind === "tool_excerpt" ? ["complete", "notice", "range"] : [])];
      if (Object.keys(v).length !== keys.length || !Object.keys(v).every(k => keys.includes(k)) ||
        v.role !== "toolResult" || v.historical !== true || typeof v.isError !== "boolean" ||
        !v.text || v.text.length > MAX_RECEIPT_CHARACTERS || !integer(v.sourceIndex) ||
        !p || typeof p !== "object" || Array.isArray(p) || Object.keys(p).length !== 4 ||
        !Object.keys(p).every(k => ["sourceIndex", "toolName", "toolCallId", "arguments", "argumentsOmitted"].includes(k)) ||
        !integer(p.sourceIndex) || p.sourceIndex >= v.sourceIndex ||
        typeof p.toolName !== "string" || !p.toolName.trim() || p.toolName.length > 160 ||
        typeof p.toolCallId !== "string" || !p.toolCallId || p.toolCallId.length > 160 ||
        !(Object.hasOwn(p, "arguments") && !Object.hasOwn(p, "argumentsOmitted") && smallOriginalArguments(p.arguments) ||
          p.argumentsOmitted === true && !Object.hasOwn(p, "arguments")) ||
        !Array.isArray(v.sourceIndices) || v.sourceIndices.length !== 2 ||
        v.sourceIndices[0] !== p.sourceIndex || v.sourceIndices[1] !== v.sourceIndex)
        throw new Error("Invalid historical receipt record");
      if (v.kind === "tool_excerpt" && (v.complete !== false || ![RECEIPT_RANGE_NOTICE, LEGACY_RECEIPT_RANGE_NOTICE].includes(v.notice) || !v.range ||
        Object.keys(v.range).length !== 4 || !Object.keys(v.range).every(k => ["coordinateSpace", "start", "end", "totalCharacters"].includes(k)) ||
        v.range.coordinateSpace !== "readable-entry-utf16" || !integer(v.range.start) || !integer(v.range.end) || !integer(v.range.totalCharacters) ||
        v.range.start >= v.range.end || v.range.end > v.range.totalCharacters || v.range.totalCharacters <= MAX_RECEIPT_CHARACTERS ||
        v.text.length !== v.range.end - v.range.start)) throw new Error("Invalid historical receipt range");
    }
    return v;
  });
};
