import { expect, test } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { IncidentRecorder } from '../src/diagnostics';

// Requires real NTFS ACLs and Windows PowerShell; the simulated-platform tests cannot verify this boundary.
test.skipIf(process.platform !== 'win32')('native Windows recorder rejects a directory readable by Everyone before writing content', { timeout: 30_000 }, async () => {
 const directory = mkdtempSync(join(tmpdir(), 'pi-incident-shared-'));
 try {
  await promisify(execFile)(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
   ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference = 'Stop'
$acl = Get-Acl -LiteralPath $env:PI_TUCK_SHARED_DIRECTORY
$sid = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::Read, [System.Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $env:PI_TUCK_SHARED_DIRECTORY -AclObject $acl
`], { env: { ...process.env, PI_TUCK_SHARED_DIRECTORY: directory }, timeout: 10_000, windowsHide: true });
  const notices: string[] = [], recorder = new IncidentRecorder({ directory });
  recorder.start(join(directory, 'project'), false, message => notices.push(message));
  await recorder.flush();
  expect(recorder.status().state).toBe('storage-failed-gap');
  expect(notices).toEqual(['Compaction recorder storage failed; incident has a gap']);
  expect(readdirSync(directory)).toEqual([]);
 } finally { rmSync(directory, { recursive: true, force: true }); }
});
