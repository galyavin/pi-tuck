import { validSourceTime, type SourceTime } from "./source-time";
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
/** The tool_call, tool_receipt, tool_excerpt and bash kinds are v1 only: summaries saved by earlier builds hold them, and this build no longer writes them. */
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

/** The format this build writes. */
export const TRANSCRIPT_HEADER = "TUCK-TRANSCRIPT/2";
/** The format of 1.0.x summaries: one JSON object per line. Read, never written. */
export const TRANSCRIPT_HEADER_V1 = "TUCK-TRANSCRIPT/1";
/** The header of summaries saved before the rename to pi-tuck: the v1 format. */
export const LEGACY_TRANSCRIPT_HEADER = "VCC-TRANSCRIPT/1";
export type TranscriptVersion = 1 | 2;
/** The header a summary of `version` is written with; a legacy one is rewritten as v1. */
export const transcriptHeader = (version: TranscriptVersion): string => version === 2 ? TRANSCRIPT_HEADER : TRANSCRIPT_HEADER_V1;

/** Starts a summary's closing section, after the record lines. */
export const CLOSING_SEPARATOR = "\n\n---\n\n";
/** A summary in either format, split by structure: each record is one line, and no record line is empty, so the first blank line after the
 * header starts the closing section. Any closing wording, from this build or an earlier one, is accepted; the records are returned byte
 * for byte, with the format their header names. */
export const splitSummary = (summary: string): { body: string; closing: string; version: TranscriptVersion } | undefined => {
  const header = [TRANSCRIPT_HEADER, TRANSCRIPT_HEADER_V1, LEGACY_TRANSCRIPT_HEADER].find(h => summary.startsWith(h + "\n"));
  if (!header) return undefined;
  const at = summary.indexOf(CLOSING_SEPARATOR, header.length);
  if (at < 0) return undefined;
  // A summary saved before the rename keeps its records byte for byte (their lengths are checked); only its closing is pointed at the
  // tools the model has now.
  const closing = header === LEGACY_TRANSCRIPT_HEADER ? summary.slice(at).replaceAll("vcc_recall", "tuck_recall").replaceAll("vcc_search", "tuck_search") : summary.slice(at);
  return { body: summary.slice(header.length + 1, at), closing, version: header === TRANSCRIPT_HEADER ? 2 : 1 };
};
const LEGACY_RECEIPT_RANGE_NOTICE = RECEIPT_RANGE_NOTICE.replace("tuck_recall", "vcc_recall");

/*
 * TUCK-TRANSCRIPT/2: the header line, one line per record, then the closing section.
 *
 *   line      = head ":" [ " " text ]          no " " and no text when the text is empty
 *   record    = [ locator " " ] role [ " " id ] [ " " time ] [ " " span ] ":" ...                      excerpt
 *             | [ locator " " ] [ role [ " " id ] " " ] "omitted" [ " " time ] [ " " span ] ":" ...      omission of part of one source,
 *                                                                                                         or, with no role, of the tool history
 *             | role " omitted " count [ " " locator-time { " " locator-time } ] ":" ...               omission of unselected text blocks
 *             | [ locator " " ] title ":" ...                                                          section (file ledger, action trail)
 *   locator   = "#" index                      the source's session-wide index, as tuck_recall {"index"} takes it
 *   locator-time = locator [ "@" time-value ]  every locator of a record has a time, or none does
 *   role      = "user" | "assistant" | "custom"
 *   id        = a JSON string                  the native entry id of a custom notice (role "custom" only)
 *   time      = "@" time-value                 the recorded time of the locator that precedes the role (a record that has one)
 *   time-value = UTC | "journal:" UTC | "unknown"   UTC is the message time, "journal:" UTC the session file's time of the entry
 *   span      = "[chars " start "-" end " of " total "]"     the characters of the source text block the text covers or the omission leaves out
 *   count     = index                          how many text blocks the omission counts
 *   title     = capital letter, then letters, digits, "_" and "-"
 *   index     = "0" | nonzero digit, then digits   a safe integer, no sign, no leading zero
 *
 * The text of an excerpt or section, or the reason of an omission, is the rest of the line: "\" is written "\\", a line feed "\n" and a
 * carriage return "\r"; every other character is written as it is.
 *
 * The head is made of the tokens above only, and the text is the rest of the line after the first ":" that follows them, so no text can be
 * mistaken for structure: a text that looks like a record is the text of one line. A role is lowercase and a title is capitalized, so the
 * first word of a head tells which record it is. Lines that follow no production are rejected, as are fields the record shape does not
 * have (a time without a locator, an id on a role other than "custom") and every check parseRecords makes of a v1 record.
 *
 * Examples:
 *   #12 user @2026-10-30T14:00:00Z: Please fix the parser.
 *   #12 assistant [chars 0-523 of 2004]: I will start with the tokenizer.
 *   #12 assistant omitted [chars 523-1900 of 2004]: tuck_recall {"index":12,"offset":523}
 *   #7 custom "a1b2c3d4": A note.
 *   assistant omitted 40 #3 #5 #9: Completely unselected historical text blocks; ...
 *   user omitted 3 #1@2026-10-30T14:00:00Z #4@unknown #8@journal:2026-10-30T14:00:05Z: Completely unselected ...
 *   omitted: Historical tool actions and observations omitted; read original sources with tuck_recall
 *   #4 Files: - read src/a.ts (tuck_recall {"index":4})
 */
