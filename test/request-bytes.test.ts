import { expect, test } from 'vitest';
import { requestBytes } from './request-bytes';

test('request parity normalizes native, JSON-escaped and Pi-rendered Windows cwd spellings', () => {
 const first = String.raw`C:\Users\operator\Temp\session-one`, second = String.raw`C:\Users\operator\Temp\session-two`;
 const context = (dir: string) => ({ cwd: dir, text: `<cwd>\n${dir.replace(/\\/g, '/')}\n</cwd>`,
  nested: { path: dir + String.raw`\src\a.ts`, timestamp: Math.random(), durationMs: Math.random() }, tokens: 123 });
 expect(JSON.stringify(context(first))).toContain('C:\\\\Users');
 expect(requestBytes(context(first), first)).toBe(requestBytes(context(second), second));
 expect(JSON.parse(requestBytes(context(first), first))).toEqual({ cwd: '<session>', text: '<cwd>\n<session>\n</cwd>', nested: { path: String.raw`<session>\src\a.ts` }, tokens: 123 });
 expect(requestBytes({ text: 'changed request' }, first)).not.toBe(requestBytes({ text: 'original request' }, second));
});

test('request parity keeps POSIX normalization and unrelated fields exact', () => {
 expect(requestBytes({ cwd: '/tmp/session', other: '/repo/file', timestamp: 1, durationMs: 2, count: 3 }, '/tmp/session'))
  .toBe('{"cwd":"<session>","other":"/repo/file","count":3}');
});
