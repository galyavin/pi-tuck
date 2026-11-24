# Small windows: how pi-tuck decides

This page explains what pi-tuck does when the window is small or a request is close to the window. The [README](../README.md) has the short version.

Words used here:

- **Window**: the number of tokens the model accepts in one request.
- **Reply reserve**: the tokens Pi keeps free for the model's reply. It is Pi's `compaction.reserveTokens` (default 16,384).
- **Room**: the window less the reply reserve.
- **Cut**: the replacement of older turns with one summary.

## Reply room

pi-tuck starts with Pi's `compaction.reserveTokens` as the reply reserve.

A length stop with text, tool calls, or empty content can raise the reserve to at least the model's `maxTokens` for the branch. A recognized context overflow also raises it. A thinking-only length stop by itself keeps Pi's configured reserve and factors the observed output into the reply floor. A verified server clip below the sent cap uses the learned window and the existing reserve. Other errors, such as a 503, leave the reserve as it was.

pi-tuck reads this from the current branch at each decision. Resume, fork and `/tree` follow the branch. A new session starts at `reserveTokens` again. A host that passes its own reserve keeps its own.

## What pi-tuck does before it refuses a request

pi-tuck tries these steps in order:

1. Cut to the cut point (the band).
2. Cut to the room.
3. Make a smaller summary.
4. Clip a fresh tool result.

A request above the room normally needs Pi's own reply cap to leave the reply floor.

- Pi's clamp accounts for the context window, estimated input, and a safety margin. pi-tuck uses the running Pi's clamp and estimator when available. In standalone budgeting it falls back to a margin of 4,096 tokens when it cannot derive Pi's value.
- The ordinary reply floor starts at the larger of 3,584 tokens and the biggest reply seen on the branch, capped at the reserve and the model's output limit. A thinking-only length stop lets the observed reply exceed the reserve in this calculation. When a length stop or overflow raises the reserve, the raised reserve sets the floor, subject to the model's output limit.
- When the reply cap leaves less than the floor, pi-tuck cuts deeper. It re-plans up to three times. Then it uses the deepest cut that still carries the whole prompt.
- When a reply in the middle of a run is too large for any cut to fit that line, pi-tuck sends its smallest cut whenever Pi's own request math fits it in the window. It uses the reply cap that Pi's clamp leaves.

pi-tuck refuses when it cannot produce a request that fits the applicable input and reply limits. The refusal names what does not fit.

pi-tuck protects the starting prompt's text in each request. If that text cannot fit after every reduction, pi-tuck stops the run and tells the operator to shorten the prompt or use a larger window. A custom starting message with no text has nothing to quote and can fall out of context after an in-run cut.

Each refusal, and each request sent above the room, leaves one `pi-tuck-capacity` entry in the session. The model never sees it. It does not appear in summaries or recall.

## After a reply that stops for length

When a thinking-only reply reaches the model's full output limit, pi-tuck preserves it in the transcript. A configured llama.cpp provider can extend that same reply once if it verifies cache reuse. For a thinking-only stop at a smaller cap, pi-tuck can retry after a cut that frees reply room. The retry leaves the stopped reply out of the model's request and keeps it in the session. [Continuation settings](../README.md#settings)

When a run ends at the output limit, pi-tuck reports whether the response stopped during thinking or may contain a cut-off answer. It shows this operator notice in the interface, or on stderr when there is no UI.

## A server that clips replies

Some servers clip replies before reaching the requested output cap. When usage confirms a smaller usable window, pi-tuck records it in the session and can retry once within that window. Silent truncation can go undetected when the provider supplies no usable evidence.

pi-tuck drops the learned window when the model's configured window changes. For example, a server and its `models.json` can grow.

## Token counts

pi-tuck scales its estimate by the largest ratio in a rolling window of recent measurements and usable overflow bounds. A resumed session seeds calibration from the branch's saved observations for the active model.

In a small window, an upstream can spend far more context on tool schemas than other upstreams. Some OpenRouter upstreams do. The room can then be too small. If a small window refuses, use a larger window, or pin one upstream (see the README).
