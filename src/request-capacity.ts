import { isContextOverflow } from '@earendil-works/pi-ai';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import type { Messages } from './budget.js';
import { parseRecords, splitSummary } from './tuck/core/transcript.js';

/** Read the whole current branch, including replies before cuts. No session-local fallback flag. */
export function branchReplyFloor(branch: readonly SessionEntry[], reserve: number): number {
    let largest = 4_096;
    for (const entry of branch) {
        if (entry.type !== 'message' || entry.message.role !== 'assistant') continue;
        const message = entry.message;
        if (message.stopReason === 'length' || message.stopReason === 'error' && isContextOverflow(message)) return reserve;
        const output = message.usage?.output;
        if (typeof output === 'number' && Number.isFinite(output) && output > largest) largest = output;
    }
    return Math.min(reserve, Math.ceil(largest));
}

/** Check decoded text, including a whole verbatim user quote in our summary; never JSON-escaped substring matching. */
export function carriesPrompt(messages: Messages, prompt: string): boolean {
    if (!prompt.length) return true;
    return messages.some(message => {
        if (message.role === 'user') {
            const text = typeof message.content === 'string' ? message.content : message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n');
            return text.includes(prompt);
        }
        if (message.role !== 'compactionSummary') return false;
        const split = splitSummary(message.summary);
        return split !== null && split !== undefined && parseRecords(split.body, split.version).some(record =>
            record.kind === 'excerpt' && record.role === 'user' && record.text.includes(prompt));
    });
}
