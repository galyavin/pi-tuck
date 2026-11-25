import { normalizeContext } from '@earendil-works/pi-ai';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import type { AgentMessage, Messages } from './budget.js';
import { parseRecords, splitSummary } from './tuck/core/transcript.js';

type SimpleOptions = typeof import('@earendil-works/pi-ai/api/simple-options');
type Estimate = typeof import('@earendil-works/pi-ai/utils/estimate');
export type PiRequestMath = { clampMaxTokensToContext: SimpleOptions['clampMaxTokensToContext']; estimateContextTokens: Estimate['estimateContextTokens'] };

/** Pi's own request arithmetic: its reply clamp and the estimator behind it, as the running Pi has them.
 * An installed extension cannot import these subpaths by name: Pi's extension loader aliases only pi-ai's root, compat, models, oauth and
 * providers/all, and an installed package has no node_modules of its own. So resolve them first by name (tests, the eval harness, a dev
 * checkout), then from the running Pi's own install, beside its executable. If neither works (an SDK host), there is none, and callers
 * keep their fallbacks. */
export async function loadPiRequestMath(): Promise<PiRequestMath | undefined> {
    try {
        const [simple, estimate] = await Promise.all([import('@earendil-works/pi-ai/api/simple-options'), import('@earendil-works/pi-ai/utils/estimate')]);
        return { clampMaxTokensToContext: simple.clampMaxTokensToContext, estimateContextTokens: estimate.estimateContextTokens };
    } catch { /* not resolvable by name: an installed extension */ }
    try {
        // pi-ai's exports map these subpaths for `import` only (./api/* -> ./dist/api/*.js), so find the package beside Pi's executable and
        // import the files that map names.
        const [{ existsSync, realpathSync }, { dirname, join }, { pathToFileURL }] = await Promise.all([import('node:fs'), import('node:path'), import('node:url')]);
        const entry = process.argv[1];
        if (!entry) return undefined;
        let dir = dirname(realpathSync(entry)), root: string | undefined;
        for (let up = 0; up < 12 && !root; up++, dir = dirname(dir)) {
            const candidate = join(dir, 'node_modules', '@earendil-works', 'pi-ai');
            if (existsSync(join(candidate, 'dist', 'api', 'simple-options.js'))) root = candidate;
            if (dirname(dir) === dir) break;
        }
        if (!root) return undefined;
        const [simple, estimate] = await Promise.all([
            import(pathToFileURL(join(root, 'dist', 'api', 'simple-options.js')).href) as Promise<SimpleOptions>,
            import(pathToFileURL(join(root, 'dist', 'utils', 'estimate.js')).href) as Promise<Estimate>]);
        if (typeof simple.clampMaxTokensToContext !== 'function' || typeof estimate.estimateContextTokens !== 'function') return undefined;
        return { clampMaxTokensToContext: simple.clampMaxTokensToContext, estimateContextTokens: estimate.estimateContextTokens };
    } catch { return undefined; }
}

/** Read Pi's private safety allowance through its public clamp, rather than copying it.
 * Without Pi's request arithmetic, fall back to Pi 1.2–1.5's documented 4,096-token allowance.
 */
export async function piContextSafetyMargin(math?: PiRequestMath): Promise<number> {
    try {
        const { clampMaxTokensToContext, estimateContextTokens } = math ?? await loadPiRequestMath() ?? (() => { throw new Error('No Pi request math'); })();
        const window = 1_000_000, context = normalizeContext({ messages: [] });
        const margin = window - estimateContextTokens(context).tokens - clampMaxTokensToContext({ contextWindow: window, maxTokens: window } as never, context, window);
        if (!Number.isSafeInteger(margin) || margin < 0 || margin >= window) throw new Error('Invalid Pi context margin');
        return margin;
    } catch { return 4_096; }
}

/** A length stop with visible reasoning but no visible answer or work. */
export const thinkingOnlyLength = (message: AgentMessage): boolean => message.role === 'assistant' && message.stopReason === 'length' &&
    message.content.length > 0 && message.content.every(block => block.type === 'thinking');

type ReplyModel = { provider: string; api: string; id: string; maxTokens: number };

/** A soft reserve guides compaction. Beyond it, use observed reply demand from this model.
 * One token is the smallest positive allocation when there is no comparable evidence. */
export function requestReplyFloor(branch: readonly SessionEntry[], reserve: number, model: ReplyModel): number {
    let largest = 1, thinkingStop = false;
    for (const entry of branch) {
        if (entry.type !== 'message' || entry.message.role !== 'assistant') continue;
        const message = entry.message;
        if (message.model !== model.id || message.provider !== model.provider || message.api !== model.api ||
            message.stopReason === 'error' || message.stopReason === 'aborted') continue;
        const output = message.usage?.output;
        if (typeof output !== 'number' || !Number.isFinite(output) || output <= 0) continue;
        largest = Math.max(largest, Math.ceil(output));
        thinkingStop ||= thinkingOnlyLength(message);
    }
    const observed = thinkingStop ? largest : Math.min(Math.max(1, reserve), largest);
    return model.maxTokens > 0 ? Math.min(observed, model.maxTokens) : observed;
}

/** Check decoded starting text, native or quoted whole with its original role; never JSON-escaped substring matching. */
export function carriesPrompt(messages: Messages, prompt: string, role: 'user' | 'custom' = 'user'): boolean {
    if (!prompt.length) return true;
    return messages.some(message => {
        if (message.role === role) {
            const text = typeof message.content === 'string' ? message.content : message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
            return text.includes(prompt);
        }
        if (message.role !== 'compactionSummary') return false;
        const split = splitSummary(message.summary);
        return split !== undefined && parseRecords(split.body, split.version).some(record =>
            record.kind === 'excerpt' && record.role === role && record.text.includes(prompt));
    });
}
