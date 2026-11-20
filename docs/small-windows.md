# Small windows: how pi-tuck decides

This page explains what pi-tuck does when the window is small or a request is close to the window. The [README](../README.md) has the short version.

Words used here:

- **Window**: the number of tokens the model accepts in one request.
- **Reply reserve**: the tokens Pi keeps free for the model's reply. It is Pi's `compaction.reserveTokens` (default 16,384).
- **Room**: the window less the reply reserve.
- **Cut**: the replacement of older turns with one summary.

## Reply room

pi-tuck keeps the same reply room as native Pi: Pi's `compaction.reserveTokens`.

The reserve rises to the model's `maxTokens` for the rest of the branch only after a reply on that branch did not fit. A reply that did not fit is one that stopped for length, or a request that the provider refused as a context overflow. A transient error, such as a 503, keeps the native room.

pi-tuck reads this from the current branch at each decision. Resume, fork and `/tree` follow the branch. A new session starts at `reserveTokens` again. A host that passes its own reserve keeps its own.

## What pi-tuck does before it refuses a request

pi-tuck tries these steps in order:

1. Cut to the cut point (the band).
2. Cut to the room.
3. Make a smaller summary.
4. Clip a fresh tool result.

A request above the room goes out only if Pi's own reply cap still leaves the reply floor.

- Pi sets each request's reply cap to the window, less its own estimate of the request, less a safety margin of 4,096 tokens. pi-tuck loads Pi's own clamp and estimator from the running Pi. A host that embeds Pi falls back to the same margin.
- The reply floor is the larger of two values: the biggest reply seen on the branch, and 3,584 tokens. The model's own reply cap limits it. After a reply that did not fit, the floor is the reply reserve.
- When the reply cap leaves less than the floor, pi-tuck cuts deeper. It re-plans up to three times. Then it uses the deepest cut that still carries the whole prompt.
- When a reply in the middle of a run is too large for any cut to fit that line, pi-tuck sends its smallest cut whenever Pi's own request math fits it in the window. It uses the reply cap that Pi's clamp leaves.

pi-tuck refuses a request only past the window. The refusal names what does not fit.

A run's request always carries the whole prompt that started the run. If the prompt cannot fit after every reduction, pi-tuck stops the run. The notice says to shorten the prompt or use a larger window.

Each refusal, and each request sent above the room, leaves one `pi-tuck-capacity` entry in the session. The model never sees it. It does not appear in summaries or recall.

## After a reply that stops for length

When a reply stops for length with thinking only, pi-tuck retries the turn once. The retry leaves the stopped reply out of the request. It uses the deepest cut that still carries the whole prompt when that gives the reply more room. Otherwise it retries without a cut. If the retried reply stops again, the run ends.

When a run ends on a reply cut at the output limit, pi-tuck says so: "the last reply stopped at the model's output limit and may be cut off". It shows the notice in the interface, or on stderr when there is no UI. The model never sees the notice.

## A server that clips replies

Some servers clip replies below the window that the model configures. When this happens, pi-tuck learns the smaller window and keeps it in the session. It plans with that window and retries the turn once.

pi-tuck drops the learned window when the model's configured window changes. For example, a server and its `models.json` can grow.

## Token counts

pi-tuck estimates the size of a request. It scales the estimate by the worst gap it has seen between its count and the provider's count. A resumed session keeps what pi-tuck learned about that gap.

In a small window, an upstream can spend far more context on tool schemas than other upstreams. Some OpenRouter upstreams do. The room can then be too small. If a small window refuses, use a larger window, or pin one upstream (see the README).