const escapeText = (text: string): string => text.replace(/[\\\n\r]/g, c => c === "\\" ? "\\\\" : c === "\n" ? "\\n" : "\\r");
/** The length of `text` as a record line carries it: one character more for each "\", line feed and carriage return. */
export const escapedLength = (text: string): number => {
  let length = text.length;
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); if (c === 92 || c === 10 || c === 13) length++; }
  return length;
};
const TITLE = /^[A-Z][A-Za-z0-9_-]*$/;
const refuse = (record: TranscriptRecord): never => { throw new Error(`Cannot write a ${record.kind} record as ${TRANSCRIPT_HEADER}`); };

/** One record as a line of TUCK-TRANSCRIPT/2 (without its newline). The records this build emits only: a record whose fields the grammar
 * cannot carry exactly is refused, never written lossily. */
export const serializeRecord = (record: TranscriptRecord): string => {
  const fields = record as unknown as Record<string, unknown>;
  const present = Object.keys(fields).filter(key => fields[key] !== undefined);
  const only = (...allowed: string[]) => { if (!present.every(key => allowed.includes(key))) refuse(record); };
  const index = (n: unknown): string => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? String(n) : refuse(record);
  const time = (t: SourceTime): string => !validSourceTime(t) ? refuse(record) : t.basis === "unknown" ? "unknown" : t.basis === "journal" ? `journal:${t.utc}` : t.utc;
  /** The record's times, one for each locator in order; none when it has none. */
  const times = (locators: readonly number[]): string[] | undefined => {
    const { sourceTimes } = record;
    if (!sourceTimes) return undefined;
    if (sourceTimes.length !== locators.length) refuse(record);
    return sourceTimes.map(({ sourceIndex, ...value }, i) => sourceIndex === locators[i] ? time(value as SourceTime) : refuse(record));
  };
  const line = (head: string, text: string | undefined): string => head + ":" + (text ? " " + escapeText(text) : "");
  if (record.kind === "section") {
    only("kind", "title", "text", "sourceIndex");
    if (typeof record.title !== "string" || !TITLE.test(record.title) || typeof record.text !== "string") refuse(record);
    return line((record.sourceIndex === undefined ? "" : `#${index(record.sourceIndex)} `) + record.title, record.text);
  }
  if (record.kind !== "excerpt" && record.kind !== "omission") return refuse(record);
  const { role, sourceIndex, sourceEntryId, span } = record, omission = record.kind === "omission";
  if (role !== undefined && !["user", "assistant", "custom"].includes(role) || role === undefined && (!omission || sourceEntryId !== undefined) ||
    sourceEntryId !== undefined && (role !== "custom" || typeof sourceEntryId !== "string")) refuse(record);
  const who = (sourceEntryId === undefined ? "" : ` ${JSON.stringify(sourceEntryId)}`);
  if (omission && record.count !== undefined) {
    only("kind", "role", "count", "sourceIndices", "reason", "sourceTimes");
    const locators = record.sourceIndices ?? [], stamped = times(locators);
    if (role === undefined || typeof record.reason !== "string") refuse(record);
    return line(`${role} omitted ${index(record.count)}` + locators.map((n, i) => ` #${index(n)}${stamped ? "@" + stamped[i] : ""}`).join(""), record.reason);
  }
  only("kind", "role", "sourceIndex", omission ? "reason" : "text", "span", "sourceEntryId", "sourceTimes");
  const text = omission ? record.reason : record.text;
  if (typeof text !== "string") refuse(record);
  const stamped = times(sourceIndex === undefined ? [] : [sourceIndex]);
  const where = (sourceIndex === undefined ? "" : `#${index(sourceIndex)} `) + (role === undefined ? "" : role + who + (omission ? " " : ""));
  return line(where + (omission ? "omitted" : "") + (stamped ? ` @${stamped[0]}` : "") +
    (span ? ` [chars ${index(span.start)}-${index(span.end)} of ${index(span.totalCharacters)}]` : ""), text);
};
export const serializeRecords = (records: TranscriptRecord[]): string => records.map(serializeRecord).join("\n");
export const serializeTranscript = (records: TranscriptRecord[]): string => records.length ?
  `${TRANSCRIPT_HEADER}\n${serializeRecords(records)}` : "";

