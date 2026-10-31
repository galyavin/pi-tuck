import type { NormalizedBlock } from "../types";
import { blockRecords, decorateRecord, isDialogue, isOmittable, omissionRecord, type Clip, type DialogueBlock } from "./brief";
import { DIALOGUE_SUFFIX } from "./format";
import { orderByOriginalSource } from "./source-order";
import { serializeTranscript, TRANSCRIPT_HEADER, type TranscriptRecord } from "./transcript";

type Role = "user" | "assistant" | "notice";
const ROLES: readonly Role[] = ["user", "assistant", "notice"];

/** The lossy variants of a unit, least clipped first: the words kept from the start of its text and from its end. */
const TIERS: Record<Role, readonly Clip[]> = {
  assistant: [[80, 120], [40, 40], [16, 0]],
  user: [[256, 0], [64, 0], [24, 0]],
  notice: [[256, 0]],
};
const TOOLS_OMITTED: TranscriptRecord = { kind: "omission", reason: "Historical tool actions and observations omitted; read original sources with tuck_recall" };

export interface DialogueInput {
  /** Normalized, noise-filtered blocks of the pre-cut history in chronological order: dialogue and tool blocks alike. */
  blocks: NormalizedBlock[];
  /** Sources the adapter quotes in its own base: they render as nothing here and are not counted as omitted. */
  mandatorySourceIndices?: ReadonlySet<number>;
  /** The source index of each original message and, when known, its entry id, for the original order of the records. */
  sourceIndices: readonly (number | undefined)[];
  sourceEntryIds?: readonly string[];
}

/** The configurations the ladder tries, in order; "none" is no configuration that fits. */
export type Step = "whole" | `A${1 | 2 | 3}` | "B" | `C${1 | 2 | 3}` | "D" | "E1" | "E2" | "none";
export interface Shrunk {
  /** The summary text, or "" when nothing fits. */
  text: string;
  step: Step;
  /** The length the ladder computed from per-unit lengths before it rendered `text`. */
  size: number;
}

/** What one unit renders in a configuration, and its serialized size: each record's JSON plus a newline. */
interface Rendered { records: TranscriptRecord[]; cost: number }
const rendered = (records: TranscriptRecord[]): Rendered => ({ records, cost: records.reduce((n, r) => n + JSON.stringify(r).length + 1, 0) });

/** Units [0, drop) of a role are dropped, [drop, end) are clipped to `tier`, and the rest stay whole. */
interface Setting { drop: number; tier: number; end: number }
type Config = Record<Role, Setting>;
const WHOLE: Setting = { drop: 0, tier: 0, end: 0 };

/** The units of one role in chronological order, with each variant's cost summed over every prefix. */
const createLane = (role: Role, units: DialogueBlock[], mandatory: ReadonlySet<number> | undefined, decorate: (record: TranscriptRecord) => TranscriptRecord) => {
  const n = units.length;
  const records = (block: DialogueBlock, clip?: Clip) => rendered(blockRecords(block, mandatory, clip).map(decorate));
  const prefix = (level: Rendered[]) => { const sums = new Float64Array(n + 1); level.forEach((r, i) => sums[i + 1] = sums[i]! + r.cost); return sums; };
  const levels: Rendered[][] = [units.map(block => records(block))];
  const sums = [prefix(levels[0]!)];
  /** Level t holds each unit's tier-t variant. A clip that would not make the unit smaller is not taken, so sizes never grow with t. */
  const level = (t: number): Rendered[] => {
    while (levels.length <= t) {
      const previous = levels[levels.length - 1]!, clip = TIERS[role][levels.length - 1]!;
      const next = units.map((block, i) => { const clipped = records(block, clip); return clipped.cost < previous[i]!.cost ? clipped : previous[i]!; });
      levels.push(next); sums.push(prefix(next));
    }
    return levels[t]!;
  };
  const sum = (t: number) => { level(t); return sums[t]!; };

  // The notice for a dropped prefix of p units: how many unselected text blocks, the first locators, and whether some have none.
  let tally: { counts: Int32Array; unlocated: Uint8Array; smallest: number[][] } | undefined;
  const omission = (p: number): TranscriptRecord | undefined => {
    if (role === "notice") return undefined;
    if (!tally) {
      tally = { counts: new Int32Array(n + 1), unlocated: new Uint8Array(n + 1), smallest: new Array(n + 1) };
      let smallest: number[] = [], count = 0, unlocated = 0;
      tally.smallest[0] = smallest;
      units.forEach((block, i) => {
        if (isOmittable(block, mandatory)) {
          count++;
          const source = block.sourceIndex;
          if (source === undefined) unlocated = 1;
          else if (!smallest.includes(source) && (smallest.length < 9 || source < smallest[8]!)) {
            smallest = [...smallest, source].sort((a, b) => a - b).slice(0, 9);
          }
        }
        tally!.counts[i + 1] = count; tally!.unlocated[i + 1] = unlocated; tally!.smallest[i + 1] = smallest;
      });
    }
    return tally.counts[p] ? decorate(omissionRecord(role, tally.counts[p]!, tally.smallest[p]!, tally.unlocated[p] === 1)) : undefined;
  };
  const omissionCosts = new Map<number, number>();
  const omissionCost = (p: number) => {
    let cost = omissionCosts.get(p);
    if (cost === undefined) { const record = omission(p); omissionCosts.set(p, cost = record ? rendered([record]).cost : 0); }
    return cost;
  };

  return {
    n, level, sum, omission,
    cost: ({ drop, tier, end }: Setting) => sums[0]![n]! - sums[0]![Math.max(drop, end)]! + (end > drop ? sum(tier)[end]! - sum(tier)[drop]! : 0) + omissionCost(drop),
  };
};

