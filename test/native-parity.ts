import { convertToLlm, SettingsManager, shouldCompact, type ExtensionContext, type SessionEntry } from '@earendil-works/pi-coding-agent';
import { normalizeContext, type Api, type Model, type Message, type UserMessage } from '@earendil-works/pi-ai';
import { clampMaxTokensToContext } from '@earendil-works/pi-ai/api/simple-options';
import { isContextOverflow } from '@earendil-works/pi-ai/utils/overflow';

export type BudgetObservation = { rawTokens: number; tokens: number; factor: number; response: number; room: number; hardLine?: number; context: ExtensionContext };
export type NativeState = {
 rawTokens: number; correctedTokens: number; factor: number; window: number; room: number; hardLine?: number;
 expectedHardLine?: number;
 oracleClamp?: number; oracleFloor?: number;
 overflowRecovery?: boolean;
 nativeSettings: ReturnType<SettingsManager['getCompactionSettings']>; nativePoint: number | null; nativeAction: 'send' | 'compact-then-send';
 afterFailedReply: boolean; branchEntries: number; branchMessages: number; leafId: string | null;
};

/** Locate the installed Pi predicate's boundary. No copied reserve arithmetic or compaction policy. */
export function nativeCompactionPoint(window: number, settings: ReturnType<SettingsManager['getCompactionSettings']>): number | null {
 if (typeof shouldCompact !== 'function' || typeof SettingsManager.prototype.getCompactionSettings !== 'function')
  throw new Error('Cannot load native Pi compaction code');
 let low = -window - settings.reserveTokens - 1, high = window + 1;
 if (!Number.isSafeInteger(low) || !Number.isSafeInteger(high)) throw new Error('Native compaction search bounds are not safe integers');
 if (!shouldCompact(high, window, settings)) return null;
 if (shouldCompact(low, window, settings)) throw new Error('Native compaction predicate is outside the search bounds');
 while (high - low > 1) {
  const middle = low + Math.floor((high - low) / 2);
  if (shouldCompact(middle, window, settings)) high = middle; else low = middle;
 }
 return low;
}

/** A reply that did not fit, after which the reply needs the whole reserve: a length stop that wrote text or a tool call, or a context overflow.
 * A thinking-only length stop is not one (1.0.25): the session retries it with the largest reply as its floor, so a later refusal is judged
 * by the clamp oracle, not exempted here. Written from the branch alone, not from pi-tuck's helper. */
export function failedReply(branch: readonly SessionEntry[]): boolean {
 return branch.some(e => {
  if (e.type !== 'message' || e.message.role !== 'assistant') return false;
  const m = e.message;
  const thinkingOnly = m.content.length > 0 && m.content.every(block => block.type === 'thinking');
  return m.stopReason === 'length' && !thinkingOnly || m.stopReason === 'error' && isContextOverflow(m as never);
 });
}

export function nativeState(measure: BudgetObservation, settings: SettingsManager): NativeState {
 const { context: ctx } = measure, model = ctx.model;
 if (!model) throw new Error('Native parity requires a model');
 const resolved = settings.getCompactionSettings(model), branch = ctx.sessionManager.getBranch();
 return {
  rawTokens: measure.rawTokens, correctedTokens: measure.tokens, factor: measure.factor, window: model.contextWindow,
  room: measure.room, hardLine: measure.hardLine, nativeSettings: resolved, nativePoint: nativeCompactionPoint(model.contextWindow, resolved),
  nativeAction: shouldCompact(measure.tokens, model.contextWindow, resolved) ? 'compact-then-send' : 'send',
  afterFailedReply: failedReply(branch), branchEntries: branch.length, branchMessages: branch.filter(e => e.type === 'message').length,
  leafId: ctx.sessionManager.getLeafId(),
 };
}

/** Pi's own cap on the smallest answering request, independent of pi-tuck's refusal text and budget.
 * The summary carries the prompt once (as `smallest` does), plus 200 tokens of headings. It predates fresh
 * replies: stamping it after them would invalidate Pi's usage anchor and silently change the question.
 * Fresh assistant objects, including usage and timestamps, are passed through unchanged.
 */
