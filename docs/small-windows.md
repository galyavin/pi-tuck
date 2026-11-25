# Small windows: how pi-tuck decides

This page explains what pi-tuck does when the window is small or a request is close to the window. The [README](../README.md) has the short version.

Words used here:

- **Window**: the context window configured for the active model in Pi.
- **Reply reserve**: the target for leaving space for a reply, set by Pi's `compaction.reserveTokens` (default 16,384).
- **Room**: the window less the reply reserve.
- **Cut**: the replacement of older turns with one summary.

## Reply room

In standalone use, pi-tuck uses Pi's configured reserve as the cut target. A length stop or context overflow leaves that reserve in place.

For a request above the room, pi-tuck estimates the reply floor from observed output for the active provider, API, and model on the current branch. It ignores errored and aborted responses. The floor starts at one token without comparable usage and is capped by the reserve and the model's positive output limit.

Resume, fork, and `/tree` use the selected branch's observed reply sizes. An SDK host can provide a separate reserve. `responseExact: true` uses the host's declared value. Otherwise the host reserve is at least the model's configured output limit.

## What pi-tuck does before it refuses a request

pi-tuck tries these steps in order:

1. Cut to the cut point (the band).
2. Cut to the room.
3. Make a smaller summary.
4. Clip a fresh tool result.

A request above the room normally needs Pi's own reply cap to leave the reply floor.

- Pi's clamp accounts for the context window, estimated input, and a safety margin. pi-tuck uses the running Pi's clamp and estimator when available. In standalone budgeting it falls back to a margin of 4,096 tokens when it cannot derive Pi's value.
- Pi's clamp can return one token when its estimate leaves no room. pi-tuck checks for room before accepting that result.
- When the reply cap leaves less than the floor, pi-tuck cuts deeper. It re-plans up to three times. Then it uses the deepest cut that still carries the whole prompt.
- For standalone requests outside a length retry, pi-tuck can fall back to its smallest cut when Pi's own request estimate still fits the window. This fallback is unavailable with a host reserve or a host input ceiling.

pi-tuck refuses when it cannot produce a request that fits the applicable input and reply limits. The refusal names what does not fit.

pi-tuck protects the starting prompt's text in each request. If that text cannot fit after every reduction, pi-tuck stops the run and tells the operator to shorten the prompt or use a larger window. A custom starting message with no text has nothing to quote and can fall out of context after an in-run cut.

Each refusal, and each request sent above the room, leaves one `pi-tuck-capacity` entry in the session. The model never sees it. It does not appear in summaries or recall.

## After a reply that stops for length

When a thinking-only reply reaches the model's full output limit, pi-tuck preserves it in the transcript. A configured llama.cpp provider can extend that same reply once if it verifies cache reuse. For a thinking-only stop at a smaller cap, pi-tuck can retry once per run when a cut increases the estimated reply cap and leaves the reply floor. The retry leaves the stopped reply out of the model's request and keeps it in the session. [Continuation settings](../README.md#settings)

When a run ends at the output limit, pi-tuck reports whether the response stopped during thinking or may contain a cut-off answer. It shows this operator notice in the interface, or on stderr when there is no UI.

## A server that clips replies

Some servers clip replies before reaching the requested output cap. A length stop alone cannot distinguish a smaller context window from an independent output limit. pi-tuck uses the configured window and ignores inferred-window entries from older versions. Set the model's `contextWindow` to the effective server limit if it is smaller. Silent truncation can go undetected without usable provider evidence. [Pi request boundary proposal](pi-request-boundary.md)

## After an overflow

When Pi offers a standalone overflow recovery cut and pi-tuck has a request estimate to compare, the cut must preserve the task prompt and reduce both the estimated input and the estimated input plus output cap. Pi may change the final request after this check.

## Token counts

pi-tuck scales its estimate using recent usage observations and planning factors derived from reported overflows. An overflow-derived factor assumes the configured window applies and is subject to a calibration ceiling. The provider's error alone cannot verify that assumption. A resumed session seeds calibration from the branch's saved observations for the active model.

In a small window, an upstream can spend far more context on tool schemas than other upstreams. Some OpenRouter upstreams do. The room can then be too small. If a small window refuses, use a larger window, or pin one upstream (see the README).
