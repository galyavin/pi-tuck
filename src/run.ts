import { SessionManager, type ExtensionContext, type SessionEntry, type SessionBoundaryDraft } from '@earendil-works/pi-coding-agent';
import { hasTuckCut } from './history-tools.js';
import { textOf } from './tuck/core/content.js';
import type { Clip } from './clip.js';

export type CutEntry = { type: 'compaction'; summary: string; firstKeptEntryId: string; tokensBefore: number; details?: unknown };
type Context = Pick<ExtensionContext, 'cwd' | 'sessionManager'> & Partial<Pick<ExtensionContext, 'model'>>;
const budgetIdentity = (model: Context['model']) => model &&
    JSON.stringify([model.provider, model.api, model.id, model.contextWindow, model.maxTokens]);
export interface CutView { session: ExtensionContext['sessionManager']; keptFromId: string | undefined; hasTuckCut: boolean; pending: boolean }

/** The only owner of a cut that requests carry before Pi saves it. */
export class PendingCut {
    private proposal?: { cut: CutEntry; manager: Context['sessionManager']; cwd: string; branchLength: number; anchor: string | undefined; budget?: string };
    private preview?: { manager: Context['sessionManager']; cwd: string; leaf: string | null; view: CutView };
    plan(cut: CutEntry, ctx: Context) {
        const branch = ctx.sessionManager.getBranch();
        this.proposal = { cut, manager: ctx.sessionManager, cwd: ctx.cwd, branchLength: branch.length,
            anchor: branch.at(-1)?.id, budget: budgetIdentity(ctx.model) };
        this.preview = undefined;
    }
    clear() { this.proposal = undefined; this.preview = undefined; }
    take(ctx: Context) {
        if (!this.view(ctx).pending) return;
        const cut = this.proposal?.cut;
        this.clear();
        return cut;
    }
    view(ctx: Context, entries: readonly SessionBoundaryDraft[] = []): CutView {
        const live = ctx.sessionManager, leaf = live.getLeafId?.();
        const proposal = this.proposal;
        if (proposal && (proposal.manager !== live || proposal.cwd !== ctx.cwd || proposal.budget !== budgetIdentity(ctx.model))) this.clear();
        const held = this.preview;
        // Native entries are append-only. A changed leaf requires checking that the plan's anchor still precedes it.
        if (!entries.length && leaf !== undefined && held && held.manager === live && held.cwd === ctx.cwd && held.leaf === leaf) return held.view;
        const branch = live.getBranch();
        if (this.proposal?.anchor !== undefined && branch[this.proposal.branchLength - 1]?.id !== this.proposal.anchor) this.clear();
        const cut = this.proposal?.cut;
        const remember = (view: CutView) => {
            if (!entries.length && leaf !== undefined) this.preview = { manager: live, cwd: ctx.cwd, leaf, view };
            return view;
        };
        if (!cut && !entries.length) {
            const last = branch.findLast(entry => entry.type === 'compaction');
            return remember({ session: live, keptFromId: last?.type === 'compaction' ? last.firstKeptEntryId : undefined,
                hasTuckCut: hasTuckCut(branch), pending: false });
        }
        // A compact-all plan predates the prompt. Keep from the first appended entry, skipping our capacity receipts.
        const keptFromId = cut && (cut.firstKeptEntryId || branch.slice(this.proposal!.branchLength)
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
            hasTuckCut: hasTuckCut(previewBranch), pending: Boolean(cut) });
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
            const fault = new Error(`pi-tuck: invalid run transition ${this.phase} -> ${phase}`);
            // A rejected transition must stop the caller and latch admission shut.
            // Preserve an existing terminal cause, especially a persistence fault.
            if (this.state.phase !== 'failed' && this.state.phase !== 'commit-failed')
                this.state = { phase: 'failed', error: fault };
            throw fault;
        }
        this.state = phase === 'failed' || phase === 'commit-failed' ? { phase, error: error! } : { phase };
        if (phase === 'expired') this.expiredPlan = true;
        return true;
    }
    prompt?: StartingPrompt;
    cut = new PendingCut();
    clips = new Map<string, Clip>();
    pendingBoundaryReceipts: string[] = [];
    private lengthRecovery: 'available' | 'pending' | 'used' = 'available';
    get lengthRetryPending() { return this.lengthRecovery === 'pending'; }
    get canRetryLength() { return this.phase === 'admitted' && this.lengthRecovery === 'available'; }
    requestLengthRetry() {
        if (!this.canRetryLength) throw new Error('pi-tuck: capacity recovery is unavailable for this run');
        this.lengthRecovery = 'pending';
    }
    finishLengthRetry() {
        if (this.lengthRecovery === 'pending') this.lengthRecovery = 'used';
    }
    /** A refusal-path floor carried by cut; the complete request must still pass Pi's window check. */
    nativeFloorPending = false;
    refusalReceipted = false;
    clear() {
        this.prompt = undefined; this.cut.clear(); this.clips.clear(); this.pendingBoundaryReceipts = [];
        this.nativeFloorPending = false; this.refusalReceipted = false; this.expiredPlan = false;
    }
}
