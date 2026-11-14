import { privateIncidentDirectory } from './incident-fixture';
import { test, expect, vi } from 'vitest';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { BAND, HOST, harness } from './budget-fixture';
import { inspectIncident } from '../src/diagnostic-replay';
import { IncidentRecorder, type IncidentRecord } from '../src/diagnostics';

// The offline replay of a recorded cut counts the draft with the same function as the live planner, so it reproduces the live summary.
// A cut also records the arithmetic it was made with: the target, the margin and the mandatory input.
async function recorded(directory: string, recorder: IncidentRecorder) {
	const watchdog = setTimeout(() => process.stderr.write('Incident flush still pending: ' + JSON.stringify({ recorder: recorder.status(), files: readdirSync(directory) }) + '\n'), 10_000);
	watchdog.unref();
	try { await recorder.flush(); } finally { clearTimeout(watchdog); }
	const files = readdirSync(directory).filter(name => name.endsWith('.jsonl'));
	const records = files.flatMap(name => readFileSync(join(directory, name), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as IncidentRecord));
	expect(records.map(record => record.kind), JSON.stringify({ recorder: recorder.status(), files })).toContain('proposal');
	return records;
}
// Windows starts native ACL checkers before the first write; retain the POSIX test timeout.
const RECORDING_TIMEOUT = process.platform === 'win32' ? 30_000 : 5_000;
const BOUNDS = { maxContentCharacters: 1500000, maxQueueCharacters: 3000000, maxFileBytes: 10000000 };

test('an offline replay of a recorded operator cut reproduces the live summary', async () => {
	const directory = await privateIncidentDirectory();
	const start = vi.spyOn(IncidentRecorder.prototype, 'start');
	let h: Awaited<ReturnType<typeof harness>> | undefined;
	try {
		h = await harness({ at: 'prompt', complete: 60000, host: HOST, compaction: { diagnostics: { directory, ...BOUNDS } } });
		await h.session.prompt('/tuck-incident on');
		await h.session.compact();
		expect(h.compactions()).toHaveLength(1);
		const records = await recorded(directory, start.mock.contexts[0] as IncidentRecorder);
		expect(records.map(r => r.kind)).toContain('proposal');
		// Pi's own bookkeeping entries (model and thinking-level changes) are not permitted in a record, so a live record is marked partial and
		// makes no determinism claim. They take no part in a cut; the claim is checked here by lifting that mark on an otherwise complete record.
		const replay = inspectIncident(records.map(r => r.kind === 'replay-input' ? { ...r, partial: false } : r));
		expect(replay.results).toHaveLength(1);
		const result = replay.results[0] as { mode: string; matchesRecordedProposal: boolean | null };
		expect(result.mode).toBe('deterministic-selection-replay');
		expect(result.matchesRecordedProposal).toBe(true);
	} finally {
		const recorder = start.mock.contexts[0] as IncidentRecorder | undefined;
		recorder?.stop('test-complete'); await recorder?.flush(); start.mockRestore();
		await h?.cleanup(); rmSync(directory, { recursive: true, force: true });
	}
}, RECORDING_TIMEOUT);
for (const how of ['operator cut', 'tool-boundary cut'] as const)
test(`a recorded ${how} shows the arithmetic it was made with`, async () => {
	const directory = await privateIncidentDirectory();
	const start = vi.spyOn(IncidentRecorder.prototype, 'start');
	let h: Awaited<ReturnType<typeof harness>> | undefined;
	try {
		h = await harness(how === 'operator cut' ? { at: 'prompt', complete: 60000, host: HOST, compaction: { diagnostics: { directory, ...BOUNDS } } }
			: { at: 'tool', complete: BAND + 100, host: HOST, compaction: { diagnostics: { directory, ...BOUNDS } } });
		await h.session.prompt('/tuck-incident on');
		if (how === 'operator cut') await h.session.compact(); else await h.run();
		expect(h.compactions()).toHaveLength(1);
		const records = await recorded(directory, start.mock.contexts[0] as IncidentRecorder);
		const proposal = records.find(r => r.kind === 'proposal')!.data as { details: { diagnosticReceipt: { settings: Record<string, unknown> } } };
		const settings = proposal.details.diagnosticReceipt.settings;
		expect(settings).toMatchObject({ hostInputTokens: HOST, target: 'band', triggerMarginTokens: 2880, responseReserveTokens: 128000, calibrationFactor: 1 });
		expect(settings.mandatoryInputTokens).toBeGreaterThan(HOST);
		expect(settings).not.toHaveProperty('projectedHostInputTokens');
		expect(settings).not.toHaveProperty('incomingPromptEstimateTokens');
	} finally {
		const recorder = start.mock.contexts[0] as IncidentRecorder | undefined;
		recorder?.stop('test-complete'); await recorder?.flush(); start.mockRestore();
		await h?.cleanup(); rmSync(directory, { recursive: true, force: true });
	}
}, RECORDING_TIMEOUT);
