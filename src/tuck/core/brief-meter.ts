import type { NormalizedBlock } from "../types";
import { absorbCall, blockRecords, coveredCallKey, decorateRecord, isOmittable, noticeTimes, omissionRecord, receiptKey, repeatsCall, segmentClosing,
  type CallRecord, type ExcerptCache } from "./brief";
import { TRANSCRIPT_HEADER, lineUnits, type TranscriptRecord } from "./transcript";

/** A set of integers in [0, size) with ordered neighbour queries, in a tree of 32-bit words. */
export class IndexSet {
  private readonly levels: Uint32Array[] = [];
  constructor(size: number) {
    let words = Math.max(1, size);
    do { words = Math.ceil(words / 32); this.levels.push(new Uint32Array(words)); } while (words > 1);
  }
  has(i: number): boolean { return (this.levels[0]![i >>> 5]! & (1 << (i & 31))) !== 0; }
  add(i: number): void {
    for (const level of this.levels) {
      const word = i >>> 5, was = level[word]!;
      level[word] = was | (1 << (i & 31));
      if (was !== 0) return;
      i = word;
    }
  }
  remove(i: number): void {
    for (const level of this.levels) {
      const word = i >>> 5;
      level[word] = level[word]! & ~(1 << (i & 31));
      if (level[word] !== 0) return;
      i = word;
    }
  }
  /** The smallest member above `i`, or -1. */
  next(i: number): number {
    for (let l = 0; l < this.levels.length; l++) {
      const word = i >>> 5, bit = i & 31;
      const rest = bit === 31 ? 0 : this.levels[l]![word]! & (-1 << (bit + 1));
      if (rest === 0) { i = word; continue; }
      let at = (word << 5) | (31 - Math.clz32(rest & -rest));
      for (let k = l - 1; k >= 0; k--) { const w = this.levels[k]![at]!; at = (at << 5) | (31 - Math.clz32(w & -w)); }
      return at;
    }
    return -1;
  }
  /** The largest member below `i`, or -1. */
  prev(i: number): number {
    for (let l = 0; l < this.levels.length; l++) {
      const word = i >>> 5, bit = i & 31;
      const rest = this.levels[l]![word]! & ~(-1 << bit);
      if (rest === 0) { i = word; continue; }
      let at = (word << 5) | (31 - Math.clz32(rest));
      for (let k = l - 1; k >= 0; k--) at = (at << 5) | (31 - Math.clz32(this.levels[k]![at]!));
      return at;
    }
    return -1;
  }
}

export interface BriefSize { chars: number; units: number }

export interface BriefMeter {
  /** Block `i` joins the selection, or leaves it again. */
  select(i: number): void;
  unselect(i: number): void;
  /** Block `i` is rendered whole instead of as an excerpt, or no longer. */
  promote(i: number): void;
  demote(i: number): void;
  /** The rendered size of the selection, were the unselected blocks `added` selected too, with and without the omission notices. */
  size(added: readonly number[]): { withNotices: BriefSize; withoutNotices: BriefSize };
  /** Settles the omission notices for blocks selected for good. */
  commit(added: readonly number[]): void;
}

/**
 * The size of `TRANSCRIPT_HEADER + "\n" + compileBrief(selected)` as blocks join, kept up to date by recomputing only the records a change
 * can affect, which are those of the block, its neighbours and the identical calls merged with them. This is the admission loop's yardstick,
 * so it must equal what the full render measures; the final render in `selectRankedBriefBlocks` remains the authority.
 *
 * It relies on what `normalize` guarantees for the blocks of one brief: they are distinct objects; all carry the same `sourceTimes` or none
 * does; and notices that share a `sourceEntryId` share a `sourceTime`.
 */
