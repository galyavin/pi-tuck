import { expect, test } from 'vitest';
import { win32 } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { pathKey } from '../src/path-key';
import { keptReadCandidates } from '../src/kept-reads';
import { actionItems, ledgerItems, ledgerRecords } from '../src/ledger';
import { tuck, tuckRecall } from '../src/tuck';
import { buildGlobalIndexById } from '../src/tuck/core/global-indices';

const cwd = win32.resolve('C:\\repo');
const absolute = win32.join(cwd, 'src', 'a.ts');
const spellings = [absolute, absolute.replace(/\\/g, '/'), absolute.replace(/^C:/, 'c:'),
  win32.join('src', 'a.ts'), '.\\src\\a.ts', 'src/../src/a.ts'];

test.each(spellings)('Windows comparison keys resolve the recorded cwd: %s', spelling => {
  expect(pathKey(spelling, cwd)).toBe('c:/repo/src/a.ts');
  expect(pathKey(spelling, cwd.replace(/^C:/, 'c:').replace(/\\/g, '/'))).toBe('c:/repo/src/a.ts');
});

test('comparison keys preserve filename case, other drives and unresolved relative identities', () => {
  expect(pathKey('SRC/a.ts', cwd)).not.toBe(pathKey('src/a.ts', cwd));
  expect(pathKey(win32.join('D:\\repo', 'src', 'a.ts'), cwd)).toBe('d:/repo/src/a.ts');
  expect(pathKey('src\\a.ts')).not.toBe(pathKey(absolute));
  expect(pathKey('./src/../src/a.ts', '/repo')).toBe('/repo/src/a.ts');
});

function fixture(paths = [absolute]) {
  // Loading a recorded Windows header avoids the Mac host resolving C:\\repo as a local relative path.
  const header = { ...SessionManager.inMemory().getHeader()!, cwd };
  const manager = SessionManager.inMemory(cwd, undefined, [header]);
  let sequence = 0;
  const call = (name: string, args: Record<string, string>, text?: string) => {
    const id = `call-${sequence++}`;
    manager.appendMessage({ role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }],
      api: 'openai-responses', provider: 'fixture', model: 'fixture', stopReason: 'toolUse', timestamp: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    if (text !== undefined) return manager.appendMessage({ role: 'toolResult', toolCallId: id, toolName: name,
      isError: false, content: [{ type: 'text', text }], timestamp: 0 });
  };
  paths.forEach((path, i) => call('read', { path }, `contents-${i}`));
  const indices = () => buildGlobalIndexById(manager.getEntries());
  const candidates = () => keptReadCandidates([manager.getHeader()!, ...manager.getBranch()], indices(), () => true);
  const files = () => ledgerItems(manager.getBranch(), indices(), () => true, new Set(), cwd);
  return { manager, call, candidates, files };
}

test('kept reads and Files deduplicate every Windows spelling and display the newest recorded spelling', () => {
  const f = fixture(spellings);
  const newest = spellings.at(-1)!;
  expect(f.candidates()).toHaveLength(1);
  expect(f.candidates()[0]!.text).toContain(`read ${newest} (as recorded at #`);
  expect(f.candidates()[0]!.text).toContain(`contents-${spellings.length - 1}`);
  expect(f.files()).toHaveLength(1);
  expect(f.files()[0]!.path).toBe(newest);
  expect(ledgerRecords(f.files())[1]!.text).toContain(`- read ${newest} (tuck_recall`);
  const page = tuckRecall(tuck, f.manager.getEntries(), f.manager.getBranch(), { index: f.files()[0]!.locatorIndex! }) as { entries: { text: string }[] };
  expect(page.entries[0]!.text).toBe(`contents-${spellings.length - 1}`);
});

test.each(spellings)('display keeps the recorded spelling verbatim: %s', spelling => {
  const f = fixture([spelling]);
  expect(f.candidates()[0]!.text).toContain(`read ${spelling} (as recorded at #`);
  expect(f.files()[0]!.path).toBe(spelling);
});

