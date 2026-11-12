import type { ExtensionContext, SessionEntry } from '@earendil-works/pi-coding-agent';
import { isTextOnly, textOf } from './tuck/core/content';
import { buildGlobalIndexById, type GlobalIndexCursor } from './tuck/core/global-indices';

const MAX_LINES = 4000;
const normalizeLine = (line: string) => line.trim().replace(/^(?:[\w./@-]+:)?\s*\d+\s*(?:[\t|:]|  )\s?/, '').trim();
interface Cache {
 session: string;
 through: number;
 leaf: string | undefined;
 globalLeaf: string | undefined;
 indices: GlobalIndexCursor;
 positions: Map<string, number>;
 lines: Map<string, Set<string>>;
 inverted: Map<string, number[]>;
 notes: Map<string, string | null>;
 byCall: Map<string, string>;
 boundary: number | undefined;
}
const caches = new WeakMap<object, Cache>();

function noteFor(cache: Cache, branch: readonly SessionEntry[], lines: Set<string>, raw: string[]): string | null {
 if (cache.boundary === undefined || lines.size < 5) return null;
 // Only results already processed occur in the postings. Distinct lines vote once each.
 const shared = new Map<number, number>();
 for (const line of lines) for (const ordinal of cache.inverted.get(line) ?? []) shared.set(ordinal, (shared.get(ordinal) ?? 0) + 1);
 let twin = -1, best = 0, visible = 0;
 for (const [ordinal, count] of shared) {
  if (ordinal >= cache.boundary) visible = Math.max(visible, count);
  else if (count > best || count === best && ordinal > twin) { twin = ordinal; best = count; }
 }
 if (best < 5 || best < 0.6 * lines.size || visible >= best) return null;
 const id = branch[twin]!.id, index = cache.indices.byId.get(id);
 if (index === undefined) return null;
 if (best === lines.size) return `[pi-tuck: all ${lines.size} lines of this output also appear in output #${index} from before the cut; tuck_recall {"index":${index}} shows it exactly.]`;
 const earlier = cache.lines.get(id)!, missing: number[] = [];
 let total = 0;
 for (let at = 0; at < raw.length; at++) {
  const line = normalizeLine(raw[at]!);
  if (lines.has(line) && !earlier.has(line)) { if (missing.length < 5) missing.push(at + 1); total++; }
 }
 const list = missing.join(', ') + (total > 5 ? ` and ${total - 5} more` : '');
 return `[pi-tuck: ${best} of these ${lines.size} lines also appear in output #${index} from before the cut; tuck_recall {"index":${index}} shows it exactly. Lines not in #${index}: ${list}.]`;
}

/** Like eligibility-cache, trust Pi's immutable append-only entries, and reset on a session/branch switch. A result's verdict is made
 * before indexing it, using only its preceding saved cut and results. Even a first projection long after that result replays that verdict. */
export function twinNotes(manager: ExtensionContext['sessionManager'], entries: readonly SessionEntry[], branch: readonly SessionEntry[]): (toolCallId: string) => string | null | undefined {
 if (!branch.length) { caches.delete(manager); return () => undefined; }
 const session = manager.getSessionId();
 let cache = caches.get(manager);
 if (!cache || cache.session !== session || branch.length < cache.through ||
     cache.through > 0 && branch[cache.through - 1]?.id !== cache.leaf ||
     entries.length < cache.indices.through || cache.indices.through > 0 && entries[cache.indices.through - 1]?.id !== cache.globalLeaf) {
  cache = { session, through: 0, leaf: undefined, globalLeaf: undefined,
   indices: { byId: new Map(), ambiguous: new Set(), messageIndex: 0, through: 0 },
   positions: new Map(), lines: new Map(), inverted: new Map(), notes: new Map(), byCall: new Map(), boundary: undefined };
  caches.set(manager, cache);
 }
 buildGlobalIndexById(entries, cache.indices);
 cache.globalLeaf = entries.at(-1)?.id;
 for (let at = cache.through; at < branch.length; at++) {
  const entry = branch[at]!;
  cache.positions.set(entry.id, at);
  if (entry.type === 'compaction' && (entry.details as { compactor?: unknown } | null)?.compactor === 'pi-tuck') {
   cache.boundary = cache.positions.get(entry.firstKeptEntryId) ?? at;
  }
  if (entry.type !== 'message' || entry.message.role !== 'toolResult') continue;
  const message = entry.message;
  cache.byCall.set(message.toolCallId, entry.id);
  cache.notes.set(entry.id, null);
  if (message.isError || message.toolName === 'tuck_recall' || message.toolName === 'tuck_search' || !isTextOnly(message.content)) continue;
  const raw = textOf(message.content).split('\n'), lines = new Set<string>();
  for (const rawLine of raw) {
   const line = normalizeLine(rawLine);
   if (line.length >= 20) lines.add(line);
   if (lines.size === MAX_LINES) break;
  }
  cache.lines.set(entry.id, lines);
  cache.notes.set(entry.id, noteFor(cache, branch, lines, raw));
  for (const line of lines) {
   const ordinals = cache.inverted.get(line);
   if (ordinals) ordinals.push(at); else cache.inverted.set(line, [at]);
  }
 }
 cache.through = branch.length;
 cache.leaf = branch.at(-1)?.id;
 return toolCallId => cache.notes.get(cache.byCall.get(toolCallId) ?? '');
}
