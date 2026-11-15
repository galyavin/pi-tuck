import { privateIncidentDirectory } from './incident-fixture';
import { expect, test, vi } from 'vitest';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { BAND, HOST, harness } from './budget-fixture';
import { IncidentRecorder } from '../src/diagnostics';
import { inspectIncident } from '../src/diagnostic-replay';
import { assertWindowsPrivateStorage } from '../src/windows-private-storage';

vi.mock('../src/windows-private-storage', async importOriginal => {
 const original = await importOriginal<typeof import('../src/windows-private-storage')>();
 return { ...original, assertWindowsPrivateStorage: vi.fn(), protectWindowsIncidentFile: vi.fn(), createPrivateDirectory: vi.fn(original.createPrivateDirectory) };
});

for (const how of ['operator cut', 'tool-boundary cut'] as const)
test(`the Windows writer persists ${how} proposals and their arithmetic after a delayed privacy check`, async () => {
 let releaseCheck!: () => void;
 const pendingCheck = new Promise<void>(resolve => { releaseCheck = resolve; });
 const acl = vi.mocked(assertWindowsPrivateStorage);
 acl.mockReset().mockResolvedValue().mockImplementationOnce(() => pendingCheck);
 const directory = await privateIncidentDirectory();
 vi.stubGlobal('process', new Proxy(process, { get: (target, key) => key === 'platform' ? 'win32' : Reflect.get(target, key) }));
 const start = vi.spyOn(IncidentRecorder.prototype, 'start');
 let h: Awaited<ReturnType<typeof harness>> | undefined;
 try {
  h = await harness({ at: how === 'operator cut' ? 'prompt' : 'tool', complete: how === 'operator cut' ? 60000 : BAND + 100, host: HOST, compaction: { diagnostics: { directory, maxContentCharacters: 1500000, maxQueueCharacters: 3000000, maxFileBytes: 10000000 } } });
  await h.session.prompt('/tuck-incident on');
  if (how === 'operator cut') await h.session.compact(); else await h.run();
  const recorder = start.mock.contexts[0] as IncidentRecorder;
  expect(recorder.status().queuedCharacters).toBeGreaterThan(0);
  releaseCheck();
  await recorder.flush();
  expect(acl).toHaveBeenCalledWith([directory]);
  expect(acl).toHaveBeenCalledWith([recorder.status().path!]);
  const records = readdirSync(directory).flatMap(name => readFileSync(join(directory, name), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
  expect(recorder.status().state, h.notices.join('\n')).toBe('recording');
  expect(records.map(r => r.kind)).toContain('proposal');
  const proposal = records.find(r => r.kind === 'proposal');
  expect(proposal.data.details.diagnosticReceipt.settings).toMatchObject({ hostInputTokens: HOST, target: 'band', triggerMarginTokens: 2880, responseReserveTokens: 128000, calibrationFactor: 1 });
  if (how === 'operator cut') {
   const replay = inspectIncident(records.map(r => r.kind === 'replay-input' ? { ...r, partial: false } : r));
   expect(replay.results).toMatchObject([{ mode: 'deterministic-selection-replay', matchesRecordedProposal: true }]);
  }
 } finally {
  releaseCheck();
  const recorder = start.mock.contexts[0] as IncidentRecorder | undefined;
  recorder?.stop('test-complete');
  await recorder?.flush();
  start.mockRestore();
  vi.unstubAllGlobals();
  await h?.cleanup();
  rmSync(directory, { recursive: true, force: true });
 }
});
