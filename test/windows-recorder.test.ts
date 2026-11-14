import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { IncidentRecorder } from '../src/diagnostics';
import { assertWindowsPrivateStorage } from '../src/windows-private-storage';

vi.mock('../src/windows-private-storage', () => ({ assertWindowsPrivateStorage: vi.fn() }));
const acl = vi.mocked(assertWindowsPrivateStorage);
let directory: string;
beforeEach(() => {
 directory = mkdtempSync(join(tmpdir(), 'pi-incident-windows-'));
 acl.mockReset().mockResolvedValue();
 vi.stubGlobal('process', new Proxy(process, { get: (target, key) => key === 'platform' ? 'win32' : Reflect.get(target, key) }));
});
afterEach(() => { vi.unstubAllGlobals(); rmSync(directory, { recursive: true, force: true }); });

test('Windows recording writes start, content and terminal across pumps and can restart', async () => {
 const notices: string[] = [], recorder = new IncidentRecorder({ directory });
 recorder.start(join(directory, 'project'), false, message => notices.push(message));
 await recorder.flush();
 expect(recorder.status().state).toBe('recording');
 const file = recorder.status().path!;
 expect(acl.mock.calls.slice(0, 2)).toEqual([[[directory]], [[file]]]);
 recorder.capture('example', 'test', { value: 'retained bytes' });
 await recorder.flush();
 recorder.stop('operator-cancelled');
 await recorder.flush();
 expect(recorder.status().state).toBe('operator-cancelled');
 const records = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line));
 expect(records.map(record => record.kind)).toEqual(['start', 'example', 'terminal']);
 expect(records[1].data).toEqual({ value: 'retained bytes' });
 expect(notices).toEqual(['Compaction incident: operator-cancelled']);
 recorder.start(join(directory, 'project'), false, () => {});
 await recorder.flush();
 recorder.stop('second-recording');
 await recorder.flush();
 expect(recorder.status().path).not.toBe(file);
 expect(readdirSync(directory)).toHaveLength(2);
});

test('a Windows ACL failure leaves a storage gap without writing incident content', async () => {
 acl.mockRejectedValue(new Error('non-private DACL'));
 const notices: string[] = [], recorder = new IncidentRecorder({ directory });
 recorder.start(join(directory, 'project'), false, message => notices.push(message));
 await recorder.flush();
 expect(recorder.status().state).toBe('storage-failed-gap');
 expect(recorder.enabled).toBe(false);
 expect(notices).toEqual(['Compaction recorder storage failed; incident has a gap']);
 expect(readdirSync(directory)).toEqual([]);
});

test('a Windows file ACL failure leaves the newly created file empty and closes it', async () => {
 acl.mockResolvedValueOnce().mockRejectedValue(new Error('non-private file DACL'));
 const recorder = new IncidentRecorder({ directory });
 recorder.start(join(directory, 'project'), false, () => {});
 await recorder.flush();
 expect(recorder.status().state).toBe('storage-failed-gap');
 const file = recorder.status().path!;
 expect(readFileSync(file, 'utf8')).toBe('');
 rmSync(file);
});

test('Windows exclusive creation refuses an existing destination without appending', async () => {
 const recorder = new IncidentRecorder({ directory });
 recorder.start(join(directory, 'project'), false, () => {});
 const file = recorder.status().path!;
 writeFileSync(file, 'existing content');
 await recorder.flush();
 expect(recorder.status().state).toBe('storage-failed-gap');
 expect(readFileSync(file, 'utf8')).toBe('existing content');
});

test('Windows retention checks every old incident ACL before deleting any file', async () => {
 const old = join(directory, 'tuck-incident-11111111-1111-1111-1111-111111111111.jsonl');
 writeFileSync(old, 'old incident');
 acl.mockRejectedValue(new Error('unsafe retained incident'));
 const recorder = new IncidentRecorder({ directory, maxFiles: 1 });
 recorder.start(join(directory, 'project'), false, () => {});
 await recorder.flush();
 expect(acl).toHaveBeenCalledWith([directory, old]);
 expect(recorder.status().state).toBe('storage-failed-gap');
 expect(readFileSync(old, 'utf8')).toBe('old incident');
});