/** The units of a dialogue and what any configuration of them renders, by arithmetic over per-unit lengths or as the summary text. */
const createDialogue = (input: DialogueInput) => {
  const dialogue = input.blocks.filter(isDialogue);
  const times = dialogue.find(block => block.sourceTimes)?.sourceTimes;
  const decorate = (record: TranscriptRecord) => decorateRecord(record, times);
  const roleOf = (block: DialogueBlock): Role => block.kind;
  const lanes = Object.fromEntries(ROLES.map(role => [role, createLane(role, dialogue.filter(block => roleOf(block) === role), input.mandatorySourceIndices, decorate)])) as
    Record<Role, ReturnType<typeof createLane>>;
  const seen: Record<Role, number> = { user: 0, assistant: 0, notice: 0 };
  const order = dialogue.map(block => ({ role: roleOf(block), i: seen[roleOf(block)]++ }));
  const tools = input.blocks.length > dialogue.length ? rendered([TOOLS_OMITTED]) : undefined;
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
      if (i >= drop) records.push(...lanes[role].level(i < end ? tier : 0)[i]!.records);
    }
    for (const role of ROLES) { const record = lanes[role].omission(config[role].drop); if (record) records.push(record); }
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

/**
 * The same dialogue shrunk until its summary text is at most `limit` characters, oldest first. The first configuration that fits wins:
 *   A. the newest k assistant units whole, the older ones clipped to tier 1, 2, 3 (the largest k that fits, for each tier in turn);
 *   B. every assistant unit at tier 3, the oldest d dropped;
 *   C. the newest assistant units that fit a third of the limit at tier 3, the rest dropped; then the oldest u user units clipped to tier 1, 2, 3;
 *   D. every user unit at tier 3, the oldest dropped;
 *   E. the oldest notices dropped, then the oldest of the remaining assistant units.
 * Every step is a one-parameter family whose size is read from prefix sums of the per-unit lengths, so a step costs O(units). A notice is clipped
 * to its one tier in every configuration but the whole dialogue. The size is arithmetic over unit lengths; the rendered text has the last say:
 * a configuration whose text is over the limit is passed over.
 */
export const shrinkDialogue = (input: DialogueInput, limit: number): Shrunk => {
  const { lanes, size, text } = createDialogue(input);
  const { user, assistant, notice } = lanes;
  const clipped: Setting = { drop: 0, tier: 1, end: notice.n };
  const found = (step: Step, config: Config): Shrunk | undefined => {
    const length = size(config);
    if (length > limit) return undefined;
    const summary = text(config);
    return summary.length <= limit ? { text: summary, step, size: length } : undefined;
  };
  const gone = (lane: { n: number }): Setting => ({ drop: lane.n, tier: 3, end: lane.n });
  const tiers = [1, 2, 3] as const;

  let hit = found("whole", { user: WHOLE, assistant: WHOLE, notice: WHOLE });
  if (hit) return hit;
  for (const t of tiers) for (let k = assistant.n; k >= 0; k--)
    if (hit = found(`A${t}`, { user: WHOLE, assistant: { drop: 0, tier: t, end: assistant.n - k }, notice: clipped })) return hit;
  for (let d = 0; d <= assistant.n; d++)
    if (hit = found("B", { user: WHOLE, assistant: { drop: d, tier: 3, end: assistant.n }, notice: clipped })) return hit;
  // From here users give way, and the assistant keeps only its newest units that fit a third of the limit.
  let kept = 0;
  while (kept < assistant.n && assistant.sum(3)[assistant.n]! - assistant.sum(3)[kept]! > limit / 3) kept++;
  const recent: Setting = { drop: kept, tier: 3, end: assistant.n };
  for (const t of tiers) for (let u = 0; u <= user.n; u++)
    if (hit = found(`C${t}`, { user: { drop: 0, tier: t, end: u }, assistant: recent, notice: clipped })) return hit;
  for (let d = 0; d <= user.n; d++)
    if (hit = found("D", { user: { drop: d, tier: 3, end: user.n }, assistant: recent, notice: clipped })) return hit;
  for (let d = 0; d <= notice.n; d++)
    if (hit = found("E1", { user: gone(user), assistant: recent, notice: { drop: d, tier: 1, end: notice.n } })) return hit;
  for (let d = kept; d <= assistant.n; d++)
    if (hit = found("E2", { user: gone(user), assistant: { drop: d, tier: 3, end: assistant.n }, notice: gone(notice) })) return hit;
  return { text: "", step: "none", size: 0 };
};
