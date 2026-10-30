import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager, type ExtensionAPI, type ExtensionContext, type ExtensionToolContext, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { createSemanticRecall, semanticEligibleSources, type SemanticRecallController } from '../src/semantic-recall';
import { eligibilityKey, memoizedEligibleSources } from '../src/eligibility-cache';
import { installCompaction } from '../src/compaction';
import { tuckRecall } from '../src/tuck';
import type { RecallPolicy } from '../src/recall';
import { BAND, HOST, EXACT_RESERVE, harness } from './budget-fixture';

// The eligible-history snapshot is memoized per session manager on a cheap key. `access()` still runs on every call, a hit never hands out the
// stored object (the controller fills `units`, `complete`, `indexed` and `window` on what it is given, and reads `viewStart` to place the window), and
// the key is sound only while entries are not changed in place after they are appended (the pin test below). The wrapped build is counted through a
// pass-through spy, so a rebuild is observable.
vi.mock('../src/semantic-recall', async importOriginal => {
	const actual = await importOriginal<typeof import('../src/semantic-recall')>();
	return { ...actual, semanticEligibleSources: vi.fn(actual.semanticEligibleSources) };
});
const reference = (await vi.importActual<typeof import('../src/semantic-recall')>('../src/semantic-recall')).semanticEligibleSources;
const rebuilds = () => vi.mocked(semanticEligibleSources).mock.calls.length;
// The lexical pass of `tuck_search` is counted through a pass-through spy on `tuckRecall`, so the second pass is observable.
vi.mock('../src/tuck', async importOriginal => {
	const actual = await importOriginal<typeof import('../src/tuck')>();
	return { ...actual, tuckRecall: vi.fn(actual.tuckRecall) };
});
const lexicalPasses = () => vi.mocked(tuckRecall).mock.calls.length;
const actualTuck = await vi.importActual<typeof import('../src/tuck')>('../src/tuck'); // uncounted reference passes
type Snapshot = ReturnType<typeof reference>;

