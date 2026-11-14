import { SessionManager, type ExtensionContext, type SessionEntry, type SessionBoundaryDraft } from '@earendil-works/pi-coding-agent';
import { hasTuckCut } from './history-tools.js';
import { viewStart } from './semantic-recall.js';
import { textOf } from './tuck/core/content.js';
import type { Clip } from './clip.js';

export type CutEntry = { type: 'compaction'; summary: string; firstKeptEntryId: string; tokensBefore: number; details?: unknown };
type Context = Pick<ExtensionContext, 'cwd' | 'sessionManager'>;
export interface CutView { session: ExtensionContext['sessionManager']; keptFromId: string | undefined; viewStart: number; hasTuckCut: boolean; pending: boolean }

/** The only owner of a cut that requests carry before Pi saves it. */
export class PendingCut {
    private cut?: CutEntry;
    private branchLength = 0;
    private preview?: { manager: Context['sessionManager']; cwd: string; leaf: string | null; view: CutView };
    plan(cut: CutEntry, branchLength: number) { this.cut = cut; this.branchLength = branchLength; this.preview = undefined; }
    clear() { this.cut = undefined; this.branchLength = 0; this.preview = undefined; }
    take() { const cut = this.cut; this.clear(); return cut; }
    view(ctx: Context, entries: readonly SessionBoundaryDraft[] = []): CutView {
        const live = ctx.sessionManager, leaf = live.getLeafId?.(), held = this.preview;
        // Native entries are append-only; a leaf move invalidates both the saved and pending views, as in the eligibility cache.
        if (!entries.length && leaf !== undefined && held && held.manager === live && held.cwd === ctx.cwd && held.leaf === leaf) return held.view;
        const branch = live.getBranch(), cut = this.cut;
        const remember = (view: CutView) => {
            if (!entries.length && leaf !== undefined) this.preview = { manager: live, cwd: ctx.cwd, leaf, view };
            return view;
        };
        if (!cut && !entries.length) {
            const last = branch.findLast(entry => entry.type === 'compaction');
            return remember({ session: live, keptFromId: last?.type === 'compaction' ? last.firstKeptEntryId : undefined,
                viewStart: viewStart(branch), hasTuckCut: hasTuckCut(branch), pending: false });
        }
        // A compact-all plan predates the prompt. Keep from the first appended entry, skipping our capacity receipts.
        const keptFromId = cut && (cut.firstKeptEntryId || branch.slice(this.branchLength)
            .find(entry => entry.type !== 'custom' || entry.customType !== 'pi-tuck-capacity')?.id || '');
        const header = live.getHeader();
        if (!header) throw new Error("Missing native session header for the prompt's cut");
        const session = SessionManager.inMemory(ctx.cwd, undefined, [header, ...branch]);
        if (cut) session.appendCompaction(cut.summary, keptFromId!, 0, cut.details, true);
        // Retry/settlement drafts model the same request view, including an omitted failed reply.
        for (const entry of entries) {
            if (entry.type === 'context_edit') session.appendContextEdit(entry.targetId, entry.replacement);
            else if (entry.type === 'compaction') session.appendCompaction(entry.summary, entry.firstKeptEntryId, 0, entry.details, true, entry.usage);
            else if (entry.type === 'custom') session.appendCustomEntry(entry.customType, entry.data);
            else session.appendCustomMessageEntry(entry.customType, entry.content, entry.display, entry.details);
        }
        const previewBranch = session.getBranch(), last = previewBranch.findLast(entry => entry.type === 'compaction');
        return remember({ session, keptFromId: last?.type === 'compaction' ? last.firstKeptEntryId : undefined,
            viewStart: viewStart(previewBranch), hasTuckCut: hasTuckCut(previewBranch), pending: Boolean(cut) });
    }
}

/** Text bridges before Pi appends the starting message. Once visible, every reader uses its entry id.
 * Bind on the first request/compaction read after message_end (which Pi emits before appending), before steering can replace it. */
