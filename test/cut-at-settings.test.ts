import { test, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

// `"cutAt"` in pi-tuck.json in Pi's agent folder is read by index.ts and handed to installCompaction; any value that is not a number above
// 0 and at most 1 is a settings error, reported at the next session start with the other settings errors, and the default applies.
// installCompaction is replaced by a recorder (it is covered by cut-at.test.ts), so that the option the extension passes can be read.
const state = vi.hoisted(() => ({ options: [] as { cutAt?: number }[] }));
vi.mock('../src/compaction', () => ({
	installCompaction: vi.fn(async (_pi: unknown, options: { cutAt?: number }) => { state.options.push(options); return { setSemanticEnabled: async () => {} }; }),
}));

async function load(file: string | undefined) {
	const agentDir = mkdtempSync(join(tmpdir(), 'pi-tuck-settings-'));
	const path = join(agentDir, 'pi-tuck.json');
	if (file !== undefined) writeFileSync(path, file);
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
		const pi = { on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); } } as unknown as ExtensionAPI;
		state.options.length = 0;
		const { default: extension } = await import('../index');
		await extension(pi);
		expect(state.options).toHaveLength(1);
		const notices: { message: string; level: string }[] = [];
		// A session start without a UI: nothing is downloaded, whatever the platform.
		const ctx = { hasUI: false, cwd: join(agentDir, 'project'), ui: { notify: (message: string, level: string) => { notices.push({ message, level }); } } } as unknown as ExtensionContext;
		for (const handler of handlers.get('session_start') ?? []) await handler({}, ctx);
		return { cutAt: state.options[0]!.cutAt, notices, path, listening: handlers.has('session_start') };
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(agentDir, { recursive: true, force: true });
	}
}

test('without a settings file the cut point is not set and nothing is reported', async () => {
	const r = await load(undefined);
	expect(r.cutAt).toBeUndefined();
	expect(r.notices.filter(n => n.level === 'warning')).toEqual([]);
});

for (const [file, cutAt] of [['{"cutAt": 1}', 1], ['{"cutAt": 0.6}', 0.6], ['{"cutAt": 0.0001}', 0.0001], ['{"cutAt": 0.6, "semanticRecall": true}', 0.6], ['{"semanticRecall": true}', undefined], ['{}', undefined]] as const)
test(`${file}: the cut point is passed on and nothing is reported`, async () => {
	const r = await load(file);
	expect(r.cutAt).toBe(cutAt);
	expect(r.notices.filter(n => n.level === 'warning')).toEqual([]);
});

test('with semantic recall off the cut point still applies', async () => {
	const r = await load('{"semanticRecall": false, "cutAt": 0.6}');
	expect(r.cutAt).toBe(0.6);
	expect(r.listening).toBe(false);
});

for (const bad of ['0', '-0.5', '1.01', '2', '"0.6"', 'null', 'true', '[0.6]', '{}', '"fast"'])
test(`{"cutAt": ${bad}}: a settings error, reported with the same warning as any other, and the default applies`, async () => {
	const r = await load(`{"cutAt": ${bad}}`);
	expect(r.cutAt).toBeUndefined();
	const warnings = r.notices.filter(n => n.level === 'warning');
	expect(warnings).toHaveLength(1);
	expect(warnings[0]!.message).toBe(`pi-tuck: ${r.path} should be a JSON object like {"semanticRecall": false, "cutAt": 0.8}, with cutAt a number above 0 and at most 1; using the defaults.`);
});

test('the error path is the one every settings error takes: a file that is not an object of known values, or not JSON, gives the same warning and the default', async () => {
	for (const file of ['{"semanticRecall": "no"}', '{"cutAt": 0, "semanticRecall": false}', 'not json', '[]x']) {
		const r = await load(file);
		expect(r.cutAt, file).toBeUndefined();
		const warnings = r.notices.filter(n => n.level === 'warning');
		expect(warnings, file).toHaveLength(1);
		expect(warnings[0]!.message, file).toContain(`pi-tuck: ${r.path} should be a JSON object`);
		expect(warnings[0]!.message, file).toContain('using the defaults.');
	}
});