test.each(['write', 'edit'])('a Windows %s alias voids the kept read and updates the Files locator', name => {
  const f = fixture();
  f.call(name, { file_path: '.\\src\\a.ts', content: 'changed' });
  expect(f.candidates()).toEqual([]);
  expect(f.files()).toHaveLength(1);
  expect(f.files()[0]).toMatchObject({ path: '.\\src\\a.ts', operation: 'wrote/edited' });
  const page = tuckRecall(tuck, f.manager.getEntries(), f.manager.getBranch(), { index: f.files()[0]!.locatorIndex! });
  expect(JSON.stringify(page)).toContain('changed');
});

const mutations = [
  'Set-Content -Path .\\src\\a.ts -Value changed',
  'Add-Content -LiteralPath C:/repo/src/a.ts -Value changed',
  'Out-File -FilePath c:\\repo\\src\\a.ts -InputObject changed',
  'Remove-Item -Force .\\src\\a.ts',
  'Move-Item src\\a.ts src\\b.ts',
  'Copy-Item src\\b.ts C:/repo/src/a.ts',
  'New-Item -Path C:\\repo\\src\\a.ts -Force',
  'del /f C:\\repo\\src\\a.ts',
  'move src\\a.ts src\\b.ts',
  'copy src\\b.ts .\\src\\a.ts',
  'ren C:\\repo\\src\\a.ts b.ts',
  'sEt-CoNtEnT .\\src\\a.ts changed',
  'type other.txt > .\\src\\a.ts',
  'Get-Content other.txt | Out-File .\\src\\a.ts',
  'unknown-command .\\src\\a.ts',
  'cd src && del a.ts',
  'cd C:\\repo\\src && Remove-Item a.ts',
];
test.each(mutations)('D2 invalidates a named Windows read even without a shell result: %s', command => {
  const f = fixture([absolute, win32.join(cwd, 'untouched')]);
  f.call('bash', { command });
  expect(f.candidates()).toHaveLength(1);
  expect(f.candidates()[0]!.text).toContain('read ' + win32.join(cwd, 'untouched') + ' ');
  f.call('read', { path: 'src\\a.ts' }, 'fresh contents');
  expect(f.candidates()[0]!.text).toContain('fresh contents');
});

test.each(['Set-Content', 'Add-Content', 'Out-File', 'Remove-Item', 'Move-Item', 'Copy-Item', 'New-Item', 'del', 'move', 'copy', 'ren'])
('quoted paths with spaces stay identifiable in %s', name => {
  const f = fixture([win32.join(cwd, 'my src', 'a.ts')]);
  f.call('bash', { command: `${name} "c:\\repo\\my src\\a.ts" other` });
  expect(f.candidates()).toEqual([]);
});

test.each(['type', 'dir', 'Get-Content', 'Get-ChildItem', 'Select-String', 'findstr', 'gEt-CoNtEnT',
  'Get-Content .\\src\\a.ts | Select-String needle | findstr needle'])
('D2 preserves reads on the Windows read-only form: %s', command => {
  const f = fixture();
  f.call('bash', { command: `${command} .\\src\\a.ts` });
  expect(f.candidates()).toHaveLength(1);
});

test.each(['Get-Content $(Remove-Item .\\src\\a.ts)', 'type %MUTATING% .\\src\\a.ts',
  'dir .\\src\\a.ts & unknown-command', 'Get-Content .\\src\\a.ts | unknown-command'])
('unclassifiable Windows shell syntax is never certified read-only: %s', command => {
  const f = fixture();
  f.call('bash', { command });
  expect(f.candidates()).toEqual([]);
});

test('Windows actions retain the exact recorded command and their result locator', () => {
  const f = fixture([]), command = 'Copy-Item C:\\repo\\src\\a.ts .\\backup\\a.ts';
  const result = f.call('bash', { command }, 'copied');
  const indices = buildGlobalIndexById(f.manager.getEntries());
  expect(actionItems(f.manager.getBranch(), indices, () => true, new Set())).toEqual([
    { text: `bash: ${command}`, failed: false, sourceIndex: indices.get(result!), resolvable: true },
  ]);
});
