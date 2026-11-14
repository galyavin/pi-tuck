import { privateIncidentDirectory } from './incident-fixture';
import { expect, test } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { IncidentRecorder } from '../src/diagnostics';
import { assertWindowsPrivateStorage, createPrivateDirectory, protectWindowsIncidentFile } from '../src/windows-private-storage';

test.skipIf(process.platform !== 'win32')('native Windows privacy checks accept private storage and an open incident file before recording a proposal', { timeout: 30_000 }, async () => {
 const directory = await privateIncidentDirectory('pi-incident-private-');
 const recorder = new IncidentRecorder({ directory });
 try {
  // Direct checks expose the native command error instead of the recorder's intentionally generic storage-gap notification.
  await assertWindowsPrivateStorage([directory]);
  const probe = join(directory, 'private-storage-probe');
  const file = await open(probe, 'wx', 0o600);
  try { await protectWindowsIncidentFile(probe); await assertWindowsPrivateStorage([probe]); } finally { await file.close(); rmSync(probe); }
  recorder.start(join(directory, 'project'), false, () => {});
  recorder.capture('proposal', 'test', { summary: 'native Windows proposal' });
  await recorder.flush();
  expect(recorder.status().state).toBe('recording');
  expect(readFileSync(recorder.status().path!, 'utf8').trim().split('\n').map(line => JSON.parse(line).kind)).toEqual(['start', 'proposal']);
 } finally {
  recorder.stop('test-complete'); await recorder.flush();
  rmSync(directory, { recursive: true, force: true });
 }
});

test.skipIf(process.platform !== 'win32')('native Windows recording creates protected directories and files beneath a shared parent without changing its ACL', { timeout: 30_000 }, async () => {
 const parent = await privateIncidentDirectory('pi-incident-inheritance-');
 const directory = join(parent, 'new-parent', 'incidents');
 const recorder = new IncidentRecorder({ directory });
 const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
 const native = (script: string, paths: string[]) => promisify(execFile)(powershell,
  ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference = 'Stop'\n" + script],
  { env: { ...process.env, PI_TUCK_NATIVE_PATHS: JSON.stringify(paths) }, timeout: 10_000, windowsHide: true });
 try {
  const { stdout: sharedAcl } = await native(`
$path = @(ConvertFrom-Json -InputObject $env:PI_TUCK_NATIVE_PATHS)[0]
$acl = Get-Acl -LiteralPath $path
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'), [System.Security.AccessControl.FileSystemRights]::Modify, [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit', [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $path -AclObject $acl
(Get-Acl -LiteralPath $path).GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access)
`, [parent]);
  // The helper must never repair an existing operator directory, even when it is shared.
  await createPrivateDirectory(parent);
  await expect(assertWindowsPrivateStorage([parent])).rejects.toThrow();
  recorder.start(join(parent, 'project'), false, () => {});
  recorder.capture('proposal', 'test', { summary: 'protected from parent inheritance' });
  await recorder.flush();
  expect(recorder.status().state).toBe('recording');
  expect(readFileSync(recorder.status().path!, 'utf8')).toContain('"kind":"proposal"');
  const { stdout: unchangedAcl } = await native(`
$paths = ConvertFrom-Json -InputObject $env:PI_TUCK_NATIVE_PATHS
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$trusted = @($user, 'S-1-5-18', 'S-1-5-32-544') | Sort-Object
foreach ($path in $paths[1..($paths.Length - 1)]) {
 $acl = Get-Acl -LiteralPath $path
 if (-not $acl.AreAccessRulesProtected) { throw 'Inherited DACL' }
 $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
 if ($rules.Count -ne 3) { throw 'Unexpected DACL entries' }
 if (@(Compare-Object $trusted @($rules | ForEach-Object { $_.IdentityReference.Value } | Sort-Object)).Count) { throw 'Unexpected DACL identities' }
 foreach ($rule in $rules) {
  if ($rule.IsInherited -or $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or $rule.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl) { throw 'Unexpected DACL rights' }
 }
}
(Get-Acl -LiteralPath $paths[0]).GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access)
`, [parent, join(parent, 'new-parent'), directory, recorder.status().path!]);
  expect(unchangedAcl).toBe(sharedAcl);
 } finally {
  recorder.stop('test-complete'); await recorder.flush();
  rmSync(parent, { recursive: true, force: true });
 }
});

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