const invalid = (): never => { throw new Error("Invalid pi-tuck transcript record"); };
const unescapeText = (text: string): string => text.replace(/\\([\\nr])?/g, (_, c?: string) => c === undefined ? invalid() : c === "n" ? "\n" : c === "r" ? "\r" : "\\");
// Sticky patterns: each is matched at the position the line has been read up to.
const INDEX = "(0|[1-9]\\d*)";
const TIME = "(unknown|(?:journal:)?\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z)";
const LOCATOR = new RegExp(`#${INDEX} `, "y"), ROLE = /user|assistant|custom/y, OMITTED = /omitted/y;
const ID = / ("(?:[^"\\\u0000-\u001f]|\\["\\/bfnrt]|\\u[0-9a-fA-F]{4})*")/y, SPACE_OMITTED = / omitted/y, COUNT = new RegExp(` ${INDEX}`, "y");
const LOCATOR_TIME = new RegExp(` #${INDEX}(?:@${TIME})?`, "y"), TIME_TOKEN = new RegExp(` @${TIME}`, "y");
const SPAN = new RegExp(` \\[chars ${INDEX}-${INDEX} of ${INDEX}\\]`, "y"), TITLE_TOKEN = /[A-Z][A-Za-z0-9_-]*/y;

/** One line of TUCK-TRANSCRIPT/2, as the record the build that wrote it held (its fields in the order that build emits them). */
const parseLine = (line: string): unknown => {
  let at = 0;
  const take = (pattern: RegExp): RegExpExecArray | undefined => {
    pattern.lastIndex = at;
    const match = pattern.exec(line);
    if (match) at = pattern.lastIndex;
    return match ?? undefined;
  };
  const integer = (digits: string): number => Number.isSafeInteger(Number(digits)) ? Number(digits) : invalid();
  const timeOf = (value: string): SourceTime => value === "unknown" ? { basis: "unknown" } :
    value.startsWith("journal:") ? { basis: "journal", utc: value.slice(8) } : { basis: "message", utc: value };
  const located = take(LOCATOR), sourceIndex = located ? integer(located[1]!) : undefined;
  const title = take(TITLE_TOKEN)?.[0], role = title === undefined ? take(ROLE)?.[0] : undefined;
  const id = role === "custom" ? take(ID)?.[1] : undefined;
  const omitted = title === undefined && take(role === undefined ? OMITTED : SPACE_OMITTED) !== undefined;
  if (title === undefined && role === undefined && !omitted) invalid();
  const common = { ...(sourceIndex !== undefined ? { sourceIndex } : {}) };
  let record: Record<string, unknown>, text: string;
  const end = (): string => {
    if (line[at++] !== ":") return invalid();
    const rest = line.slice(at);
    return rest === "" ? "" : rest[0] === " " && rest.length > 1 && !rest.includes("\r") ? unescapeText(rest.slice(1)) : invalid();
  };
  const count = omitted && role !== undefined && sourceIndex === undefined && id === undefined ? take(COUNT) : undefined;
  if (title !== undefined) {
    text = end();
    record = { kind: "section", title, text, ...common };
  } else if (count) {
    const items: { sourceIndex: number; time?: SourceTime }[] = [];
    for (let item; (item = take(LOCATOR_TIME));) items.push({ sourceIndex: integer(item[1]!), ...(item[2] !== undefined ? { time: timeOf(item[2]) } : {}) });
    const stamped = items.filter(item => item.time).length;
    if (stamped && stamped !== items.length) invalid();
    record = { kind: "omission", role, count: integer(count[1]!), ...(items.length ? { sourceIndices: items.map(item => item.sourceIndex) } : {}), reason: end(),
      ...(stamped ? { sourceTimes: items.map(({ sourceIndex: n, time }) => ({ sourceIndex: n, ...time! })) } : {}) };
  } else {
    const time = take(TIME_TOKEN), span = take(SPAN);
    if (time && sourceIndex === undefined) invalid();
    const fields = {
      ...(span ? { span: { coordinateSpace: "sanitized-block" as const, start: integer(span[1]!), end: integer(span[2]!), totalCharacters: integer(span[3]!) } } : {}),
      ...(id !== undefined ? { sourceEntryId: JSON.parse(id) as string } : {}),
      ...(time ? { sourceTimes: [{ sourceIndex: sourceIndex!, ...timeOf(time[1]!) }] } : {}),
    };
    text = end();
    record = omitted ? { kind: "omission", ...(role !== undefined ? { role } : {}), ...common, reason: text, ...fields } :
      { kind: "excerpt", role, ...common, text, ...fields };
  }
  return record;
};

/** The structure of a record, whichever format it was read from: roles, source times, spans and, for the v1-only kinds, receipts. */
const validate = (r: unknown): TranscriptRecord => {
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
};

/** Accept our explicit record protocol only. Never recover roles from payload text. `version` is the summary header's: v1 reads one JSON
 * object per line, v2 the lines described above. Left out, it is taken from the first line, which a v1 record always begins with "{" and a v2 never. */
export const parseRecords = (text: string, version: TranscriptVersion = text.startsWith("{") ? 1 : 2): TranscriptRecord[] => {
  if (!text) return [];
  return text.split("\n").map(line => validate(version === 1 ? JSON.parse(line) : parseLine(line)));
};
