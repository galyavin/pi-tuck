import type { NormalizedBlock } from "../types";
import { blockRecords, decorateRecord, isDialogue, isOmittable, omissionRecord, userPrefixRecords, type Clip, type DialogueBlock } from "./brief";
import { DIALOGUE_SUFFIX } from "./format";
import { orderByOriginalSource } from "./source-order";
import { serializeRecord, serializeTranscript, TRANSCRIPT_HEADER, type TranscriptRecord } from "./transcript";

type Role = "user" | "assistant" | "notice";
const ROLES: readonly Role[] = ["user", "assistant", "notice"];

/** The lossy variants of a unit, least clipped first: the words kept from the start of its text and from its end. */
const TIERS: Record<Role, readonly Clip[]> = {
  assistant: [[80, 120], [40, 40], [16, 0]],
  user: [],
  notice: [[256, 0]],
};

export interface DialogueInput {
  /** Normalized, noise-filtered blocks of the pre-cut history in chronological order: dialogue and tool blocks alike. */
  blocks: NormalizedBlock[];
  /** Sources the adapter quotes in its own base: they render as nothing here and are not counted as omitted. */
  mandatorySourceIndices?: ReadonlySet<number>;
  /** The source index of each original message and, when known, its entry id, for the original order of the records. */
  sourceIndices: readonly (number | undefined)[];
  sourceEntryIds?: readonly string[];
}

/** Whether the ranked view is whole, selected, or cannot fit its omission metadata. */
export type Step = "whole" | "ranked" | "none";
export interface Shrunk {
  /** The summary text, or "" when nothing fits. */
  text: string;
  step: Step;
  /** The serialized size of the selected view. */
  size: number;
}

/** What one unit renders in a configuration, and its serialized size: each record's line plus a newline. */
interface Rendered { records: TranscriptRecord[]; cost: number }
const rendered = (records: TranscriptRecord[]): Rendered => ({ records, cost: records.reduce((n, r) => n + serializeRecord(r).length + 1, 0) });

/** Units [0, drop) of a role are dropped, [drop, end) are clipped to `tier`, and the rest stay whole. */
interface Setting { drop: number; tier: number; end: number; take?: number }
type Config = Record<Role, Setting>;
const WHOLE: Setting = { drop: 0, tier: 0, end: 0 };

/** The units of one role in chronological order, with each variant's cost summed over every prefix. */
const createLane = (role: Role, units: DialogueBlock[], mandatory: ReadonlySet<number> | undefined, decorate: (record: TranscriptRecord) => TranscriptRecord) => {
  const n = units.length;
  const records = (block: DialogueBlock, clip?: Clip) => rendered(blockRecords(block, mandatory, clip).map(decorate));
  const prefix = (level: Rendered[]) => { const sums = new Float64Array(n + 1); level.forEach((r, i) => sums[i + 1] = sums[i]! + r.cost); return sums; };
  const levels: Rendered[][] = [units.map(block => records(block))];
  const sums = [prefix(levels[0]!)];
  // A clip keeps whole passages, so a unit that is one long sentence, code block or JSON region can keep no text at all. Such a clip renders
  // nothing and its unit is counted in the role's one omission notice, like a dropped unit: a notice per empty clip would cost more than text.
  const NONE: Rendered = { records: [], cost: 0 };
  const emptied: Uint8Array[] = [new Uint8Array(n)];
  /** Level t holds each unit's tier-t variant. A clip that would not make the unit smaller is not taken, so sizes never grow with t. */
  const level = (t: number): Rendered[] => {
    while (levels.length <= t) {
      const previous = levels[levels.length - 1]!, wasEmpty = emptied[emptied.length - 1]!, clip = TIERS[role][levels.length - 1]!;
      const empty = new Uint8Array(n);
      const next = units.map((block, i) => {
        if (wasEmpty[i]) { empty[i] = 1; return previous[i]!; }
        const clipped = records(block, clip);
        if (role !== "notice" && isOmittable(block, mandatory) && !clipped.records.some(record => record.kind === "excerpt")) { empty[i] = 1; return NONE; }
        return clipped.cost < previous[i]!.cost ? clipped : previous[i]!;
      });
      levels.push(next); sums.push(prefix(next)); emptied.push(empty);
    }
    return levels[t]!;
  };
  const sum = (t: number) => { level(t); return sums[t]!; };

  /** All dropped units, including clips that retained no passage. Count units,
   * retain one locator per unit, and never truncate the pointer list. */
  const omission = ({ drop, tier, end }: Setting): TranscriptRecord | undefined => {
    if (role === "notice") return undefined;
    if (tier > 0) level(tier);
    let count = 0, unlocated = false;
    const sources: number[] = [];
    for (let i = 0; i < Math.max(drop, end); i++) {
      if (i >= drop && !(tier > 0 && emptied[tier]![i])) continue;
      const block = units[i]!;
      if (!isOmittable(block, mandatory)) continue;
      count++;
      if (block.sourceIndex === undefined) unlocated = true; else sources.push(block.sourceIndex);
    }
    return count ? decorate(omissionRecord(role, count, sources.sort((a, b) => a - b), unlocated)) : undefined;
  };
  const omissionCosts = new Map<string, number>();
  const omissionCost = (setting: Setting) => {
    const key = `${setting.drop}:${setting.tier}:${setting.end}`;
    let cost = omissionCosts.get(key);
    if (cost === undefined) { const record = omission(setting); omissionCosts.set(key, cost = record ? rendered([record]).cost : 0); }
    return cost;
  };

  const prefixAt = (at: number, take: number) => rendered(userPrefixRecords(units[at]!, mandatory, take).map(decorate));
  return {
    n, level, sum, omission, prefixAt,
    cost: ({ drop, tier, end, take }: Setting) => take !== undefined
      ? sums[0]![n]! - sums[0]![drop + 1]! + prefixAt(drop, take).cost + omissionCost({ drop, tier: 0, end: 0 })
      : sums[0]![n]! - sums[0]![Math.max(drop, end)]! + (end > drop ? sum(tier)[end]! - sum(tier)[drop]! : 0) + omissionCost({ drop, tier, end }),
  };
};

