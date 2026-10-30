import { normalize } from '../src/tuck/core/normalize';
import { filterNoise } from '../src/tuck/core/filter-noise';
import type { BriefRankingOptions } from '../src/tuck/core/rank';
import type { CompilerMessage } from '../src/tuck/types';
import type { SourceTime } from '../src/tuck/core/source-time';

// Random sessions with the features that make a block's rendered size depend on its neighbours: identical calls that merge, calls hidden by
// a selected receipt, source times, notices, unlocated blocks, and a mandatory base. `options` draws the budgets a caller can set.
export const generator = (seed: number) => {
	let state = seed * 2654435761 % 2 ** 32 || 1;
	const random = () => (state = (state * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32;
	const int = (n: number) => Math.floor(random() * n);
	const pick = <T>(items: readonly T[]): T => items[int(items.length)]!;
	return { random, int, pick };
};

const VOCABULARY = 'parser cache index token budget summary recall branch module schema router worker queue retry timeout config build test lint'.split(' ');

export function session(seed: number) {
	const { random, int, pick } = generator(seed);
	const text = (min: number, max: number) => {
		const words = Array.from({ length: min + int(max - min + 1) }, () => pick(VOCABULARY));
		const out: string[] = [];
		for (const [i, word] of words.entries()) out.push(word + (i % 11 === 10 ? '.' : '') + (i % 37 === 36 ? '\n\n' : ''));
		return random() < 0.1 ? '```ts\n' + out.join(' ') + '\n```' : out.join(' ');
	};
	const messages: CompilerMessage[] = [];
	const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: 'toolCall', id, name, arguments: args });
	const open: { id: string; name: string }[] = [];
	let calls = 0;
	const rounds = 8 + int(70);
	for (let r = 0; r < rounds; r++) {
		const kind = random();
		if (kind < 0.22) {
			const content = random() < 0.08 ? '' : random() < 0.1 ? [{ type: 'text', text: text(1, 30) }, { type: 'image', mimeType: 'image/png', data: '' }] : text(1, 300);
			messages.push({ role: 'user', content, timestamp: r } as never);
		} else if (kind < 0.27) {
			messages.push({ role: 'custom', customType: 'note', content: text(3, 60), display: true, timestamp: r } as never);
		} else if (kind < 0.37) {
			messages.push({ role: 'bashExecution', command: random() < 0.3 ? `cat <<EOF\n${text(2, 10)}\nEOF\nnpm test` : `npm test -- ${pick(VOCABULARY)}`,
				output: text(0, random() < 0.2 ? 1500 : 40), exitCode: random() < 0.3 ? 1 : 0, cancelled: false, truncated: false, timestamp: r } as never);
		} else if (kind < 0.85) {
			const parts: unknown[] = [];
			if (random() < 0.6) parts.push({ type: 'text', text: text(1, random() < 0.3 ? 400 : 60) });
			for (let c = int(4); c > 0; c--) {
				const id = random() < 0.1 ? `c${calls}` : `c${++calls}`;
				const name = pick(['read', 'bash', 'edit', 'write', 'grep', 'read']);
				const args = random() < 0.08 ? { path: 'big', text: text(200, 400) } : random() < 0.05 ? { path: 'x', missing: undefined } : { path: `src/${pick(VOCABULARY)}.ts` };
				parts.push(call(id, name, args));
				if (random() < 0.15) parts.push(call(id, name, args));
				open.push({ id, name });
			}
			messages.push({ role: 'assistant', content: parts, stopReason: 'toolUse', timestamp: r } as never);
		} else {
			for (let c = Math.min(open.length, 1 + int(3)); c > 0; c--) {
				const target = open.splice(int(open.length), 1)[0]!;
				const size = random() < 0.1 ? 9000 : random() < 0.1 ? 0 : random() < 0.5 ? 80 : 1500;
				messages.push({ role: 'toolResult', toolCallId: target.id, toolName: random() < 0.05 ? 'other' : target.name,
					content: [{ type: 'text', text: size ? text(size / 8, size / 6) : '' }], isError: random() < 0.15, timestamp: r } as never);
				if (random() < 0.05) messages.push(messages.at(-1)!);
			}
		}
	}
	const withSources = random() < 0.9;
	const sourceIndices = messages.map((_, i) => withSources && random() < 0.93 ? i : withSources ? undefined : i);
	const withTimes = random() < 0.7;
	const times: SourceTime[] = messages.map((_, i) => random() < 0.1 ? { basis: 'unknown' } : { basis: random() < 0.5 ? 'message' : 'journal', utc: new Date(1_700_000_000_000 + i * 1000).toISOString().replace('.000Z', 'Z') });
	const blocks = filterNoise(normalize(messages, sourceIndices, undefined, messages.map((_, i) => `entry-${i}`), withTimes ? times : undefined));
	const mandatory = new Set(sourceIndices.filter((index): index is number => index !== undefined && random() < 0.08));
	const options = (): BriefRankingOptions => {
		const allowance = pick([200, 800, 2500, 6000, 15000, 40000]);
		return {
			...(random() < 0.9 ? { maxBriefChars: allowance } : {}),
			...(random() < 0.15 ? { maxBriefCharsCeiling: allowance * 3, briefCharsPerBlock: 60 + int(200) } : {}),
			...(random() < 0.3 ? { maxBriefUnits: pick([10, 30, 120, 400]) } : {}),
			...(random() < 0.25 ? { maxBlocks: pick([4, 12, 40]) } : {}),
			...(random() < 0.3 ? { preserveRecentBlocks: pick([0, 3, 8, 30]) } : {}),
			...(random() < 0.6 ? { mandatorySourceIndices: mandatory } : {}),
			...(random() < 0.5 ? { fileOps: { modifiedFiles: [`src/${pick(VOCABULARY)}.ts`], readFiles: [`src/${pick(VOCABULARY)}.ts`] } } : {}),
		};
	};
	return { blocks, options, mandatory };
}

