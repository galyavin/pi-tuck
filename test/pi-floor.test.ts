import { test, expect, vi } from 'vitest';

vi.mock('@earendil-works/pi-coding-agent', async importOriginal => ({ ...await importOriginal<object>(), VERSION: '1.1.0' }));

test('the floor: 1.2.0 and later are supported, older versions are not, and a version that does not parse is', async () => {
 const { piSupported } = await import('../index');
 for (const v of ['1.2.0', '1.2.1', '1.4.0', '2.0.0', '1.10.0', '1.2.0-beta.1', 'dev']) expect(piSupported(v), v).toBe(true);
 for (const v of ['1.1.9', '1.1.0', '1.0.4', '0.99.2', '0.87.0']) expect(piSupported(v), v).toBe(false);
}, 60_000);

test('on an older Pi, pi-tuck registers nothing but one notice, given once', async () => {
 const { default: extension } = await import('../index');
 const handlers = new Map<string, ((...a: unknown[]) => unknown)[]>(), tools: string[] = [], notices: string[] = [];
 const pi = { on: (name: string, h: (...a: unknown[]) => unknown) => { handlers.set(name, [...(handlers.get(name) ?? []), h]); }, registerTool: (t: { name: string }) => { tools.push(t.name); }, registerCommand: () => {} };
 await extension(pi as never);
 expect(tools).toEqual([]);
 expect([...handlers.keys()]).toEqual(['session_start']);
 const ctx = { ui: { notify: (m: string) => notices.push(m) } };
 for (let i = 0; i < 2; i++) for (const h of handlers.get('session_start')!) h({}, ctx);
 expect(notices).toEqual(["pi-tuck needs Pi 1.2.0 or later (this is Pi 1.1.0); it is off, and Pi's own compaction runs."]);
}, 60_000);
