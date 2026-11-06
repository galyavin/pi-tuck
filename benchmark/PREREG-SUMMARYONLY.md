# PREREG addendum: a summary-only retention test for pi-tuck (replay, main-run recordings)

Written 2026-11-05, before any run of this test and before any answer of this arm exists. `PREREG.md`, `PREREG-TERRA.md` and `PREREG-CLUSTER.md` are unchanged and stay the frame. This test does not replace test 1a or test 1b-Terra and changes neither.

**Why.** In tests 1a and 1b-Terra pi-tuck answered the probes with `tuck_recall` and `tuck_search`, while the two comparators answered from their summary and the kept recent messages alone (`RESULTS-MAIN.md`). Those tests therefore compare pi-tuck's summary together with its recall tools against summaries alone. This test removes pi-tuck's recall tools, so that it answers from its summary and kept recent messages alone, as the comparators did.

## Arm and data

- **Arm `tuck-norecall`**: pi-tuck 1.0.1 (`d71234a`, `runs/tuck-1.0.1`, the build the main run measured). The extension is loaded as in the main replay, so the summary and the kept messages are the same; `tuck_recall` and `tuck_search` are removed from the active tools at session start (`setActiveTools`), and each answer record logs the active tool names as evidence. The agent keeps Pi's built-in tools, as the comparators' agents had.
- **Same data as the main replay**: the 20 recordings, the same cuts (`cuts-tuck.json`, so the summaries are the very ones tests 1a and 1b-Terra used), the same frozen probes (`probes.json`), the same answer model `mac-studio/main:xhigh`, and the same scoring (`replay/score.ts`). Nothing is re-run for the comparators: their existing answers are used, **"Pi's compaction prompts on mac-studio/main:xhigh"** on all 20 recordings and **"Pi's compaction prompts on GPT-6.1 Terra"** on the 19 recordings the maintainers closed the set at (s09-A missing, Codex cap; chain s09 carries only its B recording in the clustered bound).
- The probes both variants were asked are chosen by the registered rule (`paired` and `usable` in `analysis/replay_stats.py`), with the `tuck` cuts, so the probe set is the same as in tests 1a and 1b-Terra (783 and 728 probes, all mechanical; the next-step probes are not in it). A run that fails is excluded as `failed`, as in the registered script.

## Bar

The registered one, for each comparator: D = accuracy(`tuck-norecall`) minus accuracy(comparator) in points over the shared probes, equal weight per probe; one-sided 95% lower bound by bootstrap over recordings (10,000 draws, seed 1), with the chain-clustered bound of `PREREG-CLUSTER.md` printed beside it. **Supported** for a comparator only if the registered lower bound is above −3 points; the registered bound decides, and the text says plainly if the clustered bound disagrees. Run with `analysis/replay_stats.py runs/replay --sut tuck-norecall --llms native-local` (20 recordings) and `--llms native-terra` (19).

## Reported whichever way it comes out

D and both bounds for each comparator; by probe type, cut number and age; probes needed for a 3-point bound; pi-tuck's accuracy with and without its recall tools on the same probes (from tests 1a and this test; descriptive). It is stated under the registered "not claimed" rule: only against the comparators named above, never as "the best LLM compactors", and not as a statement about recall, which this test does not measure.

## Power (stated before the result)

From `analysis/power_1b.py` on the spread of the 20 recordings: at a true difference of 0 the median lower bound is −3.7 and clears −3 in 38% of simulated studies (45% chain-clustered); at +2 points in 75% (79%); at +4 points in 95% (97%). A result near parity is therefore reported as underpowered rather than as a failure or a success.

## Lane and order

One shared mac-studio lane (the limit is 2 lanes in total across all workers and tests). Order of runs set by the maintainers: the thinking-level pilot, the 1.0.11 gate, this test, then cut-later; it may run beside the gate if the gate leaves a lane free. Expected duration: about 2 to 3 hours on one lane (the no-tool answers of the local comparator took 1.8 hours for 18 recordings; this arm makes no tool calls and its larger summary adds prompt time), plus scoring.

## Limits (stated before the result)

- Same model, same probes, same recordings as the main run, so the limits of `RESULTS-MAIN.md` apply: fixed-size SWE-bench-style tasks, one local model, one build.
- The probe set is fixed by the registered rule and the `tuck` cuts, so it excludes facts that pi-tuck's own kept tail still held.