/** The units of a dialogue and what any configuration of them renders, by arithmetic over per-unit lengths or as the summary text. */
const createDialogue = (input: DialogueInput) => {
  const dialogue = input.blocks.filter(isDialogue);
  const times = dialogue.find(block => block.sourceTimes)?.sourceTimes;
  const decorate = (record: TranscriptRecord) => decorateRecord(record, times);
  const lanes = Object.fromEntries(ROLES.map(role => [role, createLane(role, dialogue.filter(block => block.kind === role), input.mandatorySourceIndices, decorate)])) as
    Record<Role, ReturnType<typeof createLane>>;
  const seen: Record<Role, number> = { user: 0, assistant: 0, notice: 0 };
  const order = dialogue.map(block => ({ role: block.kind, i: seen[block.kind]++ }));
  const receipts = input.blocks.filter(block => block.kind === "tool_result" &&
    (block.sourceIndex === undefined || !input.mandatorySourceIndices?.has(block.sourceIndex)));
  const tools = receipts.length ? rendered([omissionRecord("toolResult", receipts.length,
    [...new Set(receipts.flatMap(block => block.sourceIndex === undefined ? [] : [block.sourceIndex]))],
    receipts.some(block => block.sourceIndex === undefined))]) : undefined;
  const overhead = TRANSCRIPT_HEADER.length + DIALOGUE_SUFFIX.length;

  /** The length of the summary text of a configuration: its header, one line per record, and the closing section; 0 when it has no record. */
  const size = (config: Config): number => {
    const cost = ROLES.reduce((n, role) => n + lanes[role].cost(config[role]), tools?.cost ?? 0);
    return cost === 0 ? 0 : overhead + cost;
  };
  const text = (config: Config): string => {
    const records: TranscriptRecord[] = [];
    for (const { role, i } of order) {
      const { drop, tier, end } = config[role];
      if (i >= drop) records.push(...(i === drop && config[role].take !== undefined
        ? lanes[role].prefixAt(i, config[role].take!).records : lanes[role].level(i < end ? tier : 0)[i]!.records));
    }
    for (const role of ROLES) { const record = lanes[role].omission(config[role]); if (record) records.push(record); }
    if (tools) records.push(...tools.records);
    orderByOriginalSource(records, input.sourceIndices, input.sourceEntryIds);
    return records.length ? serializeTranscript(records) + DIALOGUE_SUFFIX : "";
  };
  return { lanes, size, text };
};

/** The whole pre-cut dialogue: user, assistant and notice records; tool actions and observations are omitted. "" when it renders nothing. */
export const wholeDialogue = (input: DialogueInput): string => {
  const { text } = createDialogue(input);
  return text({ user: WHOLE, assistant: WHOLE, notice: WHOLE });
};

