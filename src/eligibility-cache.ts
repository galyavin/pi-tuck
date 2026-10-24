import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { RecallPolicy } from './recall';
import { semanticEligibleSources } from './semantic-recall';

type Context = Pick<ExtensionContext, 'sessionManager' | 'cwd'>;
type Snapshot = ReturnType<typeof semanticEligibleSources>;
// The controller fills `units`, `complete`, `indexed` and `window` on the snapshot it is given, so a hit never hands out the stored object. Only
// what the build derives from the session and nothing later changes is stored; a hit gets fresh `units`, `complete` and `indexed`, and no
// `window` (`prepare` assigns it). A required field added to the snapshot is a type error in the hit literal below, but an optional one (as
// `window` is) is not: it would be dropped on a hit and present on a miss. The structural test in eligibility-cache.test.ts classifies every
// field of a snapshot exactly and fails on an unclassified one.
type Immutable = Pick<Snapshot, 'id' | 'session' | 'project' | 'sources' | 'throughEntryId' | 'viewStart'>;
interface Entry { policy: RecallPolicy | undefined; key: readonly unknown[]; stored: Immutable }

const cache = new WeakMap<object, Entry>();

/** The one place that decides when the snapshot stored for a session manager and policy is still the snapshot a rebuild would give, and when `pi_tuck_search` must rerun its lexical offer after its await: Pi entries
 * are append-only, so a new entry changes the entry count, and a branch switch changes the leaf. Change what invalidates it here and nowhere else.
 * The lexical recheck in `pi_tuck_search` relies on the same contract: `piTuckRecall` is pure in (entries, branch, input, policy) whenever it returns (its only clock use is a 3 s abort that throws), so an unchanged key across the await means an unchanged
 * lexical offer and the second pass is skipped (`eligibilityKeyMoved`). An entry edited in place
 * after it was appended, a `readAttemptMarker` with hidden state, or a policy mutated after install is outside this contract for both uses. */
export function eligibilityKey(ctx: Context): readonly unknown[] {
	const manager = ctx.sessionManager;
	return [manager.getSessionId(), ctx.cwd, manager.getLeafId(), manager.getBranch().length, manager.getEntries().length];
}

const same = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
/** Whether the session moved since `since` was taken from `eligibilityKey(ctx)`. */
export const eligibilityKeyMoved = (ctx: Context, since: readonly unknown[]) => !same(since, eligibilityKey(ctx));

/** `semanticEligibleSources` for an unchanged session without the rebuild. `access()` runs on every call, hits included, and a throw is
 * the same `SemanticAccessError` that `semanticEligibleSources` raises (the mapping below is that function's first statement, verbatim).
 * The policy is trusted by identity, so it must not change after install: a policy object mutated in place (a type added to
 * `privateCustomTypes`) or a `readAttemptMarker` with hidden state is not noticed until the history changes. */
export function memoizedEligibleSources(ctx: Context, policy: RecallPolicy | undefined, access: () => void): Snapshot {
	try { access(); } catch (error) { throw Object.assign(new Error(error instanceof Error ? error.message : 'Source access denied'), { name: 'SemanticAccessError' }); }
	const key = eligibilityKey(ctx), held = cache.get(ctx.sessionManager);
	if (held && held.policy === policy && same(held.key, key)) return { ...held.stored, units: [], complete: false, indexed: new Set() };
	// Access was checked on the line above with nothing awaited in between, so the rebuild does not check it a second time.
	const built = semanticEligibleSources(ctx, policy ?? {}, () => {});
	cache.set(ctx.sessionManager, { policy, key, stored: { id: built.id, session: built.session, project: built.project, sources: built.sources, throughEntryId: built.throughEntryId, viewStart: built.viewStart } });
	return built;
}
