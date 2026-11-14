import { afterEach, expect, test, vi } from 'vitest';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { IncidentRecorder } from '../src/diagnostics';

afterEach(() => vi.unstubAllEnvs());

test('Pi supplies the agent folder from homedir and joined components', async () => {
  vi.stubEnv('PI_CODING_AGENT_DIR', '');
  expect(getAgentDir()).toBe(join(homedir(), '.pi', 'agent'));
  expect(new IncidentRecorder().directory).toBe(resolve(join(homedir(), '.local', 'state', 'pi-tuck-incidents')));
});

test('Pi uses the configured agent folder', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pi-folders-'));
  vi.stubEnv('PI_CODING_AGENT_DIR', directory);
  try {
    expect(getAgentDir()).toBe(directory);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