/** The fixed omission cost of this cut, charged before any optional text. */
export const omittedDialogue = (input: DialogueInput): string => {
  const records: TranscriptRecord[] = [];
  for (const role of ["user", "assistant", "toolResult"] as const) {
    const blocks = input.blocks.filter(block => block.kind === (role === "toolResult" ? "tool_result" : role) &&
      (block.sourceIndex === undefined || !input.mandatorySourceIndices?.has(block.sourceIndex)) &&
      (!("text" in block) || Boolean(block.text.trim())));
    if (!blocks.length) continue;
    const sources = blocks.flatMap(block => block.sourceIndex === undefined ? [] : [block.sourceIndex]);
    records.push(decorateRecord(omissionRecord(role, blocks.length, sources, blocks.some(block => block.sourceIndex === undefined)), blocks[0]?.sourceTimes));
  }
  return records.length ? serializeTranscript(records) + DIALOGUE_SUFFIX : "";
};

/** Lower ranks of the single fill: the existing recent assistant third, then
 * more user turns newest first, then the remaining dialogue newest first.
 * Each lane grows only from its recent end; complete passages remain atomic. */
export const shrinkDialogue = (input: DialogueInput, limit: number): Shrunk => {
  const { lanes, size, text } = createDialogue(input);
  const { user, assistant, notice } = lanes;
  const gone = (lane: { n: number }): Setting => ({ drop: lane.n, tier: 0, end: 0 });
  const config: Config = { user: gone(user), assistant: gone(assistant), notice: gone(notice) };
  const result = (step: Step): Shrunk => {
    const summary = text(config);
    return summary.length <= limit ? { text: summary, step, size: summary.length } : { text: "", step: "none", size: 0 };
  };
  if (size({ user: WHOLE, assistant: WHOLE, notice: WHOLE }) <= limit) {
    Object.assign(config, { user: WHOLE, assistant: WHOLE, notice: WHOLE });
    return result("whole");
  }
  if (size(config) > limit) return { text: "", step: "none", size: 0 };
  // Preserve exactly shrinkDialogue's recent-third definition: newest whole
  // units that fit a third, or the newest unit's largest nonempty passage clip.
  let kept = 0;
  while (kept < assistant.n && assistant.sum(0)[assistant.n]! - assistant.sum(0)[kept]! > limit / 3) kept++;
  let recent: Setting = { drop: kept, tier: 0, end: 0 };
  if (kept === assistant.n && assistant.n > 0) for (const tier of [1, 2, 3]) {
    const cost = assistant.level(tier)[assistant.n - 1]!.cost;
    if (cost > 0 && cost <= limit / 3) { recent = { drop: assistant.n - 1, tier, end: assistant.n }; break; }
  }
  const trySetting = (role: Role, setting: Setting): boolean => {
    const previous = config[role]; config[role] = setting;
    if (size(config) <= limit) return true;
    config[role] = previous; return false;
  };
  if (!trySetting("assistant", recent)) {
    for (let drop = recent.drop + 1; drop <= assistant.n; drop++)
      if (trySetting("assistant", { ...recent, drop })) break;
  }
  // The user lane is filled before older assistant units. If its next whole
  // unit cannot fit, keep its largest exact prefix that fits, then continue
  // with the lower ranks. No fixed task/head character cap participates.
  for (let drop = user.n - 1; drop >= 0; drop--) {
    if (trySetting("user", { drop, tier: 0, end: 0 })) continue;
    const block = input.blocks.filter(isDialogue).filter(block => block.kind === "user")[drop]!;
    let low = 0, high = (block.originalText ?? block.text).length - 1;
    while (low < high) {
      const take = Math.ceil((low + high) / 2);
      if (trySetting("user", { drop, tier: 0, end: 0, take })) low = take; else high = take - 1;
    }
    if (low > 0) trySetting("user", { drop, tier: 0, end: 0, take: low });
    break;
  }
  for (let drop = config.assistant.drop - 1; drop >= 0; drop--) {
    if (trySetting("assistant", { drop, tier: 0, end: 0 })) continue;
    for (const tier of [1, 2, 3]) if (assistant.level(tier)[drop]!.records.some(record => record.kind === "excerpt") &&
      trySetting("assistant", { drop, tier, end: Math.max(drop + 1, recent.end) })) break;
    break;
  }
  for (let drop = notice.n - 1; drop >= 0; drop--) {
    if (trySetting("notice", { drop, tier: 0, end: 0 })) continue;
    trySetting("notice", { drop, tier: 1, end: drop + 1 }); break;
  }
  return result("ranked");
};
