import { afterEach, expect, test, vi } from 'vitest';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { IncidentRecorder } from '../src/diagnostics';
import { removedRuntimeStatus } from '../src/removed-runtime';

afterEach(() => vi.unstubAllEnvs());

test('Pi supplies the agent folder from homedir and joined components', async () => {
  vi.stubEnv('PI_CODING_AGENT_DIR', '');
  expect(getAgentDir()).toBe(join(homedir(), '.pi', 'agent'));
  expect(new IncidentRecorder().directory).toBe(resolve(join(homedir(), '.local', 'state', 'pi-tuck-incidents')));
});

test('the old runtime root is joined under the configured agent folder, even when absent', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-folders-'));
  vi.stubEnv('PI_CODING_AGENT_DIR', directory);
  try {
    expect(getAgentDir()).toBe(directory);
    expect(await removedRuntimeStatus()).toBe(`Semantic search was removed from pi-tuck. No runtime folder exists at ${join(directory, 'pi-tuck')}.`);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