export function nativeReplyClamp(model: Model<Api>, system: Message[], prompt: UserMessage, fresh: Message[]): number {
 const text = typeof prompt.content === 'string' ? prompt.content : prompt.content.map(b => b.type === 'text' ? b.text : '').join('\n');
 const heading = '## Current task\n';
 const summary = { role: 'compactionSummary' as const, summary: heading.padEnd(800, ' ') + text, tokensBefore: 0, timestamp: 0 };
 const messages = [...system, ...convertToLlm([summary]), ...fresh.map(message => message.role === 'toolResult'
  ? { ...message, content: [{ type: 'text' as const, text: message.content.map(block => block.type === 'text' ? block.text : '').join('\n').slice(0, 800).padEnd(800, ' ') }] }
  : message)];
 return clampMaxTokensToContext(model, normalizeContext({ messages }), model.maxTokens);
}

export function refusalParity(state: NativeState): { violation: boolean; exception?: 'past-window' | 'failed-reply' | 'reply-floor' } {
 if (state.correctedTokens > state.window) return { violation: false, exception: 'past-window' };
 if (state.afterFailedReply) return { violation: false, exception: 'failed-reply' };
 if ((state.expectedHardLine !== undefined && state.correctedTokens > state.expectedHardLine) ||
  (state.oracleClamp !== undefined && state.oracleFloor !== undefined && state.oracleClamp < state.oracleFloor))
  return { violation: false, exception: 'reply-floor' };
 return { violation: true };
}

/** Requests in the newly admitted room-to-hard-line interval; other parity findings remain visible. */
export function floorCase(state: NativeState): boolean {
 const hardLine = state.expectedHardLine ?? state.hardLine;
 return !state.afterFailedReply && hardLine !== undefined && state.correctedTokens < hardLine &&
  (state.nativePoint === null || state.correctedTokens >= state.nativePoint);
}

export function forcedPointParity(state: NativeState, forcedPoint: number): boolean {
 return !state.afterFailedReply && (state.nativePoint === null || forcedPoint < state.nativePoint);
}

/** The owner's one narrow useful-cut exemption. The amounts are in the room's corrected units. */
export function exemptUsefulCut(forced: boolean, setupAndPrompt: number, room: number): boolean {
 return forced && setupAndPrompt > room;
}

/** Read-only probe backport for an archived 1.0.21: observes its own private correction, without replacing its policy. */
export function observeLegacyBudget(source: string): string {
 if (source.includes('options.observeBudget(')) return source;
 const marker = 'const corrected = (tokens: number, ctx: ExtensionContext) => { identityFor(ctx); return Math.ceil(tokens * factor); };';
 if (source.split(marker).length !== 2) throw new Error('Cannot attach the read-only budget probe to this baseline');
 let instrumented = source.replace(marker, marker + `
    const observeBudget = (rawTokens: number, ctx: ExtensionContext) => {
        if ((options as any).observeBudget) (options as any).observeBudget({ rawTokens, tokens: corrected(rawTokens, ctx), factor, ...limits(ctx), context: ctx });
    };`);
 const sites = [
  ['            const before = plannerMeasureFor(ctx)(saved);', '            observeBudget(before + mandatory, ctx);'],
  ['        const incoming = incomingPart + system, mandatory = incoming + host;', '        observeBudget(before + mandatory, ctx);'],
  ['        const before = measure(saved);\n        if (decision.kind === "fault"', 'boundary'],
  ['            const tokens = system + conversationTokens(messages);', '            observeBudget(tokens, ctx);'],
 ];
 for (const [needle, observation] of sites) {
  if (instrumented.split(needle!).length !== 2) throw new Error('Cannot identify every native-parity decision in this baseline');
  instrumented = observation === 'boundary'
   ? instrumented.replace(needle!, '        const before = measure(saved);\n        observeBudget(before + mandatory, ctx);\n        if (decision.kind === "fault"')
   : instrumented.replace(needle!, needle + '\n' + observation);
 }
 return instrumented;
}
