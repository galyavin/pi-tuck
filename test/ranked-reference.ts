import type { NormalizedBlock } from '../src/tuck/types';
import { compileBrief, planBrief, type ExcerptCache } from '../src/tuck/core/brief';
import { TRANSCRIPT_HEADER, transcriptUnits, MAX_RECEIPT_CHARACTERS } from '../src/tuck/core/transcript';
import { rankBriefBlocks, type BriefRankingOptions } from '../src/tuck/core/rank';

// The ranked selection as it was before its admission loop became incremental: every candidate is planned and rendered whole.
// It is the oracle for the meter, and is slow by construction.
const DEFAULT_MAX_BLOCKS = 80;
const DEFAULT_RECENT_BLOCKS = 16;

export const selectRankedBriefBlocksByFullRender = (
  blocks: NormalizedBlock[],
  options: BriefRankingOptions = {},
): NormalizedBlock[] => {
  // A rendered allowance owns capacity. An independent count must not discard
  // fitting original dialogue; all blocks were already normalized in memory.
  const maxBlocks = options.maxBlocks ?? (options.maxBriefChars != null ? blocks.length : DEFAULT_MAX_BLOCKS);
  // Size-relative budget: when a ceiling + slope are provided, the effective
  // char budget scales with transcript length (block count) between the floor
  // (maxBriefChars) and the ceiling. Larger transcripts carry more high-value
  // long-tail, so they earn more brief budget; small sessions stay at the floor.
  const maxBriefChars =
    options.maxBriefChars != null && options.maxBriefCharsCeiling != null && options.briefCharsPerBlock != null
      ? Math.round(
          Math.min(
            options.maxBriefCharsCeiling,
            Math.max(options.maxBriefChars, options.briefCharsPerBlock * blocks.length),
          ),
        )
      : options.maxBriefChars;
  // Fast path: nothing to trim by count and no char budget to enforce.
  if (blocks.length <= maxBlocks && maxBriefChars == null && options.maxBriefUnits == null) return blocks;

  const preserveRecentBlocks = Math.min(options.preserveRecentBlocks ?? DEFAULT_RECENT_BLOCKS, maxBlocks);
  const ranked = rankBriefBlocks(blocks, options);
  const selected = new Set<number>();

  // Charge the actual candidate serialization. Adjacent-block truncation and
  // tool omission notices can change its size; isolated-block estimates cannot certify it.
  // Cache only within this synchronous selection over unchanged normalized blocks.
  const excerpts: ExcerptCache = new WeakMap();
  const full = new Set<NormalizedBlock>();
  const admit = (indices: number[], preferFull = false): boolean => {
    const added = indices.filter(i => !selected.has(i));
    if (!added.length && !preferFull) return true;
    if (selected.size + added.length > maxBlocks) return false;
    const candidate = [...selected, ...added].sort((a, b) => a - b).map(i => blocks[i]);
    const proposedFull = new Set(full);
    if (preferFull) for (const i of indices)
      if (["user", "assistant", "bash"].includes(blocks[i].kind)) proposedFull.add(blocks[i]);
    const fits = (includeOmissions = true) => {
      planBrief(candidate, proposedFull, blocks, options.mandatorySourceIndices, includeOmissions);
      const rendered = TRANSCRIPT_HEADER + "\n" + compileBrief(candidate, excerpts);
      return (maxBriefChars == null || rendered.length <= maxBriefChars) &&
        (options.maxBriefUnits == null || transcriptUnits(rendered) <= options.maxBriefUnits);
    };
    // Notices are best effort: never overflow or displace otherwise fitting text.
    if (!fits() && !fits(false)) {
      if (preferFull && indices.some(i => blocks[i].kind === "bash")) return false;
      for (const i of indices) if (!full.has(blocks[i])) proposedFull.delete(blocks[i]);
      if (!fits() && !fits(false)) return false;
    }
    for (const i of added) selected.add(i);
    full.clear();
    for (const block of proposedFull) full.add(block);
    return true;
  };

  // Keep the latest blocks to preserve local continuity, iterating NEWEST first
  // so the most recent context is guaranteed. When a char budget is active these
  // are charged against it too and over-budget blocks are skipped -- otherwise a
  // run of large recent blocks could blow past maxBriefChars (the old bug on very
  // long transcripts, where preserve-recent alone exceeded the budget).
  for (let i = blocks.length - 1; i >= Math.max(0, blocks.length - preserveRecentBlocks); i--) {
    // Historical action overviews compete after the conversational base. Fresh
    // native rounds are protected by the adapter, outside this old-prefix view.
    if (["tool_result", "tool_call", "bash"].includes(blocks[i].kind)) continue;
    if (selected.has(i)) continue;
    if (!admit([i])) continue;
  }

  // Structural exchanges are derived from the original chronology. A user
  // carries prose from the preceding assistant message, including prose before
  // that message's trailing calls. Only explicit source identity crosses calls.
  const groups = ranked.filter(r => r.block.kind === "user").map(item => {
    let preceding = item.index - 1;
    while (preceding >= 0 && blocks[preceding].kind === "tool_result") preceding--;
    const previous = blocks[preceding];
    const prose: number[] = [];
    if (previous?.kind === "assistant" || previous?.kind === "tool_call") {
      const source = previous.sourceIndex;
      for (let i = preceding; i >= 0; i--) {
        if (source === undefined ? i !== preceding : blocks[i].sourceIndex !== source) break;
        if (blocks[i].kind === "assistant") prose.unshift(i);
      }
    }
    return [...prose, item.index];
  }).reverse();
  // Admit the conversational base before spending room on any full proposal.
  // Otherwise a newly fitting recent assistant can crowd out an older user.
  for (const group of groups) {
    if (!admit(group)) {
      // Bounded atomicity: an oversized pair must not exclude a useful user turn.
      admit([group.at(-1)!]);
    }
  }
  const ordered = [...ranked].sort((a, b) => b.score - a.score || b.index - a.index);
  for (const item of ordered) {
    if (selected.size >= maxBlocks) break;
    if (selected.has(item.index)) continue;
    if (item.block.kind === "tool_result") continue;
    if (!admit([item.index])) continue;
  }

  // Complete the existing coverage pass before expanding already represented
  // user wording. Whole proposals/choices are still eligible in spare room.
  for (const i of [...selected].sort((a, b) => b - a))
    if (blocks[i].kind === "user") admit([i], true);
  // Expand selected assistant prose only into spare capacity. A large recent
  // message must not consume the budget before user exchanges are considered.
  for (const i of [...selected].sort((a, b) => b - a))
    if (blocks[i].kind === "assistant") admit([i], true);

  // Cheap exact observations use only spare allowance after dialogue. Size
  // and recency are signals, not proof of usefulness, freshness or success.
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block.kind === "tool_result" && block.originalReceipt) admit([i]);
  }

  // Enrich already retained shell events only after the unchanged base. Whole
  // stored output may be truncated; it is historical evidence, not verification.
  for (const i of [...selected].sort((a, b) => b - a)) {
    const block = blocks[i];
    if (block.kind === "bash" && block.sourceIndex !== undefined && block.output.length <= MAX_RECEIPT_CHARACTERS)
      admit([i], true);
  }

  const result = [...selected].sort((a, b) => a - b).map((i) => blocks[i]);
  planBrief(result, full, blocks, options.mandatorySourceIndices);
  const rendered = TRANSCRIPT_HEADER + "\n" + compileBrief(result, excerpts);
  if ((maxBriefChars != null && rendered.length > maxBriefChars) ||
    (options.maxBriefUnits != null && transcriptUnits(rendered) > options.maxBriefUnits))
    planBrief(result, full, blocks, options.mandatorySourceIndices, false);
  return result;
};
