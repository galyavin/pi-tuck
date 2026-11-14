import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// Node's Windows mode/uid fields cannot prove private storage. Check the native DACL instead.
// Pass paths as data, never PowerShell source; SID comparisons also work on non-English hosts.
const CHECK_ACL = `
$ErrorActionPreference = 'Stop'
try {
 $user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
 $trusted = @($user, 'S-1-5-18', 'S-1-5-32-544')
 foreach ($path in (ConvertFrom-Json -InputObject $env:PI_TUCK_STORAGE_PATHS)) {
  $item = Get-Item -LiteralPath $path -Force
  if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'Recorder reparse point' }
  $acl = Get-Acl -LiteralPath $path
  if ($trusted -notcontains $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value) { throw 'Recorder owner' }
  $rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
  if ($rules.Count -eq 0) { throw 'Recorder missing DACL' }
  foreach ($rule in $rules) {
   if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
   $sid = $rule.IdentityReference.Value
   if ($trusted -contains $sid) { continue }
   if ($sid -eq 'S-1-3-0' -and ($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly)) { continue }
   throw 'Recorder non-private DACL'
  }
 }
} catch { [Console]::Error.WriteLine('Recorder requires private Windows storage'); exit 1 }
`;

// Build a fresh protected DACL, dropping both inherited and explicit foreign entries.
// Directories pass this security descriptor at creation, including missing ancestors;
// existing directories are returned unchanged by Directory.CreateDirectory.
const PRIVATE_DACL = `
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl.SetOwner($user)
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in @($user.Value, 'S-1-5-18', 'S-1-5-32-544')) {
 $identity = [System.Security.Principal.SecurityIdentifier]::new($sid)
 $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, [System.Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
 $acl.AddAccessRule($rule)
}
`;
const CREATE_DIRECTORY = `
$ErrorActionPreference = 'Stop'
try {
 $acl = [System.Security.AccessControl.DirectorySecurity]::new()
 $inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
 ${PRIVATE_DACL}
 foreach ($path in (ConvertFrom-Json -InputObject $env:PI_TUCK_STORAGE_PATHS)) {
  [void][System.IO.Directory]::CreateDirectory($path, $acl)
 }
} catch { [Console]::Error.WriteLine('Recorder could not create private Windows directory'); exit 1 }
`;
const PROTECT_FILE = `
$ErrorActionPreference = 'Stop'
try {
 $acl = [System.Security.AccessControl.FileSecurity]::new()
 $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
 ${PRIVATE_DACL}
 foreach ($path in (ConvertFrom-Json -InputObject $env:PI_TUCK_STORAGE_PATHS)) {
  $item = Get-Item -LiteralPath $path -Force
  if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'Recorder file type' }
  Set-Acl -LiteralPath $path -AclObject $acl
 }
} catch { [Console]::Error.WriteLine('Recorder could not protect Windows file'); exit 1 }
`;

function runAclCommand(script: string, paths: readonly string[]): Promise<void> {
 const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
 return new Promise((resolve, reject) => {
  execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
   env: { ...process.env, PI_TUCK_STORAGE_PATHS: JSON.stringify(paths) }, windowsHide: true, timeout: 10_000, maxBuffer: 16_384,
  }, error => error ? reject(error) : resolve());
 });
}

/** Create private storage without changing any pre-existing directory's permissions.
 * Callers must still verify existing storage before using it. */
export async function createPrivateDirectory(directory: string): Promise<void> {
 if (process.platform === 'win32') await runAclCommand(CREATE_DIRECTORY, [directory]);
 else await mkdir(directory, { recursive: true, mode: 0o700 });
}

/** Only call for an empty file we just created exclusively inside verified private storage.
 * The recorder retains its handle, protects the file, then verifies it before writing content. */
export function protectWindowsIncidentFile(path: string): Promise<void> {
 return runAclCommand(PROTECT_FILE, [path]);
}

/** Only the current user, SYSTEM and local administrators may receive access.
 * No ACLs are changed: shared/custom storage fails closed before content is written. */
export function assertWindowsPrivateStorage(paths: readonly string[]): Promise<void> {
 return runAclCommand(CHECK_ACL, paths);
}
