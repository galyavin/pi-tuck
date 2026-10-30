const normalizeKeepUserTurns = (keepUserTurns: number): number => {
  if (!Number.isFinite(keepUserTurns)) return 0;
  return Math.max(0, Math.floor(keepUserTurns));
};
import { estimateSourceMessageChars, estimateTokensFromChars } from "./core/token-estimate";
export type BudgetCutKind = "no_anchor" | "oversized_tail";
export const OVERSIZED_TAIL_FACTOR = 2.5;
export const MAX_TAIL_TOKENS = 25_000;
interface EntryWithMessage {
  entry: { id: string; type: string };
  message: { role: string; content: unknown };
}

// Convert a non-message entry that carries LLM-context text (custom_message /
// branch_summary) into its agent-message form, mirroring pi-core's
// createCustomMessage / createBranchSummaryMessage (not root-exported, so inlined).
const toLiveMessage = (entry: any): { role: string; content: unknown; [key: string]: unknown } | null => {
  if (entry.type === "message" && entry.message) return entry.message;
  if (entry.type === "custom_message") {
    return {
      role: "custom",
      customType: entry.customType,
      content: entry.content,
      display: entry.display,
      details: entry.details,
      timestamp: entry.timestamp != null ? new Date(entry.timestamp).getTime() : undefined,
    };
  }
  if (entry.type === "branch_summary") {
    return {
      role: "branchSummary",
      summary: entry.summary,
      fromId: entry.fromId,
      content: undefined,
      timestamp: entry.timestamp != null ? new Date(entry.timestamp).getTime() : undefined,
    };
  }
  return null;
};

export type OwnCutCancelReason = "no_live_messages";

export type OwnCutResult =
  | {
      ok: true;
      messages: any[];
      /** Entry ids parallel to `messages` — used to resolve global `#N` refs. */
      selectedIds: string[];
      firstKeptEntryId: string;
      compactAll: boolean;
      keptUserTurns: number;
      keepFallbackToCompactAll: boolean;
      budgetCut?: BudgetCutKind;
    }
  | { ok: false; reason: OwnCutCancelReason };

const collectLiveMessages = (branchEntries: any[]): EntryWithMessage[] => {
  // Find the last compaction entry and its firstKeptEntryId
  let lastCompactionIdx = -1;
  let lastKeptId: string | undefined;
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    if (branchEntries[i].type === "compaction") {
      lastCompactionIdx = i;
      lastKeptId = branchEntries[i].firstKeptEntryId;
      break;
    }
  }

  // Orphan recovery: triggers when lastKeptId is set to "" (sentinel from prior
  // compact-all) OR set to an id that no longer exists in the branch. In both cases,
  // start collecting from right after the last compaction entry.
  const hasPriorCompaction = lastCompactionIdx >= 0;
  const hasValidKeptId = !!lastKeptId && branchEntries.some((e: any) => e.id === lastKeptId);
  const orphanRecovery = hasPriorCompaction && !hasValidKeptId;

  // Collect live messages
  const liveMessages: EntryWithMessage[] = [];
  if (orphanRecovery) {
    for (let i = lastCompactionIdx + 1; i < branchEntries.length; i++) {
      const e = branchEntries[i];
      if (e.type === "compaction") continue;
      const m = toLiveMessage(e);
      if (m) liveMessages.push({ entry: e, message: m });
    }
  } else {
    let foundKept = !lastKeptId; // if no prior compaction, start collecting immediately
    for (const e of branchEntries) {
      if (!foundKept && e.id === lastKeptId) foundKept = true;
      if (!foundKept) continue;
      if (e.type === "compaction") continue;
      const m = toLiveMessage(e);
      if (m) liveMessages.push({ entry: e, message: m });
    }
  }
  return liveMessages;
};

