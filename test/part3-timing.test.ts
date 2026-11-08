import { test, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector';
import { pathToFileURL } from 'node:url';
import { SessionManager, type ExtensionContext, type SessionEntry } from '@earendil-works/pi-coding-agent';
import { measurableConversationTokens } from '../src/budget';
import { tuck, tuckObservedDraft } from '../src/tuck';
import { part3Fixture } from './part3-fixture';

const enabled = process.env.PART3_BENCH === '1';
test.skipIf(!enabled)('Part 3: compare a 128k cut and the 3,888-entry stall workload on the same machine', async () => {
  const baselinePath = process.env.PART3_BASELINE;
  if (!baselinePath) throw new Error('PART3_BASELINE must point to v1.0.17 dist/src/tuck.js (test-only snapshot)');
  const baseline: typeof import('../src/tuck') = await import(/* @vite-ignore */ pathToFileURL(baselinePath).href);
  const baselineBudget: typeof import('../src/budget') = await import(/* @vite-ignore */ pathToFileURL(baselinePath.replace(/tuck\.js$/, 'budget.js')).href);
  if (!process.env.PART3_STALL_FIXTURE) throw new Error('PART3_STALL_FIXTURE must name the captured v1.0.1 low-prose input before turn 644 (128000 window, 16384 reserve)');
  const saved = JSON.parse(readFileSync(process.env.PART3_STALL_FIXTURE, 'utf8')) as { header: NonNullable<ReturnType<SessionManager['getHeader']>>; entries: SessionEntry[]; window: number; reserve: number };
  // The original session has 3,888 journal records including its native header.
  expect(saved.entries.length + 1).toBe(3888);
  const manager = SessionManager.inMemory('/tmp/synthetic-project', undefined, [saved.header, ...saved.entries]);
  const ctx = { sessionManager: manager, cwd: '/tmp/synthetic-project', model: { contextWindow: saved.window, maxTokens: 8192, provider: 'probe', id: 'probe', api: 'openai-completions' } } as unknown as ExtensionContext;
  const measure = (messages: Parameters<typeof measurableConversationTokens>[0]) => measurableConversationTokens(messages, ctx);
  const stall = { manager, ctx, measure, before: measure(manager.buildSessionProjection().messages), reserve: saved.reserve };
  const rows: { entries: number; before: number; v117: number; current: number; ratio: number }[] = [];
  const probe = part3Fixture(240);
  for (const f of [probe, stall]) {
    const run = (module: Pick<typeof baseline, 'tuck' | 'tuckObservedDraft'>) => {
      const start = performance.now();
      const draft = module.tuckObservedDraft(module.tuck, { branchEntries: f.manager.getBranch(), tokensBefore: f.before }, f.ctx, f.reserve, module === baseline ? messages => baselineBudget.measurableConversationTokens(messages, f.ctx) : f.measure, {}, false);
      const ms = performance.now() - start;
      if (!draft.compaction) throw new Error(draft.unavailable);
      return ms;
    };
    run(baseline); run({ tuck, tuckObservedDraft });
    const old: number[] = [], current: number[] = [];
    for (let at = 0; at < 5; at++) { old.push(run(baseline)); current.push(run({ tuck, tuckObservedDraft })); }
    const median = (xs: number[]) => xs.sort((a,b) => a-b)[2]!;
    const v117 = median(old), now = median(current);
    rows.push({ entries: f.manager.getEntries().length + 1, before: f.before, v117, current: now, ratio: now / v117 });
    if (process.env.PART3_PROFILE && f === probe) {
      const inspector = new Session(); inspector.connect();
      const post = (method: string) => new Promise<any>((resolve, reject) => inspector.post(method, (error, result) => error ? reject(error) : resolve(result)));
      await post('Profiler.enable'); await post('Profiler.start'); run({ tuck, tuckObservedDraft });
      const { profile } = await post('Profiler.stop'); inspector.disconnect();
      writeFileSync(process.env.PART3_PROFILE, JSON.stringify(profile));
    }
  }
  process.stderr.write(JSON.stringify(rows, null, 2) + '\n');
  if (process.env.PART3_TIMINGS) writeFileSync(process.env.PART3_TIMINGS, JSON.stringify(rows, null, 2) + '\n');
  if (process.env.PART3_ENFORCE === '1') for (const row of rows) expect(row.ratio, JSON.stringify(row)).toBeLessThanOrEqual(2);
}, 300000);