const CWD = '/eligibility-cache-test';
const quiet = () => {};
const user = (text: string, timestamp = 1) => ({ role: 'user' as const, content: text, timestamp });
const assistant = (text: string, timestamp = 1) => ({ role: 'assistant' as const, content: [{ type: 'text' as const, text }], api: 'test', provider: 'test', model: 'test', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop' as const, timestamp });
const toolResult = (id: string, text: string, timestamp = 1) => ({ role: 'toolResult' as const, toolCallId: id, toolName: 'bash', content: [{ type: 'text' as const, text }], isError: false, timestamp });
const ctxOf = (sessionManager: SessionManager, cwd = CWD) => ({ cwd, sessionManager });
function session(count = 3, cwd = CWD) {
	const m = SessionManager.inMemory(cwd);
	const ids = Array.from({ length: count }, (_, i) => m.appendMessage(user(`note ${i} ` + 'x'.repeat(40), i + 1)));
	return { m, ids, ctx: ctxOf(m, cwd) };
}
const thrown = (run: () => unknown): Error => { try { run(); } catch (error) { return error as Error; } throw new Error('Expected a throw'); };
function deepFreeze<T>(value: T, seen = new Set<object>()): T {
	if (value !== null && typeof value === 'object' && !seen.has(value)) { seen.add(value); Object.freeze(value); for (const inner of Object.values(value)) deepFreeze(inner, seen); }
	return value;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The cache itself.

test('an unchanged session is a hit: no rebuild, the same content, and the content equals a direct build', () => {
	const { ctx } = session();
	const start = rebuilds();
	const first = memoizedEligibleSources(ctx, undefined, quiet);
	expect(rebuilds()).toBe(start + 1);
	const second = memoizedEligibleSources(ctx, undefined, quiet), third = memoizedEligibleSources(ctx, undefined, quiet);
	expect(rebuilds()).toBe(start + 1);
	expect(second.id).toBe(first.id);
	expect(second.sources).toBe(first.sources); // the immutable part is shared, which is what the cache saves
	expect(second).toEqual(first);
	expect(third).toEqual(first);
	expect(first).toEqual(reference(ctx, {}, quiet));
});

const changes: Record<string, (f: ReturnType<typeof session>) => void> = {
	'an appended message': f => { f.m.appendMessage(user('a later message', 99)); },
	'a compaction entry': f => { f.m.appendCompaction('a summary', f.ids[1]!, 100); },
	'a context_edit entry': f => { f.m.appendContextEdit(f.ids[0]!, null); },
	'a private custom entry': f => { f.m.appendCustomEntry('host.input', { text: 'input' }); },
	'a switch to an earlier entry': f => { f.m.branch(f.ids[0]!); },
	'a reset to the root': f => { f.m.resetLeaf(); },
};
for (const [name, change] of Object.entries(changes)) test(`${name} forces a rebuild with a new id, and the next call is a hit again`, () => {
	const f = session();
	const before = memoizedEligibleSources(f.ctx, undefined, quiet);
	change(f);
	const start = rebuilds();
	const after = memoizedEligibleSources(f.ctx, undefined, quiet);
	expect(rebuilds()).toBe(start + 1);
	expect(after.id).not.toBe(before.id);
	expect(after).toEqual(reference(f.ctx, {}, quiet));
	expect(memoizedEligibleSources(f.ctx, undefined, quiet).id).toBe(after.id);
	expect(rebuilds()).toBe(start + 1);
});

test('a switch to a sibling branch of the same length and the same entry count is caught by the leaf alone', () => {
	const m = SessionManager.inMemory(CWD), ctx = ctxOf(m);
	const root = m.appendMessage(user('root', 1)), left = m.appendMessage(user('left', 2));
	m.branch(root);
	m.appendMessage(user('right', 3));
	const before = memoizedEligibleSources(ctx, undefined, quiet), key = eligibilityKey(ctx);
	m.branch(left);
	const after = eligibilityKey(ctx);
	expect(after[3]).toBe(key[3]); // same branch length
	expect(after[4]).toBe(key[4]); // same entry count
	const start = rebuilds(), moved = memoizedEligibleSources(ctx, undefined, quiet);
	expect(rebuilds()).toBe(start + 1);
	expect(moved.id).not.toBe(before.id);
	expect(moved).toEqual(reference(ctx, {}, quiet));
});

test('a new session on the same manager (empty to empty) is caught by the session id alone', () => {
	const m = SessionManager.inMemory(CWD), ctx = ctxOf(m);
	const before = memoizedEligibleSources(ctx, undefined, quiet), key = eligibilityKey(ctx);
	m.newSession();
	const after = eligibilityKey(ctx);
	expect(after.slice(1)).toEqual(key.slice(1));
	const start = rebuilds(), fresh = memoizedEligibleSources(ctx, undefined, quiet);
	expect(rebuilds()).toBe(start + 1);
	expect(fresh.session).not.toBe(before.session);
	expect(fresh.id).not.toBe(before.id);
});

test('another session manager and another cwd each get their own snapshot', () => {
	const a = session(), b = session();
	const first = memoizedEligibleSources(a.ctx, undefined, quiet), start = rebuilds();
	const other = memoizedEligibleSources(b.ctx, undefined, quiet);
	expect(rebuilds()).toBe(start + 1);
	expect(other.id).not.toBe(first.id);
	expect(memoizedEligibleSources(a.ctx, undefined, quiet).id).toBe(first.id); // the first manager's entry is untouched
	expect(rebuilds()).toBe(start + 1);
	const moved = memoizedEligibleSources({ cwd: '/elsewhere', sessionManager: a.m }, undefined, quiet);
	expect(rebuilds()).toBe(start + 2);
	expect(moved.id).not.toBe(first.id);
	expect(moved.project).toBe('/elsewhere');
});

test('the same directory spelled another way is another key, so a hit carries the project exactly as the caller spells it', () => {
	const { m, ctx } = session(), spelled = { cwd: CWD + '/', sessionManager: m };
	memoizedEligibleSources(ctx, undefined, quiet);
	const start = rebuilds(), other = memoizedEligibleSources(spelled, undefined, quiet);
	expect(rebuilds()).toBe(start + 1);
	expect(other).toEqual(reference(spelled, {}, quiet));
	expect(other.project).toBe(CWD + '/');
});

test('an entry added without moving the leaf (out of band) is caught by the entry count alone', () => {
	const f = session();
	const before = memoizedEligibleSources(f.ctx, undefined, quiet), key = eligibilityKey(f.ctx);
	// A second entry with an existing id makes both ineligible; the leaf and the branch do not move.
	const original = f.m.getEntry(f.ids[1]!)!;
	(f.m as unknown as { fileEntries: unknown[] }).fileEntries.push({ ...original, parentId: f.ids[2] });
	const after = eligibilityKey(f.ctx);
	expect(after.slice(0, 4)).toEqual(key.slice(0, 4));
	expect(after[4]).toBe((key[4] as number) + 1);
	const start = rebuilds(), now = memoizedEligibleSources(f.ctx, undefined, quiet);
	expect(rebuilds()).toBe(start + 1);
	expect(now.id).not.toBe(before.id);
	expect(now).toEqual(reference(f.ctx, {}, quiet));
});

test('access() runs once on every call, hits included, and a build does not check it twice', () => {
	const { ctx } = session();
	let calls = 0;
	const access = () => { calls++; };
	memoizedEligibleSources(ctx, undefined, access); expect(calls).toBe(1); // a miss
	memoizedEligibleSources(ctx, undefined, access); expect(calls).toBe(2); // a hit
	memoizedEligibleSources(ctx, undefined, access); expect(calls).toBe(3);
	ctx.sessionManager.appendMessage(user('more', 50));
	memoizedEligibleSources(ctx, undefined, access); expect(calls).toBe(4); // a miss after a change
});

test('access() revoked on a hit throws SemanticAccessError with the message a direct build gives, and nothing is rebuilt', () => {
	const { ctx } = session();
	let allowed = true;
	const access = () => { if (!allowed) throw new Error('Access revoked'); };
	const first = memoizedEligibleSources(ctx, undefined, access), start = rebuilds();
	allowed = false;
	const error = thrown(() => memoizedEligibleSources(ctx, undefined, access)), direct = thrown(() => reference(ctx, {}, access));
	expect(error.name).toBe('SemanticAccessError');
	expect(error.message).toBe('Access revoked');
	expect({ name: error.name, message: error.message }).toEqual({ name: direct.name, message: direct.message });
	expect(rebuilds()).toBe(start);
	allowed = true;
	expect(memoizedEligibleSources(ctx, undefined, access).id).toBe(first.id); // restored access: a hit again
	expect(rebuilds()).toBe(start);
});

test('access() revoked on a miss throws SemanticAccessError and caches nothing; a thrown non-Error gives the default message', () => {
	const { ctx } = session();
	const start = rebuilds();
	expect(thrown(() => memoizedEligibleSources(ctx, undefined, () => { throw new Error('Access revoked'); })).name).toBe('SemanticAccessError');
	expect(thrown(() => memoizedEligibleSources(ctx, undefined, () => { throw 'denied'; })).message).toBe('Source access denied');
	expect(rebuilds()).toBe(start);
	memoizedEligibleSources(ctx, undefined, quiet);
	expect(rebuilds()).toBe(start + 1);
});

test('access() is checked before anything is read from the session, so a revoked caller never reaches a cached snapshot', () => {
	const poisoned = new Proxy({}, { get() { throw new Error('the session was read before access was checked'); } }) as unknown as SessionManager;
	const error = thrown(() => memoizedEligibleSources({ cwd: CWD, sessionManager: poisoned }, undefined, () => { throw new Error('Access revoked'); }));
	expect(error.name).toBe('SemanticAccessError');
	expect(error.message).toBe('Access revoked');
});

test('two policy objects on one manager never share a snapshot, and a missing policy is one shared policy', () => {
	const { ctx } = session();
	const one: RecallPolicy = {}, two: RecallPolicy = {};
	const a = memoizedEligibleSources(ctx, one, quiet);
	let start = rebuilds();
	const b = memoizedEligibleSources(ctx, two, quiet); // equal content, another object
	expect(rebuilds()).toBe(start + 1);
	expect(b.sources).not.toBe(a.sources);
	start = rebuilds();
	memoizedEligibleSources(ctx, two, quiet);
	expect(rebuilds()).toBe(start); // the same object is a hit
	memoizedEligibleSources(ctx, undefined, quiet); start = rebuilds();
	memoizedEligibleSources(ctx, undefined, quiet);
	expect(rebuilds()).toBe(start); // no policy twice is a hit
});

test('a policy that changes eligibility gives its own snapshot from the same manager', () => {
	const { m, ctx } = session();
	m.appendCustomMessageEntry('host.input', 'private input', false);
	const open = memoizedEligibleSources(ctx, {}, quiet);
	const closed = memoizedEligibleSources(ctx, { privateCustomTypes: ['host.input'] }, quiet);
	expect(closed).toEqual(reference(ctx, { privateCustomTypes: ['host.input'] }, quiet));
	expect(open).toEqual(reference(ctx, {}, quiet));
	expect(open.sources.length).toBe(closed.sources.length + 1); // the private custom message is a source only without the policy
	expect(closed.id).not.toBe(open.id);
});

test('a hit never returns the previous object and never shares units or completion with it', () => {
	const { ctx } = session();
	const a = memoizedEligibleSources(ctx, undefined, quiet);
	a.units.push({ key: 'leak' } as never);
	a.complete = true;
	a.indexed.add('leak');
	a.window = { order: [], counts: [], searchUnits: 1, windowCharacters: 1, eligibleCharacters: 1, conversationOutOfView: 1, toolOutOfView: 1 }; // what prepare does to the snapshot it is given
	const b = memoizedEligibleSources(ctx, undefined, quiet);
	expect(b).not.toBe(a);
	expect(b.units).not.toBe(a.units);
	expect(b.units).toEqual([]);
	expect(b.complete).toBe(false);
	expect(b.indexed).not.toBe(a.indexed);
	expect(b.indexed.size).toBe(0);
	expect(b.window).toBeUndefined();
	const c = memoizedEligibleSources(ctx, undefined, quiet);
	expect(c).not.toBe(b);
	expect(c.units).toEqual([]);
	ctx.sessionManager.appendMessage(user('rebuild', 77));
	const d = memoizedEligibleSources(ctx, undefined, quiet), e = memoizedEligibleSources(ctx, undefined, quiet);
	expect(d).not.toBe(e); // a miss and the hit after it
	expect(d.units).not.toBe(e.units);
});

test('a session that cannot be built throws every time and caches nothing', () => {
	const { m, ctx } = session();
	m.appendContextEdit(m.getEntries()[0]!.id, { content: 'replacement' });
	expect(thrown(() => memoizedEligibleSources(ctx, undefined, quiet)).message).toBe('Unsupported replacement context edit');
	expect(thrown(() => memoizedEligibleSources(ctx, undefined, quiet)).message).toBe('Unsupported replacement context edit');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Soundness over random append sequences. A fixed seed; the property is stated about the stamp (the key), not about the cache.

const SEED = 20261018;
function random(seed: number) { // mulberry32
	let a = seed >>> 0;
	return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

test(`soundness, seed ${SEED}: stamp-equal never coexists with a different full id, every append changes the stamp, and the memoized id is the full id`, () => {
	const next = random(SEED), policy: RecallPolicy = { privateCustomTypes: ['host.input', 'host.attempt'] };
	const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	const bash = (step: number) => ({ role: 'bashExecution' as const, command: `ls ${step}`, output: `output ${step}`, exitCode: 0, cancelled: false, truncated: false, timestamp: step });
	// idChecks: a memoized id compared with a full build's. idRevisits: a stamp seen before in the sequence, whose earlier full id is compared with
	// the one now (a different state in between, then back). keyRepeats: only the key is compared, after leaving a state and returning to it.
	let steps = 0, appends = 0, switches = 0, idChecks = 0, idRevisits = 0, keyRepeats = 0, skipped = 0;
	const kinds = new Set<string>();
	for (let sequence = 0; sequence < 60; sequence++) {
		const m = SessionManager.inMemory(CWD), ctx = ctxOf(m);
		const seen = new Map<string, string>();
		const checked = (label: string) => { // the memoized id (a miss or a hit, then a hit) is the full id
			const full = reference(ctx, policy, quiet).id;
			expect(memoizedEligibleSources(ctx, policy, quiet).id, label).toBe(full);
			expect(memoizedEligibleSources(ctx, policy, quiet).id, label).toBe(full);
			idChecks += 2;
			return full;
		};
		for (let step = 0; step < 45; step++) {
			const before = eligibilityKey(ctx), roll = next(), entries = m.getEntries(), branch = m.getBranch();
			const editable = branch.filter(e => e.type === 'custom_message' || (e.type === 'message' && ['user', 'assistant', 'toolResult'].includes(e.message.role)));
			let kind: string, appended = true;
			try {
				if (roll < 0.22 || !entries.length) { kind = 'message'; m.appendMessage(pick([user(`u${step}`, step), assistant(`a${step}`, step), toolResult(`t${step}`, `r${step}`, step), bash(step)] as never[])); }
				else if (roll < 0.30 && editable.length) { kind = 'context_edit'; m.appendContextEdit(pick(editable).id, null); }
				else if (roll < 0.38) { kind = 'compaction'; m.appendCompaction(`summary ${step}`, pick(branch.length ? branch : entries).id, 100 + step); }
				else if (roll < 0.46) { kind = 'private custom'; m.appendCustomEntry(pick(['host.input', 'host.attempt']), { step }); }
				else if (roll < 0.50) { kind = 'public custom'; m.appendCustomEntry('other.note', { step }); }
				else if (roll < 0.55) { kind = 'custom message'; m.appendCustomMessageEntry(pick(['host.input', 'host.note']), `note ${step}`, false); }
				else if (roll < 0.59) { kind = 'label'; m.appendLabelChange(pick(entries).id, pick(['bookmark', undefined])); }
				else if (roll < 0.63) { kind = 'branch summary'; m.branchWithSummary(pick(entries).id, `summary of the branch left at step ${step}`); }
				else if (roll < 0.67) { kind = 'model change'; m.appendModelChange('test', pick(['model-a', 'model-b'])); }
				else if (roll < 0.70) { kind = 'thinking change'; m.appendThinkingLevelChange(pick(['low', 'high'])); }
				else if (roll < 0.73) { kind = 'session info'; m.appendSessionInfo(`session ${step}`); }
				else if (roll < 0.75) { kind = 'usage'; m.appendUsage('summary', 'test', 'model-a', usage); }
				else if (roll < 0.93) { kind = 'branch switch'; appended = false; m.branch(pick(entries).id); }
				else { kind = 'reset'; appended = false; m.resetLeaf(); }
			} catch { skipped++; continue; } // Pi refused an edit of an entry that cannot be edited: nothing changed
			const after = eligibilityKey(ctx), stamp = JSON.stringify(after);
			steps++; kinds.add(kind);
			if (appended) { appends++; expect(after, `${kind} must change the stamp`).not.toEqual(before); } else switches++;
			const full = checked(kind);
			if (seen.has(stamp)) { idRevisits++; expect(seen.get(stamp), `stamp ${stamp} reappeared with another id after ${kind}`).toBe(full); } else seen.set(stamp, full);
			// Leave the state without an append and come back: the key must repeat, and the id must equal the one given before (the check made while away
			// replaced the single cache entry, so the return is a rebuild, compared against the earlier id).
			if (!appended) {
				const there = m.getLeafId();
				if (there) {
					m.branch(pick(entries).id);
					checked('away');
					m.branch(there);
					expect(JSON.stringify(eligibilityKey(ctx))).toBe(stamp); keyRepeats++;
					expect(checked('back'), `back at ${stamp}`).toBe(full); idRevisits++;
				}
			}
		}
	}
	// The property was exercised: every operation kind ran, appends and switches both, and ids were compared at every step and at stamp repeats.
	expect([...kinds].sort()).toEqual(['branch summary', 'branch switch', 'compaction', 'context_edit', 'custom message', 'label', 'message', 'model change', 'private custom', 'public custom', 'reset', 'session info', 'thinking change', 'usage']);
	expect(appends).toBeGreaterThan(1000);
	expect(switches).toBeGreaterThan(300);
	expect(idChecks).toBeGreaterThan(2 * steps);
	expect(idRevisits).toBeGreaterThan(300);
	expect(keyRepeats).toBeGreaterThan(200);
	console.log(`soundness seed ${SEED}: ${steps} steps (${appends} appends, ${switches} switches), ${idChecks} memoized-against-full id comparisons, ${idRevisits} of them at a stamp seen before, ${keyRepeats} key repeats after leaving and returning, ${skipped} refused edits skipped`);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The controller, driven with a fixture worker as the existing semantic tests do. `kind` chooses the provider: the memoized one or a direct build.

interface Unit { key: string; entryId: string; start: number; end: number; inputSha: string; encoded: string; source: unknown }
interface Internals { prepare(provider: () => Snapshot, full?: boolean): Promise<void>; current?: Snapshot; runtime: unknown; }
const roots: string[] = [], controllers: SemanticRecallController[] = [];
afterEach(async () => { for (const c of controllers.splice(0)) await c.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(kind: 'memo' | 'plain' = 'memo', policy?: RecallPolicy) {
	const root = mkdtempSync(join(tmpdir(), 'eligibility-cache-')); roots.push(root);
	const project = join(root, 'project');
	const c = createSemanticRecall({ pythonPath: '/unused-python', runtimeRoot: join(root, 'runtime'), indexDirectory: join(root, 'index') }); controllers.push(c); c.enable();
	const internal = c as unknown as Internals, stored = new Set<string>();
	const hooks: { tokenize?: (n: number) => void | Promise<void>; embedQuery?: () => void; failTokenizeAt: number } = { failTokenizeAt: 0 };
	let tokenizations = 0, permitted = true;
	internal.runtime = async () => ({ call: async (op: string, input: { action?: string; keys?: string[]; rows?: Unit[]; texts?: string[]; kind?: string }) => {
		if (op === 'tokenize') { tokenizations++; await hooks.tokenize?.(tokenizations); if (tokenizations === hooks.failTokenizeAt) throw new Error('interrupted enumeration'); return { ranges: [[{ start: 0, end: input.texts![0]!.length }]] }; }
		if (op === 'embed') { if (input.kind === 'query') hooks.embedQuery?.(); return { vectors: input.texts!.map(() => [1]) }; }
		if (op === 'index') {
			if (input.action === 'reconcile') for (const key of stored) if (!input.keys!.includes(key)) stored.delete(key);
			if (input.action === 'upsert') for (const row of input.rows!) stored.add(row.key);
			if (input.action === 'status') return { coveredKeys: input.keys!.filter(key => stored.has(key)) };
			if (input.action === 'score') { const found = internal.current!.units.filter(unit => input.keys!.includes(unit.key) && stored.has(unit.key)); return { ranked: found.slice(0, 24).map(unit => ({ key: unit.key, score: 1 })), observed: found.length }; }
			return {};
		}
		throw new Error('unexpected RPC');
	} });
	const manager = SessionManager.inMemory(project), ctx = ctxOf(manager, project);
	const access = () => { if (!permitted) throw new Error('Access revoked'); };
	// Every snapshot handed to the controller has its sources frozen, so any write to them by prepare or search throws.
	const provider = () => { const snapshot = kind === 'memo' ? memoizedEligibleSources(ctx, policy, access) : reference(ctx, policy ?? {}, access); deepFreeze(snapshot.sources); return snapshot; };
	const append = (text: string) => manager.appendMessage(user(text, 1));
	return { c, internal, manager, ctx, provider, append, hooks, stored, revoke: () => { permitted = false; }, get tokenizations() { return tokenizations; }, set tokenizations(n: number) { tokenizations = n; } };
}
const keysOf = (snapshot: Snapshot) => snapshot.units.map(unit => unit.key);
// A compact-all cut after the sources: they are out of view, so a search waits for them. With nothing out of view a search does not wait for indexing, and these tests are about the search itself.
const compactAll = (m: SessionManager) => m.appendCompaction('summary of what was cut', 'no-such-entry', 100, undefined, true);

test('a completed prepare publishes a snapshot, and a later hit hands out empty units and incomplete', async () => {
	const f = fixture();
	for (let i = 0; i < 5; i++) f.append('source ' + i);
	await f.internal.prepare(f.provider);
	const published = f.internal.current!;
	expect(published.complete).toBe(true);
	expect(published.units).toHaveLength(5);
	const hit = f.provider();
	expect(hit).not.toBe(published);
	expect(hit.id).toBe(published.id);
	expect(hit.units).toEqual([]);
	expect(hit.complete).toBe(false);
	expect(published.units).toHaveLength(5); // the published snapshot was not touched by the hit
	expect(hit.sources).toBe(published.sources);
});

test('an injected tokenization failure after k units, retried at the same stamp, ends with exactly the full units and no duplicate keys', async () => {
	const f = fixture();
	for (let i = 0; i < 6; i++) f.append('source ' + i);
	f.hooks.failTokenizeAt = 4;
	await expect(f.internal.prepare(f.provider)).rejects.toThrow('interrupted enumeration');
	expect(f.internal.current).toBeUndefined();
	f.hooks.failTokenizeAt = 0;
	await f.internal.prepare(f.provider);
	const current = f.internal.current!;
	expect(current.units).toHaveLength(6);
	expect(new Set(keysOf(current)).size).toBe(6);
	expect(f.c.status().indexingComplete).toBe(true);
	expect(f.c.status().coveredUnits).toBe(6);
});

test('a prepare aborted by a generation change after k units, retried at the same stamp, ends with exactly the full units and no duplicate keys', async () => {
	const f = fixture();
	for (let i = 0; i < 6; i++) f.append('source ' + i);
	let release!: () => void;
	const gate = new Promise<void>(done => { release = done; });
	f.hooks.tokenize = async n => { if (n === 4) await gate; };
	const running = f.internal.prepare(f.provider), settled = running.then(() => 'done', error => String(error?.name ?? error));
	while (f.tokenizations < 4) await new Promise(done => setTimeout(done, 2));
	await f.c.disable(false); // the generation changes while the fourth source is being enumerated
	release();
	expect(await settled).toBe('AbortError');
	await new Promise(done => setTimeout(done, 5));
	f.hooks.tokenize = undefined;
	f.c.enable();
	await f.internal.prepare(f.provider);
	const current = f.internal.current!;
	expect(current.units).toHaveLength(6);
	expect(new Set(keysOf(current)).size).toBe(6);
	expect(current.complete).toBe(true);
});

test('a disable and enable at the same stamp re-prepares from empty units: nothing stale is complete', async () => {
	const f = fixture();
	for (let i = 0; i < 4; i++) f.append('source ' + i);
	await f.internal.prepare(f.provider);
	expect(f.internal.current!.complete).toBe(true);
	await f.c.disable(false);
	await new Promise(done => setTimeout(done, 5));
	f.c.enable();
	f.hooks.failTokenizeAt = f.tokenizations + 3; // fail while the new plan is half built: a stale complete snapshot would hide it
	await expect(f.internal.prepare(f.provider)).rejects.toThrow('interrupted enumeration');
	expect(f.internal.current).toBeUndefined();
	expect(f.provider().complete).toBe(false);
	f.hooks.failTokenizeAt = 0;
	await f.internal.prepare(f.provider);
	expect(f.internal.current!.units).toHaveLength(4);
	expect(new Set(keysOf(f.internal.current!)).size).toBe(4);
});

test('a full prepare and search over frozen sources writes to none of them', async () => {
	const f = fixture();
	for (let i = 0; i < 7; i++) f.append('evidence ' + i); compactAll(f.manager);
	await f.internal.prepare(f.provider);
	const page = await f.c.search('evidence', f.provider);
	expect(page.status).toBe('ok');
	expect(f.provider().sources.every(source => Object.isFrozen(source) && Object.isFrozen(source.ranges) && Object.isFrozen(source.row))).toBe(true);
	f.append('one more');
	await f.internal.prepare(f.provider); // a prepare that reuses the earlier plan's frozen sources
	expect(f.internal.current!.units).toHaveLength(8);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// EG2-ON: a plan takes its window and coverage from the snapshot it is given (`viewStart` puts the conversation a cut removed from view first).
// `tuck_search` calls the provider before it calls `search`, so the controller's own bind is usually a hit.

function cutSession(f: ReturnType<typeof fixture>) {
	f.append('older conversation 0');
	f.manager.appendMessage(toolResult('call-0', 'older tool output', 2));
	f.append('older conversation 1');
	f.append('older conversation 2');
	const firstKept = f.append('kept conversation 3');
	f.append('kept conversation 4');
	f.manager.appendCompaction('summary of what was cut', firstKept, 100, undefined, true);
	for (let i = 0; i < 3; i++) f.append('in view ' + i);
}
async function planFrom(kind: 'memo' | 'plain', warm: boolean) {
	const f = fixture(kind);
	cutSession(f);
	if (warm) f.provider();
	await f.internal.prepare(f.provider);
	const page = await f.c.search('older', f.provider), window = f.c.status().window!;
	const branch = f.manager.getBranch(); // entry ids differ between the sessions: compare positions
	return { viewStart: f.internal.current!.viewStart, window: { ...window, oldestCoveredEntryId: branch.findIndex(e => e.id === window.oldestCoveredEntryId) }, status: page.status, notice: page.notice };
}
test('after a compaction cut, the window and coverage of a plan built on a cache hit equal those of a direct build', async () => {
	const direct = await planFrom('plain', true), miss = await planFrom('memo', false), hit = await planFrom('memo', true);
	// The comparison is not vacuous: something is out of view, conversation and tool output both, and the notice says how much.
	expect(direct.viewStart).toBeGreaterThan(0);
	expect(direct.window.outOfViewCharacters).toBeGreaterThan(0);
	expect(direct.window.conversation.outOfViewCharacters).toBeGreaterThan(0);
	expect(direct.window.toolResults.outOfViewCharacters).toBeGreaterThan(0);
	expect(direct.status).toBe('ok');
	expect(direct.notice).toContain(`covers ${direct.window.conversation.indexedCharacters} of ${direct.window.conversation.outOfViewCharacters} characters of earlier conversation`);
	expect(miss).toEqual(direct);
	expect(hit).toEqual(direct);
});

// Every field of a snapshot is either stored (what the build derives from the session) or per call (what the controller fills). The two lists are
// asserted exactly, so a field added to the snapshot and present in this scenario (a prepared plan after a cut), required or optional, fails here
// until someone classifies it. An optional field set only on another path would not appear here.
const STORED = ['id', 'project', 'session', 'sources', 'throughEntryId', 'viewStart'], PER_CALL = ['complete', 'indexed', 'units', 'window'];
test('every field of a snapshot is classified: stored fields equal a direct build, per-call fields start fresh, and an unlisted field fails here', async () => {
	const f = fixture();
	cutSession(f);
	await f.internal.prepare(f.provider); // the first provider() call is a miss: prepare fills units, indexed, complete and window on that very object
	const plan = f.internal.current! as unknown as Record<string, unknown>;
	expect(Object.keys(plan).sort()).toEqual([...STORED, ...PER_CALL].sort());
	const hit = f.provider() as unknown as Record<string, unknown>, direct = reference(f.ctx, {}, quiet) as unknown as Record<string, unknown>;
	expect(Object.keys(direct).filter(key => !PER_CALL.includes(key)).sort()).toEqual([...STORED].sort());
	for (const key of Object.keys(direct)) if (!PER_CALL.includes(key)) expect(hit[key], `stored field ${key}`).toStrictEqual(direct[key]);
	expect(Object.keys(hit).sort()).toEqual(Object.keys(direct).sort()); // no window, nothing extra
	for (const key of PER_CALL) expect(hit[key], `per-call field ${key}`).not.toBe(plan[key]);
	expect(hit.units).toEqual([]);
	expect(hit.complete).toBe(false);
	expect((hit.indexed as Set<string>).size).toBe(0);
	expect('window' in hit).toBe(false);
	expect(plan.window).toBeDefined(); // prepare did assign one to the plan, and it did not reach the hit
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Access revoked mid-operation aborts at the next provider call, with SemanticAccessError. The history never changes, so every
// provider call after the first is a cache hit.

test('access revoked mid-prepare aborts the prepare at the next provider call, on a cache hit', async () => {
	const f = fixture();
	for (let i = 0; i < 5; i++) f.append('source ' + i);
	f.hooks.tokenize = n => { if (n === 2) f.revoke(); };
	const start = rebuilds();
	const error = await f.internal.prepare(f.provider).then(() => undefined, e => e as Error);
	expect(error?.name).toBe('SemanticAccessError');
	expect(error?.message).toBe('Access revoked');
	expect(rebuilds()).toBe(start + 1); // only the first bind built anything
	expect(f.internal.current).toBeUndefined();
});

test('access revoked mid-search aborts the search with SemanticAccessError and disables the controller', async () => {
	const f = fixture();
	for (let i = 0; i < 5; i++) f.append('source ' + i); compactAll(f.manager);
	await f.internal.prepare(f.provider);
	f.hooks.embedQuery = () => f.revoke();
	const start = rebuilds();
	const error = await f.c.search('source', f.provider).then(() => undefined, e => e as Error);
	expect(error?.name).toBe('SemanticAccessError');
	expect(rebuilds()).toBe(start); // the whole search ran on hits
	expect(f.c.status()).toMatchObject({ enabled: false, state: 'disabled', lastError: 'Access revoked' });
});

// A revocation that stops recall keeps its reason, so a host never sees it as recall that was never switched on.
test.each([
	['a search binding its snapshot', (f: ReturnType<typeof fixture>) => f.c.search('source', f.provider)],
	['a wait for readiness', (f: ReturnType<typeof fixture>) => f.c.waitForReady(3000)],
])('access revoked before %s disables the controller and records why', async (_name, call) => {
	const f = fixture();
	for (let i = 0; i < 3; i++) f.append('source ' + i);
	await f.internal.prepare(f.provider);
	f.c.schedule(f.provider);
	f.revoke();
	const error = await call(f).then(() => undefined, e => e as Error);
	expect(error?.name).toBe('SemanticAccessError');
	expect(f.c.status()).toMatchObject({ enabled: false, state: 'disabled', lastError: 'Access revoked' });
});

test('access revoked on a scheduled preparation disables the controller', async () => {
	const f = fixture();
	for (let i = 0; i < 3; i++) f.append('source ' + i);
	f.hooks.tokenize = n => { if (n === 2) f.revoke(); };
	f.c.schedule(f.provider); // lazy start: a session that has not searched starts nothing
	await f.c.waitForReady(3000); // waiting for readiness is demand: the scheduled preparation starts, and loses access in the middle
	await vi.waitFor(() => expect(f.c.status().enabled).toBe(false));
	expect(f.c.status().lastError).toBe('Access revoked');
});

// I4 through the production wiring: the provider `installCompaction` gives the controller must carry the host's `assertAccess`, or a revocation
// during an await is not seen at the controller's next provider call.
async function installed(f: ReturnType<typeof fixture>, assertAccess: () => void) {
	const handlers: Record<string, ((event: unknown, ctx: unknown) => unknown)[]> = {};
	let tool: ToolDefinition | undefined;
	const pi = { on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { (handlers[name] ??= []).push(handler); }, registerCommand: () => {}, registerTool: (t: ToolDefinition) => { if (t.name === 'tuck_search') tool = t; } } as unknown as ExtensionAPI;
	const handle = await installCompaction(pi, { semanticRecall: f.c, assertAccess });
	const ctx = { cwd: f.ctx.cwd, sessionManager: f.manager, ui: { notify: () => {} } } as unknown as ExtensionToolContext;
	return { handle, handlers, ctx, search: () => tool!.execute('t13', { query: 'source' }, undefined, undefined, ctx) };
}
test('through installCompaction: assertAccess revoked while tuck_search awaits the query embedding aborts the controller with SemanticAccessError', async () => {
	const f = fixture();
	for (let i = 0; i < 4; i++) f.append('source ' + i); compactAll(f.manager);
	await f.internal.prepare(f.provider);
	let allowed = true;
	const w = await installed(f, () => { if (!allowed) throw new Error('Access revoked'); });
	f.hooks.embedQuery = () => { allowed = false; };
	const error = await Promise.resolve(w.search()).then(() => undefined, e => e as Error);
	expect(error?.name).toBe('SemanticAccessError');
	expect(f.c.status().enabled).toBe(false);
	await w.handle.close();
});
test('through installCompaction: assertAccess revoked in the middle of a scheduled preparation disables the controller', async () => {
	const f = fixture();
	for (let i = 0; i < 4; i++) f.append('source ' + i);
	let allowed = true;
	const w = await installed(f, () => { if (!allowed) throw new Error('Access revoked'); });
	f.hooks.tokenize = n => { if (n === 2) allowed = false; };
	for (const handler of w.handlers.session_compact ?? []) handler({ type: 'session_compact' }, w.ctx); // the package hands the controller its production provider
	await f.c.waitForReady(3000); // demand: the lazy start begins the preparation with that provider
	await vi.waitFor(() => expect(f.c.status().enabled).toBe(false));
	expect(f.c.status().lastError).toBe('Access revoked');
	await w.handle.close();
});

// ---------------------------------------------------------------------------------------------------------------------------------
// A `host.input` appended mid-search invalidates the search, exactly as a direct build does.

const HOST_POLICY: RecallPolicy = { privateCustomTypes: ['host.input'] };
async function midSearch(kind: 'memo' | 'plain') {
	const f = fixture(kind, HOST_POLICY);
	for (let i = 0; i < 4; i++) f.append('source ' + i); compactAll(f.manager);
	await f.internal.prepare(f.provider);
	f.hooks.embedQuery = () => { f.manager.appendCustomEntry('host.input', { text: 'input appended while the query is being embedded' }); };
	const page = await f.c.search('source', f.provider);
	return { status: page.status, notice: page.notice, groups: page.groups };
}
test('a host.input appended mid-search invalidates the controller search, and the page is the one a direct build gives', async () => {
	const memo = await midSearch('memo'), plain = await midSearch('plain');
	expect(memo.status).toBe('unavailable');
	expect(memo.notice).toContain('Eligible branch or source changed before semantic admission');
	expect(memo.groups).toEqual([]);
	expect(memo).toEqual(plain);
});

async function toolFixture(policy: RecallPolicy | undefined, during: (m: SessionManager) => void, setup?: (m: SessionManager) => void) {
	const root = mkdtempSync(join(tmpdir(), 'eligibility-cache-')); roots.push(root);
	const m = SessionManager.inMemory(CWD);
	if (setup) setup(m);
	else {
		m.appendMessage(user('Eligible ordinary history for the search tool.', 1));
		m.appendMessage(user('More eligible history for the search tool.', 2));
		compactAll(m); // out of view, so the search waits for the indexed window
	}
	const ctx = { cwd: CWD, sessionManager: m } as unknown as ExtensionToolContext;
	const initial = reference(ctx, policy ?? {}, quiet);
	initial.complete = true;
	initial.units = initial.sources.map((source, i) => ({ source, key: String(i), entryId: source.entry.id, start: 0, end: source.sourceText.length, encoded: source.sourceText, inputSha: source.sha }));
	initial.indexed = new Set(initial.units.map(unit => unit.key));
	initial.window = { order: initial.sources, counts: initial.sources.map(() => 1), searchUnits: 0, windowCharacters: 0, eligibleCharacters: 0, conversationOutOfView: 0, toolOutOfView: 0 };
	const semantic = createSemanticRecall({ pythonPath: '/unused', runtimeRoot: join(root, 'runtime'), indexDirectory: join(root, 'index') }) as unknown as { enabled: boolean; current: Snapshot; runtime: unknown; index: unknown; close(): Promise<void> };
	semantic.enabled = true; semantic.current = initial;
	semantic.runtime = async () => ({ call: async () => { during(m); return { vectors: [[1]] }; } });
	semantic.index = async () => ({ ranked: initial.units.slice(0, 24).map(u => ({ key: u.key, score: 1 })), observed: initial.units.length });
	let tool: ToolDefinition | undefined;
	const pi = { on: () => {}, registerCommand: () => {}, registerTool: (t: ToolDefinition) => { if (t.name === 'tuck_search') tool = t; } } as unknown as ExtensionAPI;
	const handle = await installCompaction(pi, { semanticRecall: semantic as never, ...(policy ? { recallPolicy: policy } : {}) });
	return { run: () => tool!.execute('t13', { query: 'history' }, undefined, undefined, ctx), close: async () => { await handle.close(); await semantic.close(); }, m };
}

test('through tuck_search: a host.input appended mid-search invalidates the search, as it did before the cache', async () => {
	const t = await toolFixture(HOST_POLICY, m => { if (m.getEntries().every(e => e.type !== 'custom')) m.appendCustomEntry('host.input', { text: 'input' }); });
	try {
		const result = await t.run();
		expect(result.isError).toBe(true);
		const blocks = result.content.filter(b => b.type === 'text').map(b => b.text!);
		expect(blocks).toHaveLength(1);
		expect(JSON.parse(blocks[0]!).status).toBe('snapshot_invalidated');
	} finally { await t.close(); }
});

test('through tuck_search: on an unchanged session the whole search builds the snapshot once; the provider is the memoized one', async () => {
	const t = await toolFixture(undefined, () => {});
	try {
		const start = rebuilds(), result = await t.run();
		expect(result.isError).not.toBe(true);
		expect(JSON.parse(result.content.filter(b => b.type === 'text').map(b => b.text!)[1]!).status).toBe('ok');
		expect(rebuilds() - start).toBe(1);
	} finally { await t.close(); }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Timing on a synthetic session of about 3,400 entries.

test('timing on a session of about 3,400 entries: a hit costs a small fraction of a rebuild', () => {
	const m = SessionManager.inMemory(CWD), ctx = ctxOf(m);
	const first = m.appendMessage(user('opening request', 1));
	for (let i = 1; i < 3400; i++) {
		const big = i % 20 === 0 ? 'bulk output line. '.repeat(1100) : 'ordinary working text. '.repeat(20);
		if (i % 4 === 1) m.appendMessage(user(`request ${i} ` + big, i));
		else if (i % 4 === 2) m.appendMessage(assistant(`answer ${i} ` + big, i));
		else if (i % 4 === 3) m.appendMessage(toolResult(`call-${i}`, `result ${i} ` + big, i));
		else m.appendCustomEntry(i % 8 === 0 ? 'host.input' : 'other.note', { i });
		if (i % 400 === 0) m.appendContextEdit(first, null);
	}
	const policy: RecallPolicy = { privateCustomTypes: ['host.input'] };
	const entries = m.getEntryCount();
	expect(entries).toBeGreaterThan(3300);
	memoizedEligibleSources(ctx, policy, quiet); // warm the JIT on a throwaway build
	const misses: number[] = [], hits: number[] = [];
	for (let i = 0; i < 3; i++) {
		m.appendMessage(user('a new request ' + i, 9000 + i));
		const a = performance.now(); memoizedEligibleSources(ctx, policy, quiet); misses.push(performance.now() - a);
	}
	for (let i = 0; i < 200; i++) { const a = performance.now(); memoizedEligibleSources(ctx, policy, quiet); hits.push(performance.now() - a); }
	const median = (values: number[]) => [...values].sort((x, y) => x - y)[Math.floor(values.length / 2)]!;
	const miss = median(misses), hit = median(hits);
	console.log(`timing at ${entries} entries: miss ${miss.toFixed(2)} ms (median of ${misses.length}), hit ${hit.toFixed(3)} ms (median of ${hits.length}), ratio ${(miss / hit).toFixed(0)}x`);
	expect(hit).toBeLessThan(5);
	expect(hit * 20).toBeLessThan(miss);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The pin: the key is sound only while appended entries are never changed in place. Every appended entry is deep-frozen, and a REAL Pi session
// is driven through tool calls, a retry, a compaction cut, a context_edit and custom entries of the kind a host writes. Any in-place write then throws.

function pin(manager: SessionManager) {
	const internal = manager as unknown as { _appendEntry(entry: unknown): void; fileEntries: unknown[] };
	for (const entry of internal.fileEntries) deepFreeze(entry);
	const append = internal._appendEntry.bind(manager);
	internal._appendEntry = entry => { append(entry); deepFreeze(entry); };
}

test('the pin has teeth: a frozen appended entry rejects an in-place edit', () => {
	const m = SessionManager.inMemory(CWD);
	pin(m);
	const entry = m.getEntry(m.appendMessage(user('original', 1)))! as unknown as { parentId: string | null; message: { content: string } };
	expect(() => { entry.message.content = 'edited'; }).toThrow(TypeError);
	expect(() => { entry.parentId = 'forged'; }).toThrow(TypeError);
	const custom = m.getEntry(m.appendCustomEntry('host.input', { text: 'x' }))! as unknown as { data: { text: string } };
	expect(() => { custom.data.text = 'edited'; }).toThrow(TypeError);
});

const PIN_POLICY: RecallPolicy = { privateCustomTypes: ['host.input', 'host.attempt'] };
const real = [
	{ name: 'a provider overflow: Pi cuts through the package and retries', overflow: true },
	{ name: 'a tool boundary: Pi calls a tool and the package cuts there', overflow: false },
];
for (const { name, overflow } of real)
test(`a real Pi session writes nothing in place: ${name}`, async () => {
	// Pi swallows an exception thrown by an extension handler and reports it to the runner's error listener, so every handler's result is recorded
	// here and asserted afterwards; the boundary hook also uses the cache on Pi's own context object in the middle of the run.
	const boundaries: ExtensionContext[] = [], disagreements: string[] = [], misses: number[] = [];
	const onBoundary = (_event: unknown, ctx: ExtensionContext) => {
		boundaries.push(ctx);
		const first = memoizedEligibleSources(ctx, PIN_POLICY, quiet), before = rebuilds(), again = memoizedEligibleSources(ctx, PIN_POLICY, quiet);
		misses.push(rebuilds() - before);
		if (first.id !== reference(ctx, PIN_POLICY, quiet).id || again.id !== first.id) disagreements.push(first.id);
	};
	const h = await harness(overflow
		? { at: 'prompt', complete: 60000, host: HOST, reserveTokens: 0, compaction: EXACT_RESERVE, replies: ['overflow'] }
		: { at: 'tool', complete: BAND + 100, host: HOST, onBoundary });
	try {
		pin(h.manager);
		const swallowed: string[] = [];
		h.session.extensionRunner.onError(error => { swallowed.push(JSON.stringify(error)); });
		const ctx = { cwd: h.dir, sessionManager: h.manager };
		const check = () => expect(memoizedEligibleSources(ctx, PIN_POLICY, quiet).id).toBe(reference(ctx, PIN_POLICY, quiet).id);
		const stamp = () => JSON.stringify(eligibilityKey(ctx));
		check();
		const r = await h.run();
		expect(r.faults, r.probe).toEqual([]);
		expect(swallowed).toEqual([]);
		expect(r.cuts, r.probe).toBe(1);
		if (overflow) expect(r.requests, r.probe).toBe(2);
		else {
			expect(r.effects, r.probe).toBeGreaterThanOrEqual(1);
			expect(boundaries.length).toBeGreaterThan(0);
			for (const boundary of boundaries) expect(boundary.sessionManager).toBe(h.manager); // the object Pi hands the package is the one the cache is keyed by
			expect(misses.every(n => n === 0)).toBe(true); // the second call at a boundary was a hit
			expect(disagreements).toEqual([]);
		}
		check();
		// Writes of the kind a host makes: a context_edit, then custom entries; each must change the stamp and agree with a full build.
		const target = h.manager.getBranch().find(e => e.type === 'message' && e.message.role === 'user')!;
		for (const write of [
			() => h.manager.appendContextEdit(target.id, null),
			() => h.manager.appendCustomEntry('host.input', { text: 'input' }),
			() => h.manager.appendCustomEntry('host.attempt', { attemptId: 'a1' }),
			() => h.manager.appendCustomMessageEntry('host.input', 'a private message', false),
		]) { const before = stamp(); write(); expect(stamp()).not.toBe(before); check(); }
		// A further turn over the edited session, with frozen entries.
		await h.session.prompt('Continue after the edit');
		expect(h.faults).toEqual([]);
		expect(swallowed).toEqual([]);
		check();
		expect(h.manager.getEntries().every(e => Object.isFrozen(e))).toBe(true);
	} finally { await h.cleanup(); }
}, 120000);

// ---------------------------------------------------------------------------------------------------------------------------------
// `tuck_search` runs its lexical pass again after the await only when `eligibilityKey` moved. The semantic snapshot id check is unchanged, and a moved key alone
// invalidates nothing. In-place edits of recorded entries and a policy whose behaviour changes after install are outside this contract (see eligibility-cache.ts).
const text = (result: { content: { type: string; text?: string }[] }) => result.content.filter(b => b.type === 'text').map(b => b.text!);
async function invalidatedBy(during: (m: SessionManager) => void, setup?: (m: SessionManager) => void) {
	const t = await toolFixture(undefined, during, setup);
	try {
		const result = await t.run(), blocks = text(result);
		return { isError: result.isError, blocks, status: JSON.parse(blocks[0]!).status };
	} finally { await t.close(); }
}
test('through tuck_search: an entry appended during the await invalidates the search', async () => {
	const r = await invalidatedBy(m => { if (m.getEntries().length < 4) m.appendMessage(user('history appended while the query is being embedded', 9)); });
	expect(r.isError).toBe(true); expect(r.blocks).toHaveLength(1); expect(r.status).toBe('snapshot_invalidated');
});
test('through tuck_search: a leaf switch to a sibling of the same depth during the await invalidates the search', async () => {
	let first = '';
	const r = await invalidatedBy(m => { m.branch(first); }, m => {
		m.appendMessage(user('Eligible ordinary history for the search tool.', 1)); compactAll(m);
		const base = m.getLeafId()!;
		first = m.appendMessage(user('First sibling history for the search tool.', 2)); m.branch(base);
		m.appendMessage(user('Second sibling history for the search tool.', 3)); // the leaf the search starts from
	});
	expect(r.isError).toBe(true); expect(r.blocks).toHaveLength(1); expect(r.status).toBe('snapshot_invalidated');
});
test('through tuck_search: with an equal key the lexical pass runs once, and the page carries the first pass', async () => {
	const t = await toolFixture(undefined, () => {});
	try {
		const start = lexicalPasses(), result = await t.run();
		expect(result.isError).not.toBe(true);
		expect(lexicalPasses() - start).toBe(1);
		expect(JSON.parse(text(result)[1]!).status).toBe('ok');
	} finally { await t.close(); }
});
test('through tuck_search: a moved key with the same branch (an entry added on another branch) runs the second lexical pass and invalidates nothing', async () => {
	const t = await toolFixture(undefined, m => {
		if (m.getEntries().length > 3) return;
		const leaf = m.getLeafId()!; m.branch(m.getBranch()[0]!.id); m.appendMessage(user('a message on another branch', 9)); m.branch(leaf);
	});
	try {
		const unmoved = JSON.stringify(actualTuck.tuckRecall(actualTuck.tuck, t.m.getEntries(), t.m.getBranch(), { query: 'history' })); // the words of a run with no off-branch append
		const start = lexicalPasses(), result = await t.run();
		expect(result.isError).not.toBe(true);
		expect(lexicalPasses() - start).toBe(2);
		expect(text(result)[0]).toBe(unmoved);
		expect(JSON.parse(text(result)[1]!).status).toBe('ok');
	} finally { await t.close(); }
});