export class StartingPrompt {
    private entryId?: string;
    private bridge?: string;
    constructor(bridge: string, private readonly branchLength: number, readonly role: 'user' | 'custom' = 'user') { this.bridge = bridge; }
    id(branch: readonly SessionEntry[]) {
        if (!this.entryId && this.bridge !== undefined) {
            const text = this.bridge;
            this.entryId = branch.slice(this.branchLength).find(entry => this.role === 'custom'
                ? entry.type === 'custom_message' && textOf(entry.content) === text
                : entry.type === 'message' && entry.message.role === 'user' && textOf(entry.message.content).includes(text))?.id;
            if (this.entryId) this.bridge = undefined;
        }
        return this.entryId;
    }
    text(branch: readonly SessionEntry[]) {
        const id = this.id(branch), entry = branch.find(entry => entry.id === id);
        if (entry?.type === 'message' && entry.message.role === 'user') return textOf(entry.message.content);
        if (entry?.type === 'custom_message') return textOf(entry.content);
        if (this.bridge !== undefined) return this.bridge;
        throw new Error('The starting prompt entry is no longer on this branch');
    }
}

export type RunPhase = 'decided' | 'claimed' | 'expired' | 'starting' | 'admitted' | 'failed' | 'commit-failed';
/** Claim/expiry describe the input plan; a failed attempt cannot re-enter a live phase. */
export const RUN_TRANSITIONS: Readonly<Record<RunPhase, readonly RunPhase[]>> = {
    decided: ['claimed', 'expired', 'starting', 'failed', 'commit-failed'],
    claimed: ['claimed', 'starting', 'failed', 'commit-failed'],
    expired: ['starting', 'failed', 'commit-failed'],
    starting: ['admitted', 'failed', 'commit-failed'],
    admitted: ['admitted', 'failed', 'commit-failed'],
    failed: ['failed', 'commit-failed'],
    'commit-failed': ['commit-failed'],
};
let reportedInvalidTransition = false;
type RunState = { phase: Exclude<RunPhase, 'failed' | 'commit-failed'> } | { phase: 'failed' | 'commit-failed'; error: Error };

export class Run {
    private state: RunState;
    // Input-plan provenance survives starting/admission: later native threshold
    // checks still choose the live view when the original input plan expired.
    private expiredPlan = false;
    constructor(phase: Exclude<RunPhase, 'failed' | 'commit-failed'>) { this.state = { phase }; }
    get phase() { return this.state.phase; }
    get expired() { return this.expiredPlan; }
    /** Failure data, only present in a failed phase. The phase alone decides admission. */
    get error() { return 'error' in this.state ? this.state.error : undefined; }
    transition(phase: RunPhase, ctx?: Pick<ExtensionContext, 'hasUI'>, error?: Error): boolean {
        if (!RUN_TRANSITIONS[this.phase].includes(phase) || ((phase === 'failed' || phase === 'commit-failed') && !error)) {
            const message = `pi-tuck: invalid run transition ${this.phase} -> ${phase}`;
            if (process.env.NODE_ENV === 'test') throw new Error(message);
            if (ctx?.hasUI === false && !reportedInvalidTransition) {
                reportedInvalidTransition = true;
                try { process.stderr.write(message + '\n'); } catch { /* ended */ }
            }
            return false;
        }
        this.state = phase === 'failed' || phase === 'commit-failed' ? { phase, error: error! } : { phase };
        if (phase === 'expired') this.expiredPlan = true;
        return true;
    }
    prompt?: StartingPrompt;
    cut = new PendingCut();
    clips = new Map<string, Clip>();
    pendingBoundaryReceipts: string[] = [];
    thinkingRetryPending = false;
    refusalReceipted = false;
    clear() {
        this.prompt = undefined; this.cut.clear(); this.clips.clear(); this.pendingBoundaryReceipts = [];
        this.thinkingRetryPending = false; this.refusalReceipted = false; this.expiredPlan = false;
    }
}
export const createRun = (phase: ConstructorParameters<typeof Run>[0]): Run => new Run(phase);
