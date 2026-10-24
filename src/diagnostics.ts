import { BUILD_ID } from './build-id.js';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, lstat, unlink, realpath } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { createRecall, type RecallPolicy } from './recall.js';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
export const DIAGNOSTIC_BUILD = BUILD_ID;
export interface Receipt { id: string; build: string; reason: string; selectedView: string; boundary: string; settings: { draftReservedTokens: number; contextWindow: number; responseReserveTokens?: number; hostInputTokens?: number; mandatoryInputTokens?: number; target?: 'band' | 'room'; triggerMarginTokens?: number; calibrationFactor?: number; calibrationWindow?: number[]; calibrationIdentity?: string; activeInputCeilingTokens?: number | null }; before: { value: number; unit: 'estimated-input-tokens'; scope: 'native-preparation' | 'public-conversation' }; after: { value: number | null; unit: 'estimated-input-tokens'; scope: 'draft-preview' }; }
export function attachReceipt<T extends { details?: unknown; firstKeptEntryId: string; tokensBefore: number }>(draft: T, reason: string, reserveTokens: number, contextWindow: number, resolved: Partial<Receipt['settings']> = {}): T & { details: Record<string, unknown> & { diagnosticReceipt: Receipt } } {
 const details = draft.details && typeof draft.details === 'object' ? draft.details as Record<string, unknown> : {};
 const receipt: Receipt = { id: randomUUID(), build: DIAGNOSTIC_BUILD, reason, selectedView: typeof details.view === 'string' ? details.view : 'deterministic-selected-draft', boundary: draft.firstKeptEntryId, settings: { draftReservedTokens: reserveTokens, contextWindow, ...resolved }, before: { value: draft.tokensBefore, unit: 'estimated-input-tokens', scope: reason === 'tool-loop' ? 'public-conversation' : 'native-preparation' }, after: { value: typeof details.tokensAfter === 'number' ? details.tokensAfter : null, unit: 'estimated-input-tokens', scope: 'draft-preview' } };
 return { ...draft, details: { ...details, diagnosticReceipt: receipt } };
}
export function receiptId(entry: { details?: unknown }): string | undefined {
 const d = entry.details as { diagnosticReceipt?: { id?: unknown } } | undefined;
 return typeof d?.diagnosticReceipt?.id === 'string' ? d.diagnosticReceipt.id : undefined;
}
export function findReceiptEntry(entries: SessionEntry[], id: string) { const matches = entries.filter(entry => entry.type === "compaction" && receiptId(entry) === id); return matches.length === 1 ? matches[0] : undefined; }
export interface RecorderOptions { directory?: string; maxContentCharacters?: number; maxQueueCharacters?: number; maxFileBytes?: number; maxFiles?: number; durationMs?: number; write?: (path: string, content: string) => Promise<void>; }
export interface IncidentRecord { kind: string; scope: string; data: unknown; partial: boolean; }
/** A bounded clone. Budget is charged before every copy; forbidden fields are never traversed.
 * This is conservative structural/pattern redaction, not semantic secret detection. */