export function buildOwnCut(branchEntries: any[], keepUserTurns = 1): OwnCutResult {
  const normalizedKeepUserTurns = normalizeKeepUserTurns(keepUserTurns);
  const liveMessages = collectLiveMessages(branchEntries);

  if (liveMessages.length === 0) return { ok: false, reason: "no_live_messages" };

  const userIndices = liveMessages.reduce<number[]>((acc, e, i) => {
    if (e.message.role === "user") acc.push(i);
    return acc;
  }, []);
  const compactAll = (keepFallbackToCompactAll: boolean) => ({
    ok: true as const,
    messages: liveMessages.map((e) => e.message),
    selectedIds: liveMessages.map((e) => e.entry.id),
    firstKeptEntryId: "",
    compactAll: true,
    keptUserTurns: 0,
    keepFallbackToCompactAll,
  });

  if (normalizedKeepUserTurns <= 0) return compactAll(false);

  // Summarize all messages before the requested kept user-turn tail.
  const targetUserIdx = userIndices.length - normalizedKeepUserTurns;
  const cutIdx = targetUserIdx >= 0 ? userIndices[targetUserIdx] : -1;

  if (cutIdx <= 0) {
    // Keep request cannot form a safe boundary (single user prompt, no user prompt,
    // or keep larger than available user turns), so compact EVERYTHING and keep no tail.
    // firstKeptEntryId="" is a sentinel: pi-core's buildSessionContext won't match it
    // (so 0 kept from pre-compaction), and next buildOwnCut triggers orphan recovery.
    return compactAll(true);
  }

  return {
    ok: true,
    messages: liveMessages.slice(0, cutIdx).map((e) => e.message),
    selectedIds: liveMessages.slice(0, cutIdx).map((e) => e.entry.id),
    firstKeptEntryId: liveMessages[cutIdx].entry.id,
    compactAll: false,
    keptUserTurns: userIndices.length - targetUserIdx,
    keepFallbackToCompactAll: false,
  };
}

// Token-budget tail cut: rescue default-path sessions when the user-turn
// anchored tail is absent (autonomous: no user boundary in the live window)
// or oversized (a single giant last user turn). Cuts at the nearest valid
// non-toolResult boundary, mirroring pi-core's findCutPoint.
export const findBudgetCutIndex = (
  live: EntryWithMessage[],
  maxTokens: number,
  charsPerToken?: number,
  backwardFallback = false,
): number => {
  let acc = 0;
  let crossed = -1;
  for (let i = live.length - 1; i >= 0; i--) {
    acc += estimateTokensFromChars(estimateSourceMessageChars(live[i].message), charsPerToken);
    if (acc >= maxTokens) {
      crossed = i;
      break;
    }
  }
  if (crossed < 0) return -1;
  // The crossing message exceeds the preferred target; start after it and
  // skip receipts to an existing protocol boundary. Fresh/current floors
  // are restored independently by the caller.
  for (let j = Math.max(crossed + 1, 1); j < live.length; j++) {
    if (live[j].message.role !== "toolResult") return j;
  }
  // Nothing after the crossing is a boundary (it falls inside the final tool
  // round). For an oversized user-anchored tail (Case B) fall back to the
  // nearest earlier non-receipt: the smallest protocol-safe suffix that reaches
  // the budget, instead of keeping the whole oversized tail.
  if (backwardFallback) for (let j = crossed; j >= 1; j--) {
    if (live[j].message.role !== "toolResult") return j;
  }
  return -1;
};

export const applyTailBudget = (
  branchEntries: any[],
  cut: OwnCutResult,
  opts: { maxTokens?: number; oversizedFactor?: number; charsPerToken?: number } = {},
): OwnCutResult => {
  if (!cut.ok) return cut;
  const maxTokens = opts.maxTokens ?? MAX_TAIL_TOKENS;
  const factor = opts.oversizedFactor ?? OVERSIZED_TAIL_FACTOR;
  const live = collectLiveMessages(branchEntries);

  const budgetResult = (idx: number, budgetCut: BudgetCutKind): OwnCutResult => ({
    ok: true,
    messages: live.slice(0, idx).map((m) => m.message),
    selectedIds: live.slice(0, idx).map((m) => m.entry.id),
    firstKeptEntryId: live[idx].entry.id,
    compactAll: false,
    keptUserTurns: live.slice(idx).filter((m) => m.message.role === "user").length,
    keepFallbackToCompactAll: false,
    budgetCut,
  });

  // Case A: no user anchor → compact-all. Re-cut to a token budget unless the
  // compact-all came from explicit keep:0 (which must be respected absolutely).
  if (cut.compactAll) {
    if (!cut.keepFallbackToCompactAll) return cut;
    const idx = findBudgetCutIndex(live, maxTokens, opts.charsPerToken);
    if (idx < 0) return cut;
    return budgetResult(idx, "no_anchor");
  }

  // Case B: oversized user-boundary tail. Only re-cut when the kept tail exceeds
  // maxTokens * factor (tolerance zone below is unchanged).
  const tailStart = cut.messages.length; // equals the cut index in the live window
  let tailTokens = 0;
  for (let i = tailStart; i < live.length; i++) {
    tailTokens += estimateTokensFromChars(estimateSourceMessageChars(live[i].message), opts.charsPerToken);
  }
  if (tailTokens <= maxTokens * factor) return cut;
  const idx = findBudgetCutIndex(live, maxTokens, opts.charsPerToken, true);
  if (idx <= tailStart) return cut;
  return budgetResult(idx, "oversized_tail");
};
