# Abort check: why the answer sets of the two recall arms of the main replay ended in "This operation was aborted"

Registered 2026-11-06 before any run of it. It explains a failure; it is not a retention test and no retention claim is made from it.

## Why

In the main replay the two arms with recall tools lost many answer sets: `tuck` 52 of 95 and `tuck-lexical` 47 of 95 ended with the error "This operation was aborted", after 1.4 to 8.7 minutes, so not at the replay's 15-minute wall. The failures rise with the cut number (`tuck`: 1 of 20 sets at cut 1, 6 of 20 at cut 2, 13 of 20 at cut 3, 12 of 15 at cut 4, and every set at cuts 5 to 8; `tuck-lexical` the same shape). The two comparators lost 0 and 1 sets. The cause is not established.

pi-tuck 1.0.1 ends a run (`ctx.abort()`) when its capacity check refuses a request, and shows the reason as a UI notice. The replay has no UI, so the reason is lost. Hypothesis, to be tested and not assumed: the request (the summary, the kept messages, the text the agent recalled, the system prompt) outgrew the 95,232-token room (window 128,000 minus reserve 32,768), and because the replay runs with Pi's compaction off, the in-run cut path of the 1.0.1 build returns early while its capacity check still runs, so the run is ended instead of being cut.

## Sets

Three `tuck-lexical` answer sets that failed at cut 5 or later, one from each of three recordings. Rule, fixed before any run: among the 8 recordings with such a failure (s01-A, s03-B, s04-A, s04-B, s05-A, s06-B, s09-A, s09-B), the first, the middle and the last in name order that give three different chains, each at its lowest failing cut at or after 5:

| Recording | Cut | Probes | Main replay, `tuck-lexical` |
|---|---|---|---|
| s01-A | 5 | 22 | aborted after 4.3 min, 21 requests, 24 recall or search calls |
| s05-A | 5 | 22 | aborted after 3.1 min, 20 requests, 19 recall calls |
| s09-B | 5 | 22 | aborted after 1.8 min, 22 requests, 37 recall or search calls |

## Setups

Everything else as in the main replay: `mac-studio/main:xhigh`, window 128,000 and reserve 32,768 (`replay/lib.ts`), the same recordings, the same cuts file (`cuts-tuck.json`, not regenerated), the same frozen probes and prompt, the same retry settings, the same 15-minute wall, variant `tuck-lexical` (semantic search off).

- **A**: pi-tuck `d71234a` (`runs/tuck-1.0.1`, the measured build), Pi's compaction off, as in the main replay.
- **B**: pi-tuck `v1.0.10` (commit `ce06975`, `runs/tuck-1.0.10`), Pi's compaction on with `reserveTokens` 32,768 and `keepRecentTokens` 20,000 (the replay's own constants for the live arms' effective settings).

One run per set and setup: six runs on one mac-studio lane, in sequence. `replay/abortcheck.ts` is `replay/answer.ts` with observers only: the compaction setting is a flag, the extension's `fail` option records every refusal it raises, and each record lists every request of the session. Output goes to new folders under `runs/abortcheck/`; no existing answer or score is touched.

## Recorded for each run

Ended or aborted; seconds; every refusal the extension raised (class, text, messages and characters of the session at that moment); every request (stop reason, error text, token usage) and every tool result (characters); Pi's compaction events (B); the answer text.

## Readout, fixed before the runs

- A run is **refused for capacity** if the extension raised a capacity refusal ("cannot fit" or "exceed" the estimated request budget) before the abort; **aborted without a refusal** if it aborted with no refusal record; **answered** if the session finished without error.
- The hypothesis is supported only if in setup A every run that aborts shows a capacity refusal and the session had grown to the room's order of size (the last request's input tokens against 95,232, and the characters of the session at the refusal). If any aborted run shows no refusal, or a different refusal, that is reported and the hypothesis is not supported as stated.
- In setup B, a run that aborts is reported with the refusal text and the source line that raises it. A run that answers shows that the cut path or the compaction setting is what differs.
- Six runs cannot give a failure rate: they say what happened in these runs and which code path did it.

## Addendum 2026-11-06 (see DEVIATIONS.md, entry of the restart)

- The pending runs start side by side, one lane each; the server load is sampled into `runs/abortcheck/load.log` and the request times are in each record.
- A run that ends at the 15-minute wall is reported as wall-bound and counts as evidence for neither reading (an early abort, or an answer). Only a run that ends before the wall can show either.
