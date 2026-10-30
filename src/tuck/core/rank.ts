import type { NormalizedBlock, FileOps } from "../types";
import { extractPath } from "./tool-args";
import { compileBrief, planBrief, heredocCloseIndex, type ExcerptCache } from "./brief";
import { createBriefMeter, type BriefSize } from "./brief-meter";
import { TRANSCRIPT_HEADER, transcriptUnits, MAX_RECEIPT_CHARACTERS } from "./transcript";

export interface BriefRankingOptions {
  /** Maximum normalized blocks used to build the brief transcript. */
  maxBlocks?: number;
  /** Optional complete serialized historical-view allowance. */
  maxBriefUnits?: number;
  /** Full sources rendered separately by the caller; retain their structural relationships. */
  mandatorySourceIndices?: ReadonlySet<number>;
  /** Always keep this many latest blocks to preserve local continuity. */
  preserveRecentBlocks?: number;
  /** Hook-provided file activity, used as structural signal instead of prose guessing. */
  fileOps?: FileOps;
  /**
   * Optional size budget (in characters of rendered brief) for the selected
   * blocks. When set, this is the PRIMARY limit: blocks are added by score
   * until the budget is reached, and lower-value blocks are skipped rather
   * than truncating the tail. maxBlocks still applies as a safety upper bound.
   * Callers derive this from a token budget via charsPerToken.
   * When maxBriefCharsCeiling + briefCharsPerBlock are also set, this acts as
   * the FLOOR of a size-relative budget (see below).
   */
  maxBriefChars?: number;
  /**
   * Optional upper bound for a size-relative char budget. When set together
   * with maxBriefChars (floor) and briefCharsPerBlock (slope), the effective
   * budget becomes clamp(briefCharsPerBlock * blockCount, maxBriefChars,
   * maxBriefCharsCeiling): larger transcripts (which carry more high-value
   * long-tail -- edits, commands, tests) get more brief budget, while small
   * sessions stay at the floor and this hard ceiling prevents unbounded growth.
   */
  maxBriefCharsCeiling?: number;
  /** Per-block slope (chars) for the size-relative budget. Requires the ceiling. */
  briefCharsPerBlock?: number;
}

export interface RankedBlock {
  block: NormalizedBlock;
  index: number;
  score: number;
  reasons: string[];
}

const DEFAULT_MAX_BLOCKS = 80;
const DEFAULT_RECENT_BLOCKS = 16;

const EDIT_TOOL_RE = /^(edit|write|multiedit|quick_edit|target_edit|apply_patch)$/i;
const READ_TOOL_RE = /^(read|glob|grep|ls|find|semantic_query|semantic_grep|semantic_show)$/i;
const TEST_COMMAND_RE = /\b(?:bun|npm|pnpm|yarn|node|pytest|cargo|go|mvn|gradle)\b[^\n]*(?:test|spec|check|lint|build|tsc)/i;
// Durable workflow facts: which PR/issue was acted on, and git state changes.
// Structural (command shape), not prose — same spirit as TEST_COMMAND_RE.
const WORKFLOW_COMMAND_RE =
  /(?:^|\s)(?:gh\s+(?:pr|issue)\s+[a-z-]+|git\s+(?:commit|push|merge|rebase|revert|cherry-pick|tag|reset|checkout|branch)\b)/i;
const MIN_SEGMENT_CLOSING_ASSISTANT_CHARS = 120;

