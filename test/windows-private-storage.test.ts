import { expect, test, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { assertWindowsPrivateStorage, createPrivateDirectory, protectWindowsIncidentFile } from '../src/windows-private-storage';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
const exec = vi.mocked(execFile);

test('Windows ACL checks use the system PowerShell and pass hostile path characters as data', async () => {
 exec.mockImplementationOnce(((_file: unknown, _args: unknown, _options: unknown, callback: (error: Error | null) => void) => { callback(null); }) as typeof execFile);
 const paths = [String.raw`C:\Users\operator\space ' ; $(bad)\incident`, String.raw`C:\Users\operator\报告.jsonl`];
 await assertWindowsPrivateStorage(paths);
 const [file, args, options] = exec.mock.calls.at(-1)!;
 expect(file).toBe(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
 expect(args).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', expect.any(String)]);
 expect(args!.at(-1)).not.toContain(paths[0]);
 expect(options).toMatchObject({ windowsHide: true, timeout: 10_000, env: { PI_TUCK_STORAGE_PATHS: JSON.stringify(paths) } });
});

test('Windows ACL command errors and timeouts propagate to the recorder', async () => {
 exec.mockImplementationOnce(((_file: unknown, _args: unknown, _options: unknown, callback: (error: Error) => void) => { callback(new Error('private storage unavailable')); }) as typeof execFile);
 await expect(assertWindowsPrivateStorage(['unused'])).rejects.toThrow('private storage unavailable');
});

for (const operation of [createPrivateDirectory, protectWindowsIncidentFile]) {
 test(`${operation.name} passes paths as data and propagates native failures`, async () => {
  vi.stubGlobal('process', new Proxy(process, { get: (target, key) => key === 'platform' ? 'win32' : Reflect.get(target, key) }));
  try {
   const path = String.raw`C:\Users\operator\space ' ; $(bad)\报告`;
   exec.mockImplementationOnce(((_file: unknown, _args: unknown, _options: unknown, callback: (error: Error | null) => void) => { callback(null); }) as typeof execFile);
   await operation(path);
   const [, args, options] = exec.mock.calls.at(-1)!;
   expect(args!.at(-1)).not.toContain(path);
   expect(options).toMatchObject({ windowsHide: true, timeout: 10_000, env: { PI_TUCK_STORAGE_PATHS: JSON.stringify([path]) } });
   exec.mockImplementationOnce(((_file: unknown, _args: unknown, _options: unknown, callback: (error: Error) => void) => { callback(new Error('native protection failed')); }) as typeof execFile);
   await expect(operation(path)).rejects.toThrow('native protection failed');
  } finally { vi.unstubAllGlobals(); }
 });
}
