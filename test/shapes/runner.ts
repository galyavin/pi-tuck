import { performance } from 'node:perf_hooks';
import { convertToLlm, estimateTokens } from '@earendil-works/pi-coding-agent';
import { harness } from '../budget-fixture';
import { body, checkCut, checkPrompt, checkRefusal, type Finding, type Rule } from './checks';
import { KEEP_RECENT, RESERVE, text, type Shape } from './generator';

export interface Failure extends Finding { at: string }
export interface Row {
  shape: string; window: number; prompts: number; requests: number; cuts: number;
  answered: number; refused: number; clips: number; milliseconds: number;
  checks: Record<Rule, number>; failures: Failure[]; errors: string[];
}

/** Use the stress suite's real Pi fixture, default adaptive cut, and scripted provider. All observations
 * come from actual stream requests or Pi's entry_appended event, including run-end and intermediate cuts. */
export async function runShape(shape: Shape): Promise<Row> {
  const started = performance.now();
  const row: Row = { shape: shape.name, window: shape.window, prompts: shape.turns.length, requests: 0, cuts: 0,
    answered: 0, refused: 0, clips: 0, milliseconds: 0,
    checks: { 'current-prompt': 0, openings: 0, omissions: 0, refusal: 0 }, failures: [], errors: [] };
  let roundEnd = 0, resultSize = 0, current = '', prompt = 0, requestInPrompt = 0;
  const h = await harness({ at: 'prompt', complete: 0, host: 0, noHistory: true, noOpening: true, oneTurn: true,
    cutAtDefault: true, systemTokens: 256, reserveTokens: RESERVE, keepRecent: KEEP_RECENT,
    limits: { contextWindow: shape.window, maxTokens: 8_192 }, usageRatio: 1, rejectOverWindow: true,
    toolCalls: request => request <= roundEnd, toolResultTokens: () => resultSize,
  });
  const record = (at: string, checked: Rule[], findings: Finding[]) => {
    for (const rule of checked) row.checks[rule]++;
    row.failures.push(...findings.map(finding => ({ at, ...finding })));
  };
  const inspect = (at: string, inspectView: () => void) => {
    try { inspectView(); } catch (error) { row.errors.push(`${at}: ${String(error)}`); }
  };
  const unsubscribe = h.session.subscribe(event => {
    if (event.type !== 'entry_appended' || event.entry.type !== 'compaction') return;
    row.cuts++;
    const reason = (event.entry.details as { diagnosticReceipt?: { reason?: string } } | undefined)?.diagnosticReceipt?.reason ?? 'native';
    const at = `p${prompt}/r${requestInPrompt}/saved-${reason}`;
    inspect(at, () => record(at, ['openings', 'omissions'], checkCut(convertToLlm(h.saved()), h.manager.getEntries())));
  });
  // Give results distinct bodies without changing their requested text estimate or bypassing Pi's tool execution.
  h.extension().on('tool_result', event => event.toolName === 'effect' ? {
    content: [{ type: 'text', text: text(`${shape.name}/tool/${event.toolCallId}`, resultSize) }],
  } : undefined);
  const scripted = h.session.agent.streamFunction!;
  h.session.agent.streamFunction = (model, context, options) => {
    const before = h.state.requests;
    const stream = scripted(model, context, options);
    // Pi may call the stream seam with an already-aborted signal after a guard refusal. The
    // stress provider returns locally in that case; it made no request and created no reply.
    if (h.state.requests === before) return stream;
    requestInPrompt++;
    const at = `p${prompt}/r${requestInPrompt}/request`;
    inspect(at, () => {
      record(at, ['current-prompt'], checkPrompt(context.messages, current));
      if (context.messages.some(message => /(?:TUCK|VCC)-TRANSCRIPT\/[12]\n/.test(body(message.content))))
        record(at, ['openings', 'omissions'], checkCut(context.messages, h.manager.getEntries()));
    });
    // The fixture creates and queues these message objects synchronously. Their identity is shared by
    // its event stream and state.answers; edit before Pi consumes the stream, keeping usage and protocol.
    const answer = h.state.answers.at(-1)!;
    if (answer.stopReason === 'stop' || answer.stopReason === 'toolUse') {
      const content = text(`${shape.name}/assistant/p${prompt}/r${requestInPrompt}`, 120);
      if (answer.stopReason === 'stop') answer.content = [{ type: 'text', text: content }];
      else answer.content.unshift({ type: 'text', text: content });
    }
    return stream;
  };
  try {
    for (const turn of shape.turns) {
      prompt++;
      requestInPrompt = 0;
      current = text(`${shape.name}/user/${prompt}/${turn.label}`, turn.tokens, turn.format);
      const stopsBefore = h.state.stops.length, effectsBefore = h.state.effects;
      roundEnd = h.state.requests + turn.results.length;
      resultSize = turn.results[0] ?? 1;
      const remove = h.extension().on('tool_result', () => {
        // The first result already used results[0]; set the next round's size after its result hook.
        resultSize = turn.results[h.state.effects - effectsBefore] ?? 1;
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // The deadline aborts Pi rather than leaving a timed-out test with a live turn.
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => { void h.session.abort(); reject(new Error('prompt exceeded 30s')); }, 30_000);
        });
        await Promise.race([h.session.prompt(current), timeout]);
      } catch (error) { row.errors.push(`p${prompt}: ${String(error)}`); }
      finally { clearTimeout(timer); remove(); }
      const answered = h.state.stops.slice(stopsBefore).includes('stop');
      if (answered) row.answered++; else row.refused++;
      record(`p${prompt}/end`, ['refusal'], checkRefusal(answered, estimateTokens({ role: 'user', content: current, timestamp: 0 }), shape.window - RESERVE));
      // A tool loop must actually run to completion, unless this is the legitimate above-room input.
      if (answered && h.state.effects - effectsBefore !== turn.results.length)
        row.errors.push(`p${prompt}: ran ${h.state.effects - effectsBefore} of ${turn.results.length} scripted tool rounds`);
    }
    row.requests = h.state.requests;
    row.clips = h.state.clips;
    row.errors.push(...h.faults.filter(fault => !/cannot fit|exceeds|mandatory|budget|room/i.test(fault)).map(fault => `fixture: ${fault}`));
    if (!row.cuts) row.errors.push('hollow: shape saved no cuts');
    if (!row.checks['current-prompt'] || !row.checks.openings || !row.checks.omissions) row.errors.push('hollow: not all request/cut checks ran');
    if (shape.name === 'huge-tool-results' && !row.clips) row.errors.push('hollow: no huge result reached the provider as a clip');
    return row;
  } finally {
    unsubscribe();
    await h.cleanup();
    row.milliseconds = Math.round(performance.now() - started);
  }
}
