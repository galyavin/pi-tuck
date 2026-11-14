import { execFile } from 'node:child_process';
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

/** Only the current user, SYSTEM and local administrators may receive access.
 * No ACLs are changed: shared/custom storage fails closed before content is written. */
export function assertWindowsPrivateStorage(paths: readonly string[]): Promise<void> {
 const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
 return new Promise((resolve, reject) => {
  execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', CHECK_ACL], {
   env: { ...process.env, PI_TUCK_STORAGE_PATHS: JSON.stringify(paths) }, windowsHide: true, timeout: 10_000, maxBuffer: 16_384,
  }, error => error ? reject(error) : resolve());
 });
}