export const createBriefMeter = (blocks: NormalizedBlock[], mandatory: ReadonlySet<number> | undefined, cache: ExcerptCache): BriefMeter => {
  const n = blocks.length;
  const closing = segmentClosing(blocks);
  const times = blocks[0]?.sourceTimes;
  const entryTimes = noticeTimes(blocks);
  const lengths = new WeakMap<TranscriptRecord, number>();
  const lengthOf = (record: TranscriptRecord): number => {
    let length = lengths.get(record);
    if (length === undefined) lengths.set(record, length = JSON.stringify(decorateRecord(record, times, entryTimes)).length);
    return length;
  };

  // The state of each block: selected, rendered whole, and the records it renders alone while it has any (`active`).
  const selected = new Uint8Array(n), whole = new Uint8Array(n);
  const records: (TranscriptRecord[] | undefined)[] = new Array(n);
  const rendered: (TranscriptRecord[] | undefined)[][] = [new Array(n), new Array(n)];
  const active = new IndexSet(n);
  // Blocks whose first record is a repeat of the record before it fold into it; the rest of the output follows from these relations.
  const merged = new Uint8Array(n);
  const contributedChars = new Int32Array(n), contributedUnits = new Int32Array(n), contributedRecords = new Int32Array(n);
  let chars = 0, units = 0, count = 0;

  // A selected receipt makes the overview of the call it quotes redundant.
  const callKeys: (string | undefined)[] = new Array(n);
  const receiptKeys: (string | undefined)[] = new Array(n);
  const callsOf = new Map<string, number[]>(), receipts = new Map<string, number>();
  blocks.forEach((block, i) => {
    const call = coveredCallKey(block);
    if (call !== undefined) { callKeys[i] = call; const calls = callsOf.get(call); if (calls) calls.push(i); else callsOf.set(call, [i]); }
    receiptKeys[i] = receiptKey(block);
  });

  const own = (i: number): TranscriptRecord[] | undefined => {
    const block = blocks[i]!, key = callKeys[i];
    if (key !== undefined && receipts.get(key)) return undefined;
    const slot = rendered[whole[i]!]!;
    const result = slot[i] ??= blockRecords(block, { full: whole[i] === 1, closing: closing.has(block), mandatory, bounded: true, covered: false }, cache);
    return result.length ? result : undefined;
  };

  const repeats = (a: number, b: number): boolean => {
    const next = records[b]!;
    return next.length === 1 && repeatsCall(records[a]!.at(-1), next[0]!);
  };

  const first = (from: number): number => active.has(from) ? from : active.next(from);

  const setRecords = (j: number, next: TranscriptRecord[] | undefined): void => {
    if (records[j] === next) return;
    // Every group of repeats that the change can reach: from the head of the group before `j` to the end of the group after it.
    const before = active.prev(j), after = active.next(j);
    let low = j, high = j;
    if (before !== -1) for (low = before; merged[low]; low = active.prev(low));
    if (after !== -1) for (high = after; ;) { const further = active.next(high); if (further === -1 || !merged[further]) break; high = further; }
    for (let b = first(low); b !== -1 && b <= high; b = active.next(b)) {
      chars -= contributedChars[b]!; units -= contributedUnits[b]!; count -= contributedRecords[b]!;
      contributedChars[b] = contributedUnits[b] = contributedRecords[b] = 0;
    }
    records[j] = next;
    if (next) active.add(j); else active.remove(j);
    let group: number[] = [];
    const settle = () => {
      if (!group.length) return;
      const head = records[group[0]!]!;
      const shown = group.length === 1 ? head :
        [group.slice(1).reduce((all, b) => absorbCall(all as never, records[b]![0] as never), head[0]!)];
      for (const record of shown) {
        const length = lengthOf(record);
        contributedChars[group[0]!] += length; contributedUnits[group[0]!] += lineUnits(length); contributedRecords[group[0]!]++;
      }
      chars += contributedChars[group[0]!]!; units += contributedUnits[group[0]!]!; count += contributedRecords[group[0]!]!;
    };
    for (let b = first(low); b !== -1 && b <= high; b = active.next(b)) {
      const previous = active.prev(b);
      merged[b] = previous !== -1 && repeats(previous, b) ? 1 : 0;
      if (!merged[b]) { settle(); group = []; }
      group.push(b);
    }
    settle();
  };
  const refresh = (i: number) => setRecords(i, selected[i] ? own(i) : undefined);

  const quoted = (i: number, delta: 1 | -1) => {
    const key = receiptKeys[i];
    if (key === undefined) return;
    const now = (receipts.get(key) ?? 0) + delta;
    receipts.set(key, now);
    if (now === (delta === 1 ? 1 : 0)) for (const call of callsOf.get(key) ?? []) if (selected[call]) refresh(call);
  };

  // The omission notices say how many unselected user and assistant text blocks there are and where the first of them were read.
  const roles = (["user", "assistant"] as const).map(role => {
    const perSource = new Map<number, number>();
    let total = 0, unlocated = 0;
    for (const block of blocks) if (block.kind === role && isOmittable(block, mandatory)) {
      total++;
      if (block.sourceIndex === undefined) unlocated++; else perSource.set(block.sourceIndex, (perSource.get(block.sourceIndex) ?? 0) + 1);
    }
    const sources = [...perSource.keys()].sort((a, b) => a - b);
    const ids = new Map(sources.map((source, id) => [source, id]));
    const alive = new IndexSet(sources.length);
    sources.forEach((_, id) => alive.add(id));
    return { role, total, unlocated, perSource, sources, ids, alive };
  });
  const omittedBy = (added: readonly number[], role: typeof roles[number]) => {
    let removed = 0, unlocated = 0;
    const taken = new Map<number, number>();
    for (const i of added) {
      const block = blocks[i]!;
      if (block.kind !== role.role || !isOmittable(block, mandatory)) continue;
      removed++;
      if (block.sourceIndex === undefined) unlocated++; else taken.set(block.sourceIndex, (taken.get(block.sourceIndex) ?? 0) + 1);
    }
    return { removed, unlocated, taken };
  };
  const notice = (added: readonly number[], role: typeof roles[number]): TranscriptRecord | undefined => {
    const { removed, unlocated, taken } = omittedBy(added, role);
    if (role.total === removed) return undefined;
    const gone = new Set<number>();
    for (const [source, k] of taken) if (role.perSource.get(source) === k) gone.add(source);
    const sources: number[] = [];
    for (let id = role.alive.has(0) ? 0 : role.alive.next(0); id !== -1 && sources.length < 9; id = role.alive.next(id))
      if (!gone.has(role.sources[id]!)) sources.push(role.sources[id]!);
    return omissionRecord(role.role, role.total - removed, sources, role.unlocated > unlocated);
  };

  const header = TRANSCRIPT_HEADER.length + 1;
  const rendering = (c: number, u: number, k: number): BriefSize => k === 0 ? { chars: header, units: 2 } : { chars: header + c + k - 1, units: 1 + u };

  return {
    select(i) { selected[i] = 1; quoted(i, 1); refresh(i); },
    unselect(i) { selected[i] = 0; refresh(i); quoted(i, -1); },
    promote(i) { whole[i] = 1; refresh(i); },
    demote(i) { whole[i] = 0; refresh(i); },
    size(added) {
      let c = 0, u = 0, k = 0;
      for (const role of roles) {
        const record = notice(added, role);
        if (!record) continue;
        const length = lengthOf(record);
        c += length; u += lineUnits(length); k++;
      }
      return { withNotices: rendering(chars + c, units + u, count + k), withoutNotices: rendering(chars, units, count) };
    },
    commit(added) {
      for (const role of roles) {
        const { removed, unlocated, taken } = omittedBy(added, role);
        role.total -= removed; role.unlocated -= unlocated;
        for (const [source, k] of taken) {
          const left = role.perSource.get(source)! - k;
          role.perSource.set(source, left);
          if (left === 0) role.alive.remove(role.ids.get(source)!);
        }
      }
    },
  };
};