// A bash block whose every meaningful line is pure scaffolding (set -e, cd,
// export, ls, echo, sleep, pwd, comments, heredoc bodies) carries no durable
// fact. Such blocks get a score penalty so the size-relative budget never
// pulls them in ahead of real edits/commands when spare chars appear.
const TRIVIAL_BASH_LINE_RE =
  /^(?:set\s+[-+]|cd(?:\s+\S+)?$|export\s+\w+=|(?:source|\.)\s+\S+|pwd$|true$|:$|#|ls(?:\s|$)|echo\b|clear$|sleep\b)/;
const TRIVIAL_BASH_PENALTY = 16;

const isTrivialOnlyBash = (raw: string): boolean => {
  const lines = raw.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    kept.push(lines[i]);
    // Skip heredoc bodies (they are content, not scaffolding) using the same
    // hardened detection as brief.ts: only skip when the terminator exists
    // downstream, so a stray `<<` never swallows a later real command.
    const close = heredocCloseIndex(lines, i);
    if (close !== -1) i = close;
  }
  const meaningful = kept.map((l) => l.trim()).filter(Boolean).filter((l) => !TRIVIAL_BASH_LINE_RE.test(l));
  return meaningful.length === 0;
};

const asPathSet = (paths?: string[]): Set<string> => new Set((paths ?? []).filter(Boolean));

const bashCommandFromBlock = (block: NormalizedBlock): string | undefined => {
  if (block.kind === "bash") return block.command;
  if (block.kind === "tool_call" && /^bash$/i.test(block.name) && typeof block.args.command === "string") {
    return block.args.command;
  }
  return undefined;
};

const pathFromBlock = (block: NormalizedBlock): string | undefined => {
  if (block.kind === "tool_call") return extractPath(block.args) ?? undefined;
  if (block.kind === "bash") {
    const match = block.command.match(/(?:^|\s)([\w./-]+\.[\w-]+)(?:\s|$)/);
    return match?.[1];
  }
  return undefined;
};

const add = (ranked: RankedBlock, points: number, reason: string) => {
  ranked.score += points;
  ranked.reasons.push(reason);
};

const scoreBlock = (
  block: NormalizedBlock,
  index: number,
  total: number,
  modifiedFiles: Set<string>,
  readFiles: Set<string>,
): RankedBlock => {
  const ranked: RankedBlock = { block, index, score: 0, reasons: [] };
  const recency = total <= 1 ? 0 : Math.round((index / (total - 1)) * 12);
  add(ranked, recency, "recency");

  if (block.kind === "user") add(ranked, 18, "user-turn");
  if (block.kind === "assistant") add(ranked, 10, "assistant-context");
  if (block.kind === "notice") add(ranked, 10, "framework-notice");
  if (block.kind === "tool_result") add(ranked, 1, "tool-result-low-value");

  if (block.kind === "tool_call") {
    const command = bashCommandFromBlock(block);
    if (EDIT_TOOL_RE.test(block.name)) add(ranked, 34, "edit-tool");
    else if (command && TEST_COMMAND_RE.test(command)) add(ranked, 26, "test-command");
    else if (READ_TOOL_RE.test(block.name)) add(ranked, 6, "read-tool");
    else add(ranked, 12, "tool-call");
    if (command && WORKFLOW_COMMAND_RE.test(command)) add(ranked, 14, "workflow-command");
    if (command && isTrivialOnlyBash(command)) add(ranked, -TRIVIAL_BASH_PENALTY, "trivial-bash");
  }

  if (block.kind === "bash") {
    add(ranked, 8, "bash");
    if (block.exitCode != null && block.exitCode !== 0) add(ranked, 24, "nonzero-exit");
    if (TEST_COMMAND_RE.test(block.command)) add(ranked, 22, "test-command");
    if (WORKFLOW_COMMAND_RE.test(block.command)) add(ranked, 14, "workflow-command");
    // Penalize scaffolding-only commands, but not ones that failed (a failed
    // `ls`/`cd` still records a real state fact via nonzero-exit).
    if (isTrivialOnlyBash(block.command) && !(block.exitCode != null && block.exitCode !== 0)) {
      add(ranked, -TRIVIAL_BASH_PENALTY, "trivial-bash");
    }
  }

  const path = pathFromBlock(block);
  if (path) {
    if (modifiedFiles.has(path)) add(ranked, 18, "hook-modified-file");
    if (readFiles.has(path)) add(ranked, 6, "hook-read-file");
  }

  if (block.kind === "tool_result" && block.text.length > 1000) add(ranked, -8, "long-tool-result");
  return ranked;
};

