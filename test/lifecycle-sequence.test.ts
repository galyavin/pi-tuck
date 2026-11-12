import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from 'vitest';
import type { Context } from '@earendil-works/pi-ai';
import { appendOnlyPair, emptyAppendOnlyCoverage, emptyCoverage, inputPresence, runSequence, type Event } from './lifecycle-sequence-fixture';

test('append-only comparison sees provider prompts, tools and whole messages while ignoring message timestamps', () => {
  const tool = { name: 'effect', description: 'Effect', parameters: { type: 'object', properties: { timestamp: { type: 'number' } } } };
  const a: Context = { systemPrompt: 'Stable host', tools: [tool], messages: [
    { role: 'user', content: 'Old input', timestamp: 1 },
    { role: 'assistant', content: [{ type: 'toolCall', id: 'old-call', name: 'effect', arguments: { timestamp: 1 } }],
      api: 'openai-responses', provider: 'openai', model: 'fixture', stopReason: 'toolUse', timestamp: 2,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
  ] };
  const b = structuredClone(a);
  b.messages.forEach(message => { message.timestamp += 100; });
  b.messages.push({ role: 'user', content: 'New input', timestamp: 200 });
  expect(appendOnlyPair(a, b)).toEqual({});
  for (const mutate of [
    (context: Context) => { context.systemPrompt += ' changed'; },
    (context: Context) => { context.tools![0].description += ' changed'; },
    (context: Context) => { context.messages.reverse(); },
    (context: Context) => { context.messages.splice(0, 1); },
    (context: Context) => {
      const message = context.messages[1];
      if (message.role === 'assistant' && message.content[0].type === 'toolCall') message.content[0].arguments.timestamp = 2;
    },
  ]) {
    const changed = structuredClone(b);
    mutate(changed);
    expect(appendOnlyPair(a, changed).difference).toBeDefined();
  }
  const firstCut = structuredClone(b);
  firstCut.tools!.push(...['tuck_recall', 'tuck_search'].map(name => ({ ...tool, name })));
  expect(appendOnlyPair(a, firstCut)).toEqual({ exempt: 'historyTools' });
  firstCut.messages[0].content = 'Edited old input';
  expect(appendOnlyPair(a, firstCut).difference).toBeDefined();
  const summary = 'The conversation history before this point was compacted into the following summary:\n\n<summary>\nSaved or pending cut\n</summary>';
  const cut: Context = { ...b, messages: [{ role: 'user', content: summary, timestamp: 0 }, ...b.messages.slice(1)] };
  expect(appendOnlyPair(a, cut)).toEqual({ exempt: 'summary' });
  expect(appendOnlyPair(cut, a).difference).toBeDefined();
  const sameCut = structuredClone(cut);
  sameCut.messages[1].content = [];
  expect(appendOnlyPair(cut, sameCut).difference).toBeDefined();
});

for (const version of [1, 2]) test(`prompt preservation accepts whole decoded quotes, never partial quotes (transcript v${version})`, () => {
  const prompt = 'Need "the whole task"\nC:\\task\rEND';
  const request = (text: string): Context => ({ messages: [{ role: 'user', content: [{ type: 'text', text }], timestamp: 0 }] });
  const summary = (text: string, role = 'user', kind = 'excerpt') => {
    const escaped = text.replace(/[\\\n\r]/g, c => c === '\\' ? '\\\\' : c === '\n' ? '\\n' : '\\r');
    const record = version === 1 ? JSON.stringify({ kind, role, text })
      : `#4 ${role}${kind === 'omission' ? ' omitted' : ''} @2026-11-10T14:00:00Z: ${escaped}`;
    return request(`The conversation history before this point was compacted into the following summary:\n\n<summary>\nTUCK-TRANSCRIPT/${version}\n${record}\n\n---\n\nContinue.\n</summary>`);
  };
  expect(inputPresence(request(`Packet\n${prompt}\nDone`), prompt)).toBe('original');
  expect(inputPresence(summary(prompt), prompt)).toBe('quote');
  expect(inputPresence(summary(prompt, 'custom'), prompt, 'custom')).toBe('quote');
  expect(inputPresence(summary(prompt, 'custom'), prompt)).toBeUndefined();
  expect(inputPresence(summary(prompt.slice(0, -1)), prompt)).toBeUndefined();
  expect(inputPresence(summary(JSON.stringify(prompt)), prompt)).toBeUndefined();
  expect(inputPresence(summary(prompt, 'assistant'), prompt)).toBeUndefined();
  expect(inputPresence(summary(prompt, 'user', 'omission'), prompt)).toBeUndefined();
});

// Mulberry32; all choices (including resolved tree positions) are reproducible.
function random(seed: number) {
  return () => {
    let t = seed += 0x6d2b79f5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function sequence(seed: number): Event[] {
  const rng = random(seed), pick = (n: number) => Math.floor(rng() * n);
  const shuffled = <T>(values: T[]): T[] => {
    for (let i = values.length - 1; i > 0; i--) { const j = pick(i + 1); [values[i], values[j]] = [values[j], values[i]]; }
    return values;
  };
  // Stratify transitions as well as individual events. Independent random
  // letters almost never hit a handled input followed by a custom run while
  // enough history survives to make a pending cut. Both motifs run for EVERY
  // seed; seed selection cannot hide the old regression.
  const motifs: Event[][] = [
    [{ kind: 'new' }, { kind: 'handled', tokens: 7000 + pick(2000) }, { kind: 'custom', tokens: 100 + pick(200), scenario: 'handled-custom' }],
    [{ kind: 'new' }, { kind: 'handled', tokens: 7000 + pick(2000) }, { kind: 'tree', target: 3 + pick(5) }, { kind: 'custom', tokens: 100 + pick(200), scenario: 'handled-tree-custom' }],
    [{ kind: 'new' }, { kind: 'prompt', tokens: 3500 + pick(2500) }, { kind: 'tools', tokens: 200 + pick(300), rounds: 4 + pick(3), resultTokens: 6500 + pick(1500) }],
    [{ kind: 'new' }, { kind: 'abort', tokens: 4000 + pick(1500) }, { kind: 'prompt', tokens: 200 }, { kind: 'compact' }, { kind: 'custom', tokens: 200, rounds: 2 }],
    [{ kind: 'new' }, { kind: 'semantic', enabled: true }, { kind: 'semantic', enabled: false }, { kind: 'prompt', tokens: 2500 }],
  ];
  const kinds = ['prompt', 'handled', 'custom', 'tools', 'tree', 'new', 'compact', 'abort'] as const;
  const noise: Event[] = Array.from({ length: 8 }, () => {
    const kind = kinds[pick(kinds.length)];
    const tokens = kind === 'handled' ? 8000 : 500 + pick(5000);
    return { kind, tokens: ['prompt', 'handled', 'custom', 'tools', 'abort'].includes(kind) ? tokens : undefined, target: pick(30),
      rounds: kind === 'tools' ? 3 + pick(4) : kind === 'custom' ? pick(3) : 0, resultTokens: 6000 + pick(2000) };
  });
  return [...shuffled(motifs).flat(), ...noise];
}

function positiveInteger(name: string, fallback: number) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function seeds(): number[] {
  if (process.env.LIFECYCLE_SEED !== undefined) {
    const seed = Number(process.env.LIFECYCLE_SEED);
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('LIFECYCLE_SEED must be a uint32 (decimal or 0x hexadecimal)');
    return [seed];
  }
  return [0, ...Array.from({ length: positiveInteger('LIFECYCLE_SEEDS', 3) }, (_, i) => (0x51ec7a11 + Math.imul(i, 0x9e3779b9)) >>> 0)];
}

test('seeded real-Pi lifecycle sequences preserve a single branch-local view', { timeout: 300000 }, async () => {
  const started = Date.now(), chosen = seeds(), failures: string[] = [], coverage = emptyCoverage(), appendOnly = emptyAppendOnlyCoverage();
  const scratch = mkdtempSync(join(tmpdir(), 'pi-tuck-lifecycle-'));
  const agentDir = mkdtempSync(join(scratch, 'lifecycle-agent-'));
  const previousTmp = process.env.TMPDIR, previousAgent = process.env.PI_CODING_AGENT_DIR;
  process.env.TMPDIR = scratch;
  process.env.PI_CODING_AGENT_DIR = agentDir; // no installed runtime, no user's settings
  try {
    for (const seed of chosen) {
      const events = sequence(seed), result = await runSequence(seed, events);
      for (const key of Object.keys(coverage) as (keyof typeof coverage)[]) coverage[key] += result.coverage[key];
      appendOnly.checked += result.appendOnly.checked;
      for (const reason of Object.keys(appendOnly.exempt) as (keyof typeof appendOnly.exempt)[]) appendOnly.exempt[reason] += result.appendOnly.exempt[reason];
      // Every invariant is evaluated after EVERY event, so the earliest failing
      // event gives an exhaustive prefix shrink, without assuming failures are
      // monotone across different orders. Replay that shortest prefix as proof.
      const firstByInvariant = new Map<string, (typeof result.findings)[number]>();
      for (const finding of result.findings) {
        const key = `${finding.invariant}:${finding.check}:${finding.scenario ?? 'any'}`;
        if (!firstByInvariant.has(key)) firstByInvariant.set(key, finding);
      }
      const replayed = new Map<number, Awaited<ReturnType<typeof runSequence>>>();
      for (const first of firstByInvariant.values()) {
        const invariant = first.invariant;
        const prefix = events.slice(0, first.at + 1);
        if (!replayed.has(prefix.length)) replayed.set(prefix.length, await runSequence(seed, prefix));
        const replay = replayed.get(prefix.length)!;
        const reproduced = replay.findings.some(f => f.invariant === invariant && f.check === first.check && f.at === first.at);
        const message = `seed=${seed} invariant=${invariant} check=${first.check}${first.scenario ? ` scenario=${first.scenario}` : ''} shortest failing prefix=${prefix.length}/${events.length}${reproduced ? ' (replayed)' : ' (DID NOT REPLAY)'}\n`
          + result.trace.slice(0, prefix.length).join(' -> ') + '\n' + first.message;
        failures.push(message);
        console.error(message);
      }
      process.stderr.write(`lifecycle seed=${seed} events=${events.length} coverage=${JSON.stringify(result.coverage)} appendOnly=${JSON.stringify(result.appendOnly)}\n`);
    }
  } finally {
    if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp;
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgent;
    rmSync(agentDir, { recursive: true, force: true }); rmSync(scratch, { recursive: true, force: true });
  }
  process.stderr.write(`lifecycle seeds=${chosen.join(',')} runtime=${((Date.now() - started) / 1000).toFixed(2)}s coverage=${JSON.stringify(coverage)} appendOnly=${JSON.stringify(appendOnly)}\n`);
  // No silent successes from a generator which never actually cuts or searches.
  for (const key of ['requests', 'promptCuts', 'boundaryCuts', 'fresh', 'modelSearches', 'savedViews', 'quotedPrompts', 'aborts', 'handled', 'sessions', 'treeMoves', 'manual', 'semantic', 'semanticNotices'] as const) {
    expect(coverage[key], `no lifecycle coverage: ${key}`).toBeGreaterThan(0);
  }
  expect(failures, failures.join('\n\n')).toEqual([]);
  // A regression may itself turn every expected cut-free request into a cut;
  // report that regression before checking coverage of the passing sequence.
  expect(coverage.noCutRequests, 'no request exercised the cut-free tool-absence rule').toBeGreaterThan(0);
  expect(appendOnly.checked, 'no consecutive requests exercised append-only preservation').toBeGreaterThan(0);
});
