/** Sizes are Pi's text estimate (ceil(UTF-16 characters / 4)), not word counts. */
export const WINDOWS = [32_768, 81_920, 131_072] as const;
export const RESERVE = 16_384;
export const KEEP_RECENT = 20_000;

export interface Turn {
  label: string;
  tokens: number;
  results: number[];
  format?: 'logs';
}
export interface Shape {
  name: string;
  window: number;
  turns: Turn[];
}

/** Distinct start AND body: losing one turn must not be hidden by another turn's repeated filler.
 * The first 80 characters deliberately include newlines, tabs, quotes and a literal backslash-n. */
export function text(label: string, tokens: number, format?: Turn['format']): string {
  const head = `[${label}]\n"quoted"\tpath\\name; literal \\n. Keep the recorded instruction.\n`;
  const line = format === 'logs'
    ? `2026-11-08T12:34:56.789Z WARN [${label}] request_id=2e41 status=503 retry=3 elapsed_ms=471 path=src/worker.ts:82\n`
    : `${label}: inspect the recorded state, report the result, then continue.\n`;
  return (head + line.repeat(Math.ceil(tokens * 4 / line.length))).slice(0, tokens * 4);
}

export function shapes(window: number): Shape[] {
  const turn = (label: string, tokens: number, results: number[] = []): Turn => ({ label, tokens, results });
  const steering = (long: boolean): Turn[] => [
    turn('specification', 8_000, [3_000]),
    ...Array.from({ length: 220 }, (_, i) => ({ ...turn(`steering-${i + 1}`, long ? 1_000 + i % 3 * 1_000 : 50,
      // Short steering alone cannot fill the largest room. Real work between inputs does.
      [long ? 500 : 1_000]), ...(long ? { format: 'logs' as const } : {}) })),
  ];
  const tasks = (long: boolean): Turn[] => Array.from({ length: 6 }, (_, task) => {
    const tokens = [8_000, 18_000, 25_000][task % 3]!;
    const steps = [6, 8, 11][task % 3]!;
    return [turn(`task-${task + 1}`, tokens), ...Array.from({ length: steps }, (_, step) =>
      turn(`task-${task + 1}-step-${step + 1}`, long ? Math.ceil(tokens / steps) + 200 : 50, [3_000]))];
  }).flat();
  return [
    { name: 'one-prompt-tool-run', turns: [turn('only-prompt', 2_000, Array(48).fill(4_000))] },
    { name: 'spec-short-steering', turns: steering(false) },
    { name: 'spec-long-steering', turns: steering(true) },
    { name: 'tasks-short-steps', turns: tasks(false) },
    { name: 'tasks-long-steps', turns: tasks(true) },
    { name: 'tool-heavy-step', turns: [turn('specification', 8_000),
      ...Array.from({ length: 10 }, (_, i) => turn(`lead-in-${i + 1}`, 50, [1_000])),
      turn('long-step', 3_000, Array(36).fill(6_000))] },
    { name: 'huge-tool-results', turns: [turn('specification', 2_000),
      turn('huge-result-step', 1_000, [window * 2, window * 3, window * 2]),
      turn('continue-after-huge-results', 50, [2_000])] },
  ].map(shape => ({ ...shape, window }));
}
