import { test, expect } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BAND, HOST, harness } from './budget-fixture';
import { inspectIncident } from '../src/diagnostic-replay';
import type { IncidentRecord } from '../src/diagnostics';

// The offline replay of a recorded cut counts the draft with the same function as the live planner, so it reproduces the live summary.
// A cut also records the arithmetic it was made with: the target, the margin and the mandatory input.
async function recorded(directory: string, wait: () => boolean) {
	for (let i = 0; i < 200 && !wait(); i++) await new Promise(resolve => setTimeout(resolve, 10));
	const files = readdirSync(directory).filter(name => name.endsWith('.jsonl'));
	return files.flatMap(name => readFileSync(join(directory, name), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as IncidentRecord));
}
const BOUNDS = { maxContentCharacters: 1500000, maxQueueCharacters: 3000000, maxFileBytes: 10000000 };
const hasProposal = (directory: string) => () => readdirSync(directory).some(name => name.endsWith('.jsonl') && readFileSync(join(directory, name), 'utf8').includes('"kind":"proposal"'));

test('an offline replay of a recorded operator cut reproduces the live summary', async () => {
	const directory = mkdtempSync(join(tmpdir(), 'pi-incident-'));
	const h = await harness({ at: 'prompt', complete: 60000, host: HOST, compaction: { diagnostics: { directory, ...BOUNDS } } });
	try {
		await h.session.prompt('/tuck-incident on');
		await h.session.compact();
		expect(h.compactions()).toHaveLength(1);
		const records = await recorded(directory, hasProposal(directory));
		expect(records.map(r => r.kind)).toContain('proposal');
		// Pi's own bookkeeping entries (model and thinking-level changes) are not permitted in a record, so a live record is marked partial and
		// makes no determinism claim. They take no part in a cut; the claim is checked here by lifting that mark on an otherwise complete record.
		const replay = inspectIncident(records.map(r => r.kind === 'replay-input' ? { ...r, partial: false } : r));
		expect(replay.results).toHaveLength(1);
		const result = replay.results[0] as { mode: string; matchesRecordedProposal: boolean | null };
		expect(result.mode).toBe('deterministic-selection-replay');
		expect(result.matchesRecordedProposal).toBe(true);
	} finally { await h.cleanup(); rmSync(directory, { recursive: true, force: true }); }
});

for (const how of ['operator cut', 'tool-boundary cut'] as const)
test(`a recorded ${how} shows the arithmetic it was made with`, async () => {
	const directory = mkdtempSync(join(tmpdir(), 'pi-incident-'));
	const h = await harness(how === 'operator cut' ? { at: 'prompt', complete: 60000, host: HOST, compaction: { diagnostics: { directory, ...BOUNDS } } }
		: { at: 'tool', complete: BAND + 100, host: HOST, compaction: { diagnostics: { directory, ...BOUNDS } } });
	try {
		await h.session.prompt('/tuck-incident on');
		if (how === 'operator cut') await h.session.compact(); else await h.run();
		expect(h.compactions()).toHaveLength(1);
		const records = await recorded(directory, hasProposal(directory));
		const proposal = records.find(r => r.kind === 'proposal')!.data as { details: { diagnosticReceipt: { settings: Record<string, unknown> } } };
		const settings = proposal.details.diagnosticReceipt.settings;
		expect(settings).toMatchObject({ hostInputTokens: HOST, target: 'room', triggerMarginTokens: 2880, responseReserveTokens: 128000, calibrationFactor: 1 });
		expect(settings.mandatoryInputTokens).toBeGreaterThan(HOST);
		expect(settings).not.toHaveProperty('projectedHostInputTokens');
		expect(settings).not.toHaveProperty('incomingPromptEstimateTokens');
	} finally { await h.cleanup(); rmSync(directory, { recursive: true, force: true }); }
});