export function boundedCopy(value: unknown, limit: number): { data: unknown; characters: number; partial: boolean } {
 let remaining = limit, partial = false;
 const spend = (n: number) => { if (n > remaining) { partial = true; return false; } remaining -= n; return true; };
 const copy = (v: unknown, depth: number): unknown => {
  if (!spend(8) || depth > 20) { partial = true; return null; }
  if (typeof v === 'string') {
   if (v.length > remaining) { partial = true; return '[content bound]'; }
   if (/\b(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]{8,}|(?:password|secret|api[_ -]?key|token)\s*[:=]\s*\S+)/i.test(v)) { partial = true; return '[credential-pattern excluded]'; }
   spend(v.length); return v;
  }
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) { const out: unknown[] = []; for (const x of v) { if (remaining < 16) { partial = true; break; } out.push(copy(x, depth + 1)); } return out; }
  if (v && typeof v === 'object') {
   const out: Record<string, unknown> = {};
   for (const key of (function* () { for (const key in v) if (Object.prototype.hasOwnProperty.call(v, key)) yield key; })()) {
    if (/authorization|headers|credential|password|secret|systemPrompt|thinking|signature|apiKey|errorMessage/i.test(key)) { partial = true; continue; }
    if (!spend(key.length + 8)) break;
    const field = (v as Record<string, unknown>)[key];
    if (field === undefined) continue; // Native JSON omission; null remains null.
    out[key] = copy(field, depth + 1);
   } return out;
  } partial = true; return null;
 };
 return { data: copy(value, 0), characters: limit - remaining, partial };
}
export function permittedEntries(entries: SessionEntry[], policy: RecallPolicy = {}): { entries: SessionEntry[]; partial: boolean } {
 const isSource = createRecall(policy).isHistorySource;
 let partial = false;
 const bounded = entries.slice(0,10000);
 if (bounded.length !== entries.length) partial = true;
 const allowed = bounded.filter(entry => {
  if (entry.type === 'message' && (entry.message.role === 'system' || entry.message.role === 'assistant' && entry.message.content.some(b => b.type === 'thinking'))) { partial = true; return false; }
  if (['label', 'context_edit'].includes(entry.type) || isSource(entry)) return true;
  partial = true; return false;
 });
 return { entries: allowed, partial };
}
export class IncidentRecorder {
 private queue: string[] = []; private queued = 0; private total = 0; private pumping?: Promise<void>; private timer?: ReturnType<typeof setTimeout>;
 private captureCalls = 0; private inlineMs = 0; private hookMs = 0;
 private projectDirectory = ''; private id = ''; private path = ''; private state = 'off'; private nextCut = false; private sawCut = false; private requests = 0; private response = false;
 private notify: (status: string) => void = () => {};
 private safeNotify(status: string) { try { this.notify(status); } catch { /* UI failure is diagnostic only. */ } }
 readonly directory: string;
 constructor(private options: RecorderOptions = {}) {
  const bound = (value: number | undefined, fallback: number, max: number) => Number.isSafeInteger(value) && value! > 0 ? Math.min(value!,max) : fallback;
  this.options = { ...options, maxContentCharacters: bound(options.maxContentCharacters,200000,1500000), maxQueueCharacters: bound(options.maxQueueCharacters,500000,3000000), maxFileBytes: bound(options.maxFileBytes,2000000,10000000), maxFiles: bound(options.maxFiles,4,8), durationMs: bound(options.durationMs,120000,600000) };
  this.directory = resolve(options.directory ?? join(homedir(), '.local/state/pi-tuck-incidents')); }
 get waitingForCut() { return this.enabled && this.nextCut && !this.sawCut; }
 get enabled() { return this.state === 'recording'; }
 status() { return { state: this.state, incidentId: this.id || null, queuedCharacters: this.queued, recordedCharacters: this.total, path: this.path || null, captureCalls: this.captureCalls, inlineMilliseconds: this.inlineMs, inlineHookMilliseconds: this.hookMs }; }
 start(project: string, nextCut: boolean, notify: (status: string) => void) {
  if (this.enabled || this.pumping) { notify('Recorder is already active or flushing'); return; }
  const rel = relative(resolve(project), this.directory);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) { notify('Recorder directory must be outside project'); return; }
  this.projectDirectory = resolve(project); this.notify = notify; this.state = 'recording'; this.nextCut = nextCut; this.sawCut = false; this.requests = 0; this.response = false; this.total = 0; this.captureCalls = 0; this.inlineMs = 0; this.hookMs = 0; this.id = randomUUID(); this.path = join(this.directory, 'pi-tuck-incident-' + this.id + '.jsonl');
  this.timer = setTimeout(() => this.stop(this.sawCut ? 'duration-exhausted' : 'no-cut-expired'), this.options.durationMs ?? 120000); this.timer.unref();
  this.capture('start', 'operator-session-control', { id: this.id, build: DIAGNOSTIC_BUILD, nextCut, notice: 'Structural/pattern exclusions; partial replay possible. No semantic secret guarantee.' });
 }
 measureInline<T>(operation: () => T): T { if (!this.enabled) return operation(); const started = performance.now(); try { return operation(); } finally { this.hookMs += performance.now() - started; } }
 capture(kind: string, scope: string, value: unknown, inheritedPartial = false) {
  if (!this.enabled || this.waitingForCut && !['start','replay-input','proposal','observed-entry'].includes(kind)) return;
  const started = performance.now(); this.captureCalls++;
  const contentLimit = this.options.maxContentCharacters ?? 200000;
  const queueLimit = this.options.maxQueueCharacters ?? 500000;
  const available = Math.min(contentLimit, queueLimit - this.queued - 1024, (this.options.maxFileBytes ?? 2000000) / 6 - this.total - 1024);
  if (available < 32) { this.stop('bound-exhausted'); return; }
  let copy: ReturnType<typeof boundedCopy>;
  try { copy = boundedCopy(value, available); } catch { this.stop('capture-failed-gap'); return; }
  const record: IncidentRecord = { kind, scope, data: copy.data, partial: inheritedPartial || copy.partial };
  const line = JSON.stringify(record) + '\n';
  if (line.length + this.queued > queueLimit || Buffer.byteLength(line) + this.total * 6 > (this.options.maxFileBytes ?? 2000000)) { this.stop('bound-exhausted'); return; }
  this.queue.push(line); this.queued += line.length; this.total += copy.characters;
  if (copy.partial && copy.characters >= available - 16) this.stop('content-exhausted');
  this.inlineMs += performance.now() - started;
  this.schedule();
 }
 cut() { if (this.enabled) this.sawCut = true; }
 request() { if (this.enabled && this.sawCut) { this.requests++; if (this.nextCut && this.requests > 1) this.stop('aftermath-request-bound'); } }
 responded(outcome = 'stop') { if (this.enabled && this.sawCut && this.requests > 0) { this.response = true; if (this.nextCut) this.stop(outcome === 'error' ? 'aftermath-response-failed' : outcome === 'aborted' ? 'aftermath-response-cancelled' : 'next-cut-aftermath-complete'); } }
 stop(reason: string) {
  if (!this.enabled) return;
  if (this.timer) clearTimeout(this.timer); this.timer = undefined;
  const terminal = JSON.stringify({ kind: 'terminal', scope: 'recorder', data: { reason, cutObserved: this.sawCut, nextRequestObserved: this.requests > 0, responseObserved: this.response }, partial: false }) + '\n';
  // A small reserved terminal is permitted even after capture exhausts its budget.
  this.queue.push(terminal); this.queued += terminal.length; this.state = reason; this.safeNotify('Compaction incident: ' + reason); this.schedule();
 }
 private schedule() { if (!this.pumping) this.pumping = Promise.resolve().then(() => this.pump()); }
 private async pump() {
  try {
   // Resolve existing ancestors before creating anything; an outside path may
   // traverse a parent symlink into the active project.
   let ancestor = this.directory; const missing: string[] = [];
   while (true) { try { ancestor = await realpath(ancestor); break; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(ancestor) === ancestor) throw error;
    missing.unshift(basename(ancestor)); ancestor = dirname(ancestor);
   } }
   const physicalDirectory = resolve(ancestor, ...missing);
   const physicalProject = await realpath(this.projectDirectory).catch(() => this.projectDirectory);
   const rel = relative(physicalProject, physicalDirectory);
   if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('Recorder directory resolves inside project');
   await mkdir(this.directory, { recursive: true, mode: 0o700 });
   const directoryStat = await lstat(this.directory);
   if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o077) !== 0 || directoryStat.uid !== process.getuid?.()) throw new Error('Recorder directory ownership/permissions');
   const names: { name: string; time: number }[] = [];
   for (const name of await readdir(this.directory)) if (/^pi-(?:tuck|vcc)-incident-[0-9a-f-]{36}\.jsonl$/.test(name)) { const stat = await lstat(join(this.directory,name)); if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error('Retention ownership gap'); names.push({name,time:stat.mtimeMs}); }
   names.sort((a,b)=>a.time-b.time);
   while (names.length >= (this.options.maxFiles ?? 4)) { const { name } = names.shift()!; if (join(this.directory, name) !== this.path) await unlink(join(this.directory, name)); }
   while (this.queue.length) {
    const line = this.queue.shift()!; this.queued -= line.length;
    if (Buffer.byteLength(line) > (this.options.maxFileBytes ?? 2000000)) throw new Error('File bound');
    if (this.options.write) await this.options.write(this.path, line);
    else { const file = await open(this.path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); try { const stat = await file.stat(); if (stat.size + Buffer.byteLength(line) > (this.options.maxFileBytes ?? 2000000)) throw new Error('File bound'); if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error('Recorder file ownership/permissions'); await file.write(line); } finally { await file.close(); } }
   }
  } catch { this.queue = []; this.queued = 0; if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.state = 'storage-failed-gap'; this.safeNotify('Compaction recorder storage failed; incident has a gap'); }
  finally { this.pumping = undefined; if (this.queue.length) this.schedule(); }
 }
 async flush() { while (this.pumping) await this.pumping; }
}