const boostAdjacency = (ranked: RankedBlock[]) => {
  const important = ranked
    .filter((r) => r.score >= 34 || r.reasons.includes("edit-tool") || r.reasons.includes("test-command") || r.reasons.includes("nonzero-exit"))
    .map((r) => r.index);

  for (const idx of important) {
    for (let i = idx - 1; i >= Math.max(0, idx - 8); i--) {
      if (ranked[i].block.kind === "user") {
        add(ranked[i], 10, "near-important-event");
        break;
      }
    }
    for (let i = idx - 1; i >= Math.max(0, idx - 4); i--) {
      if (ranked[i].block.kind === "assistant") {
        add(ranked[i], 7, "near-important-event");
        break;
      }
    }
    for (let i = idx + 1; i <= Math.min(ranked.length - 1, idx + 4); i++) {
      if (ranked[i].block.kind === "assistant" || ranked[i].block.kind === "bash") {
        add(ranked[i], 5, "after-important-event");
        break;
      }
    }
  }
};

const nextNonToolResult = (ranked: RankedBlock[], index: number): NormalizedBlock | undefined => {
  for (let i = index + 1; i < ranked.length; i++) {
    if (ranked[i].block.kind !== "tool_result") return ranked[i].block;
  }
  return undefined;
};

const boostSegmentClosingAssistants = (ranked: RankedBlock[]) => {
  for (let i = 0; i < ranked.length; i++) {
    const current = ranked[i];
    if (current.block.kind !== "assistant") continue;
    if (current.block.text.trim().length < MIN_SEGMENT_CLOSING_ASSISTANT_CHARS) continue;
    const next = nextNonToolResult(ranked, i);
    if (!next || next.kind === "user") {
      add(current, 14, "segment-closing-assistant");
    }
  }
};

export const rankBriefBlocks = (blocks: NormalizedBlock[], options: BriefRankingOptions = {}): RankedBlock[] => {
  const modifiedFiles = asPathSet(options.fileOps?.modifiedFiles);
  const readFiles = asPathSet(options.fileOps?.readFiles);
  const ranked = blocks.map((block, index) => scoreBlock(block, index, blocks.length, modifiedFiles, readFiles));
  boostAdjacency(ranked);
  boostSegmentClosingAssistants(ranked);
  return ranked;
};

export const selectRankedBriefBlocks = (
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
  // The meter keeps that size current as blocks join; the final render below remains the authority.
  const excerpts: ExcerptCache = new WeakMap();
  const full = new Set<NormalizedBlock>();
  const meter = createBriefMeter(blocks, options.mandatorySourceIndices, excerpts);
  const within = (size: BriefSize) => (maxBriefChars == null || size.chars <= maxBriefChars) &&
    (options.maxBriefUnits == null || size.units <= options.maxBriefUnits);
  const admit = (indices: number[], preferFull = false): boolean => {
    const added = indices.filter(i => !selected.has(i));
    if (!added.length && !preferFull) return true;
    if (selected.size + added.length > maxBlocks) return false;
    const promoted = preferFull ? indices.filter(i => ["user", "assistant", "bash"].includes(blocks[i].kind) && !full.has(blocks[i])) : [];
    // Notices are best effort: never overflow or displace otherwise fitting text.
    const fits = () => { const { withNotices, withoutNotices } = meter.size(added); return within(withNotices) || within(withoutNotices); };
    for (const i of added) meter.select(i);
    for (const i of promoted) meter.promote(i);
    if (!fits()) {
      for (const i of promoted.splice(0)) meter.demote(i);
      // A whole shell proposal that does not fit is withdrawn, not retried as an excerpt.
      if ((preferFull && indices.some(i => blocks[i].kind === "bash")) || !fits()) { for (const i of added) meter.unselect(i); return false; }
    }
    for (const i of added) selected.add(i);
    meter.commit(added);
    for (const i of promoted) full.add(blocks[i]);
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
