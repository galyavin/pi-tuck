import { SettingsManager, shouldCompact, type ExtensionContext, type SessionEntry } from '@earendil-works/pi-coding-agent';
import { isContextOverflow } from '@earendil-works/pi-ai/utils/overflow';

export type BudgetObservation = { rawTokens: number; tokens: number; factor: number; response: number; room: number; hardLine?: number; context: ExtensionContext };
export type NativeState = {
 rawTokens: number; correctedTokens: number; factor: number; window: number; room: number; hardLine?: number;
 expectedHardLine?: number;
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

export function failedReply(branch: readonly SessionEntry[]): boolean {
 return branch.some(e => e.type === 'message' && e.message.role === 'assistant' &&
  (e.message.stopReason === 'length' || e.message.stopReason === 'error' && isContextOverflow(e.message as never)));
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

export function refusalParity(state: NativeState, reason: string): { violation: boolean; exception?: 'past-window' | 'failed-reply' | 'prompt-check' } {
 if (state.correctedTokens > state.window) return { violation: false, exception: 'past-window' };
 if (state.afterFailedReply) return { violation: false, exception: 'failed-reply' };
 if (reason.includes('Prompt check failed')) return { violation: false, exception: 'prompt-check' };
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
