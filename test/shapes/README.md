# Session shape generator

Part 1 only: real Pi sessions and outcome checks. No production changes. The same `budget-fixture.ts` and scripted model used by the settings stress test drive every prompt and tool round; the adaptive default, reserve 16,384, output cap 8,192 and keepRecent 20,000 apply throughout.

```sh
# Opt in alongside the existing stress test. About a minute per build when run alone.
SHAPES=1 npx vitest run test/shapes --testTimeout=300000

# Report every finding, without the v1.0.16 regression gate (historical comparisons).
node test/shapes/compare.mjs /tmp/pi-shapes-results

# Focus a cell; write all observations, including the first missing source indices.
SHAPES=1 SHAPES_ONLY=huge-tool-results/32768 SHAPES_REPORT=/tmp/shape.json npx vitest run test/shapes

# Require the final contract to pass, including known baseline failures.
SHAPES=1 SHAPES_STRICT=1 npx vitest run test/shapes
```

Normal runs execute the small oracle tests and skip the 21 session cells. `SHAPES=1` reports the known findings and fails on a new failure at any logical prompt/request or saved-cut boundary that passed on v1.0.16. Harness exceptions, missing cuts and huge-result cells that never clip always fail. `SHAPES_STRICT=1` fails on every finding. The checked-in baseline records failed assertions, so an improvement requires no baseline update. `SHAPES_RECORD_BASELINE=1` bypasses that baseline comparison; it does not rewrite the baseline.

`compare.mjs` exports v1.0.16, v1.0.15 and 7bcd355 into temporary directories, replaces each export's `test/` with this tree's tests, links the existing dependencies, and runs the generator in each export. It writes a comparison table and full JSON observations to the requested output directory, then deletes its exports. It does not change Git state or another worktree. Known findings are reports for historical builds; harness failures still fail the comparison.

The seven shapes are one prompt with 48 tool rounds; an 8k specification with 220 short steering turns; the same with 1k–3k turns containing timestamped pasted logs; six tasks of 8k, 18k and 25k with 6–11 short steps; the same with long steps whose combined size exceeds each task; one long step with 36 tool results filling its tail; and results of two or three whole context windows. Every shape runs at 32,768, 81,920 and 131,072. Text sizes are exact under Pi's estimator. Every source has distinct text; its opening includes newlines, quotes, a tab and a literal backslash sequence.

The observations are model requests from the scripted stream and each `entry_appended` compaction event, including prompt cuts, tool-loop cuts and run-end cuts. A call with an already-aborted signal makes no provider request and is excluded, as in the stress fixture. Requests carrying a summary are checked even when no additional cut occurred, so a later request cannot hide a lost opening. Saved-cut checks use Pi's converted projection, and request checks use the actual provider messages. No planner drafts stand in for cuts.

The checks require:

- **Current prompt:** its complete, exact text in every actual request. A quoted opening cannot pass this check.
- **Openings:** the first prompt and newest eight answered user turns each retain their first 80 characters in either summary excerpts or the native tail. The public transcript reader decodes summary escapes once; raw tail text stays untouched. Error/aborted replies do not make a turn answered; a successful tool-use reply does.
- **Omissions:** enumerate original session-file message indices independently; compare every user text, assistant text block (the units `shrinkDialogue` ranks), and tool result against the request/projection. A partially retained unit also needs an omission. An individual source omission counts one unit; an aggregate can spend only its declared count, and each covered unit must have its own original source pointer. A truncated aggregate locator list does not account for its unlisted sources. Inline fresh-result clips count as one omission when they carry their exact source locator. An action/file heading or generic “use tuck_recall” notice is insufficient. Tool-call blocks are actions, outside the assistant text-unit check.
- **Refusal:** a turn without a final answer may refuse only when its current prompt alone does not fit `window − reserve`. The shapes' legitimate refusals are 18k/25k tasks in the 16,384-token room; other history and tool results must give way. This check deliberately does not exempt large fresh assistant text or tool results.

Opening **80** is the requested test threshold. This part does not choose or implement the room-derived opening allocation for Part 2.

See [RESULTS.md](./RESULTS.md) for the comparison and representative failures; [v1.0.16.json](./v1.0.16.json) preserves the passing assertions for the next part.
