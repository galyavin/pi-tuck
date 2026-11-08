import { getCurrentSystemMessage, type ImageContent } from "@earendil-works/pi-ai";
import { convertToLlm, estimateTokens, type BeforeAgentStartEvent, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { measurableMessages, projectedMessages } from "./omissions.js";
import type { RecallPolicy } from "./recall.js";
import { isDiscardedResponse } from "./protocol.js";
import { MAX_TAIL_TOKENS } from "./tuck/cut.js";

/**
 * The one measure of the next request. The cut triggers, the cut planner (including the draft admission in tuck.ts), the post-cut
 * checks and the complete-context guard all count through these functions, so they cannot count one request two ways. Everything is
 * deterministic and uses Pi's public converter and estimator; nothing here calls a model or reads a clock.
 */
export type AgentMessage = Parameters<typeof convertToLlm>[0][number];
export type Messages = AgentMessage[];
type Converted = ReturnType<typeof convertToLlm>;
export interface ToolShape { name: string; description: string; parameters: unknown }

/** Triggers fire this fraction of the room early. The margin absorbs request growth a boundary cannot see; it never enters the calibration factor. */
export const TRIGGER_MARGIN_FRACTION = 0.02;
/** Whether `value` is a cut point: a fraction of the room above 0 and at most 1. */
export const validCutAt = (value: unknown): value is number => typeof value === "number" && value > 0 && value <= 1;
/**
 * The one owner of the band: the limit a cut is triggered at and preferably planned to. An adaptive default may raise the cut point above
 * 60% using the last cut's conversation size and current system size, both estimates, so they are converted to the room's units by the factor. Explicit cut points use the fraction alone. The margin caps both.
 */
/** The initial default cut point: 60% of the room before a usable previous cut. Measured against 1 with paired replays (no answer loss) and billed
 * input under automatic and explicit prompt caching (about 17% less at 128k, 10-14% at 32k). */
export const DEFAULT_CUT_AT = 0.6;
/** Preferred native carry, in the planner's estimate: never more than the
 * keep-recent cut offers or the tail amount the adaptive band assumes. */
export const carriedTailTokens = (offeredTokens: number): number => Math.min(offeredTokens, MAX_TAIL_TOKENS / 2);
export const bandOf = (room: number, cutAt = 1, adaptive?: { system: number; tokensAfter: number; factor: number }): number => {
	const positive = Math.max(0, room);
	const base = Math.floor(positive * cutAt);
	return Math.min(room - Math.ceil(positive * TRIGGER_MARGIN_FRACTION), adaptive ? Math.max(base, Math.ceil((adaptive.system + adaptive.tokensAfter + carriedTailTokens(MAX_TAIL_TOKENS)) * adaptive.factor)) : base);
};

/** The cut's one carried-context grant, in the planner's estimate. Combines
 * the existing native/fixed base with the quarter-free historical amount;
 * neither component remains an independent spending limit in the fill.
 * The grant depends only on quantities. */
export function carriedTarget(window: number, reserve: number, base: number, before: number): number {
  const room = Math.max(0, window - reserve - 1);
  const free = Math.max(0, window - reserve - base - 1);
  const historical = Math.max(0, Math.min(Math.floor(free / 4), before - base - 1));
  return Math.min(room, before - 1, base + historical);
}

/** The APIs whose request converter (pi-ai openai-responses-shared) sends each signed thinking block back as an input reasoning item. */
const REPLAYING_APIS: ReadonlySet<string> = new Set(["openai-responses", "azure-openai-responses", "openai-codex-responses"]);
/**
 * Replayed reasoning that Pi's estimator does not see. On the OpenAI Responses APIs an assistant turn's reasoning item rides in its thinking
 * block's `thinkingSignature` (encrypted) and is sent back with later requests (pi-ai openai-responses-shared; transform-messages skips
 * aborted and errored turns). `estimateTokens` counts only the visible summary text, so the turn's recorded reasoning tokens are added in full.
 * pi-ai drops another model's signed blocks, so after a model switch this counts reasoning that is not sent. That request is overcounted,
 * but its paired ratios fall below the factor's floor of 1, so until those turns are cut the factor cannot learn the new model's undercount.
 * Any other API, a turn without a signed thinking block or a recorded `usage.reasoning`, or a turn that ended aborted or in error adds nothing.
 */
export const replayedReasoningTokens = (message: Converted[number]): number => {
	if (message.role !== "assistant" || !REPLAYING_APIS.has(message.api) || isDiscardedResponse(message)) return 0;
	const reasoning = message.usage?.reasoning ?? 0;
	return Number.isFinite(reasoning) && reasoning > 0 && message.content.some((b) => b.type === "thinking" && b.thinkingSignature) ? Math.ceil(reasoning) : 0;
};
// Pi converts the conversation (compaction-summary wrappers, custom messages and envelopes included) before it streams; count that, plus the
// reasoning it replays.
const nonSystemTokens = (converted: Converted) => converted.reduce((sum, message) => sum + (message.role === "system" ? 0 : estimateTokens(message) + replayedReasoningTokens(message)), 0);
const guardSystem = (converted: Converted, systemPrompt: string) => {
	const system = getCurrentSystemMessage(converted);
	return Math.max(system ? estimateTokens(system) : 0, estimateTokens({
		role: "system", content: systemPrompt, toolsAdded: system?.toolsAdded, timestamp: 0,
	}));
};

/** Estimated tokens of the non-system messages of `convertToLlm(messages)`. */
export const conversationTokens = (messages: Messages): number => nonSystemTokens(convertToLlm(messages));
/** The guard's system formula: the larger of the saved (current) system message and the live system prompt with that message's tools. */
export const guardSystemTokens = (messages: Messages, systemPrompt: string): number => guardSystem(convertToLlm(messages), systemPrompt);
/** The system prompt and the selected tools as the public hooks observe them. */
export const observedSystemTokens = (systemPrompt: string, tools: readonly ToolShape[]): number =>
	estimateTokens({ role: "system", content: systemPrompt + (tools.length ? JSON.stringify([...tools]) : ""), timestamp: 0 });
/** What a trigger charges for system and tools: never less than the guard's formula over the saved messages. */
export const systemPart = (observedPrompt: string, tools: readonly ToolShape[], saved: Messages, guardPrompt: string): number =>
	Math.max(observedSystemTokens(observedPrompt, tools), guardSystemTokens(saved, guardPrompt));
/** The incoming prompt and its images. */
export const incomingTokens = (prompt: string, images: readonly ImageContent[] | undefined): number =>
	estimateTokens({ role: "user", content: prompt, timestamp: 0 }) +
	estimateTokens({ role: "user", content: [...(images ?? [])], timestamp: 0 });
/** A run's incoming message: the user's prompt and images, or the custom message that started the run (Pi 1.4 and later), counted as the
 * user message it is sent as. */
export const incomingEventTokens = (event: BeforeAgentStartEvent): number => event.messageType === "custom"
	? estimateTokens({ role: "user", content: event.message.content, timestamp: 0 }) : incomingTokens(event.prompt, event.images);
/** The guard's complete measure of one request: system part by the guard formula plus every converted non-system message. */
export const requestTokens = (messages: Messages, systemPrompt: string): number => {
	const converted = convertToLlm(messages);
	return guardSystem(converted, systemPrompt) + nonSystemTokens(converted);
};
/** The saved conversation as the model receives it from this compactor, counted after Pi's conversion. This is the planner's measure too. */
export const projectedConversationTokens = (messages: Messages, ctx: ExtensionContext, policy?: RecallPolicy): number =>
	conversationTokens(projectedMessages(messages, ctx, policy));
/** As `projectedConversationTokens`, but a summary that is not in this compactor's format is counted as it is instead of failing: what the planner measures with, so that a cut can replace one. */
export const measurableConversationTokens = (messages: Messages, ctx: ExtensionContext, policy?: RecallPolicy): number =>
	conversationTokens(measurableMessages(messages, ctx, policy));
/** Raw reserve for the cut planner: the window less the raw tokens that fit the target room, plus the input no cut can remove. */
export const planningReserve = (window: number, targetRoom: number, factor: number, mandatory: number): number =>
	window - Math.floor(targetRoom / factor) + mandatory;

export type Target = "band" | "room";
/** A planned cut: the conversation it leaves. The optional mode is diagnostic data, not a decision input. */
export type Plan<D extends object = {}> = ({ draft: true; after: number; mode?: string } & D) | { draft: false; capacityRejected: boolean; reason: string };
export type Decision<D extends object = {}> =
	/** The request fits below the band, or an opportunistic cut cannot help: no cut and no fault; the request goes to the guard. */
	| { kind: "none" }
	/** The mandatory input does not fit by itself, so no cut can help: no cut; the guard decides and fails closed. */
	| { kind: "defer" }
	| { kind: "cut"; target: Target; plan: Extract<Plan<D>, { draft: true }> }
	| { kind: "fault"; capacity: boolean; message: string };
export interface CutInput<D extends object = {}> {
	/** The band adapts by itself (no explicit cut point), so a cut that isn't due must also free a tenth of the room. */
	usefulOnly?: boolean;
	/** Saved conversation, measured by the planner's own function. */
	before: number;
	/** Input that no cut can remove: system part, host input, queued messages, or the incoming prompt. */
	mandatory: number;
	room: number;
	band: number;
	/** Whether the calibrated tokens fit strictly below the limit. */
	fits: (tokens: number, limit: number) => boolean;
	/** Lazy: plans a cut for the target; called only when a rule needs it. */
	plan: (target: Target) => Plan<D>;
	/** The fault message when a drafted cut does not reduce the request within the room. */
	unreduced: string;
}
/** What a cut decision resolves to once the planner has been asked. */
export type Verdict<D extends object = {}> = Exclude<Decision<D>, { kind: "defer" }>;
/** Plan the band first at every cut point. An opportunistic cut must land
 * below it and free the existing minimum. A due cut takes a band draft, or
 * falls back to the room only when the band has no draft. Final reduction and
 * room-fit checks own faults. Planner exceptions propagate. */
export function chooseCut<D extends object = {}>(input: CutInput<D> & { opportunistic: boolean }): Verdict<D> {
	const { before, mandatory, room, band, fits, plan, unreduced } = input;
	const lands = (p: Plan<D>): p is Extract<Plan<D>, { draft: true }> => p.draft && p.after < before && fits(p.after + mandatory, band);
	// A cut no one needs yet must be worth its summary: one that frees under a tenth of the room would trigger again within a round or two.
	// A due cut is not asked: it has to happen.
	const worthwhile = (p: Extract<Plan<D>, { draft: true }>) => !input.usefulOnly || !input.opportunistic || !fits(10 * (before - p.after), room);
	const preferred = plan("band");
	if (input.opportunistic) {
		if (!lands(preferred) || !worthwhile(preferred)) return { kind: "none" };
		return { kind: "cut", target: "band", plan: preferred };
	}
	let chosen: Plan<D> = preferred, target: Target = "band";
	if (!preferred.draft) { chosen = plan("room"); target = "room"; }
	if (!chosen.draft) return { kind: "fault", capacity: chosen.capacityRejected, message: chosen.reason };
	if (chosen.after >= before || !fits(chosen.after + mandatory, room))
		return { kind: "fault", capacity: !fits(chosen.after + mandatory, room), message: unreduced };
	return { kind: "cut", target, plan: chosen };
}
/** Rules 1 to 3: before any plan exists, does this request need a cut, and is a cut allowed to fail? */
export type Gate = { kind: "none" } | { kind: "defer" } | { kind: "plan"; opportunistic: boolean };
export function gateCut(input: { total: number; mandatory: number; room: number; band: number; fits: CutInput["fits"] }): Gate {
	const { total, mandatory, room, band, fits } = input;
	if (fits(total, band)) return { kind: "none" };
	const inBand = fits(total, room);
	if (!fits(mandatory, room)) return { kind: "defer" };
	return { kind: "plan", opportunistic: inBand };
}
/** Whether and how to cut at one boundary: the only decision procedure both triggers use. */
export function decideCut<D extends object = {}>(input: CutInput<D> & { total: number }): Decision<D> {
	const gate = gateCut(input);
	return gate.kind === "plan" ? chooseCut({ ...input, opportunistic: gate.opportunistic }) : gate;
}
