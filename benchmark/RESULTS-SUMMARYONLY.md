# Summary-only retention test: pi-tuck's summary and kept messages without its recall tools

Registered in `PREREG-SUMMARYONLY.md` before any run (2026-11-05 11:33). Run 2026-11-05 13:44 to 2026-11-06 01:20 on one `mac-studio/main` lane, all 20 recordings of the main replay. Read with `analysis/replay_stats.py runs/replay --sut tuck-norecall --llms native-local` and `--llms native-terra`, exactly as registered; the two descriptive checks registered in `DEVIATIONS.md` at 2026-11-06 01:26 are in `analysis/summaryonly_extras.py`.

## Setup

- Arm `tuck-norecall`: pi-tuck 1.0.1 (`d71234a`), the build the main run measured, with `tuck_recall` and `tuck_search` removed from the active tools at session start. The summary, the cuts (`cuts-tuck.json`), the kept messages, the frozen probes, the answer model (`mac-studio/main:xhigh`) and the scorer are those of the main replay. Every answer record lists the active tools: read, bash, edit, write.
- Comparators, with their existing answers: "Pi's compaction prompts on mac-studio/main:xhigh" (`native-local`, 20 recordings) and "Pi's compaction prompts on GPT-6.1 Terra" (`native-terra`, the 19 recordings closed for the 1b-Terra test).
- Registered bar: D = accuracy of `tuck-norecall` minus accuracy of the comparator, in points, over the probes both were asked, equal weight per probe; one-sided 95% lower bound by bootstrap over recordings (10,000 draws, seed 1), the chain-clustered bound printed beside it. Supported against a comparator only if the registered lower bound is above −3 points.

## Registered result

| Comparator | D | Shared probes | Registered lower bound | Chain-clustered bound | Against the −3 bar |
|---|---|---|---|---|---|
| Pi's compaction prompts on mac-studio/main:xhigh | +6.8 | 1,496 | +0.9 | +0.8 | **supported** |
| Pi's compaction prompts on GPT-6.1 Terra | +10.5 | 1,462 | +6.1 | +6.3 | **supported** |

- Accuracy on the probes each was asked (the probe sets differ between arms): `tuck-norecall` 67.7% (1,559 probes); `native-local` 61.8% (1,677); `native-terra` 57.8% (1,685, 19 recordings). All probes in this test are mechanical, so the mechanical-only line equals D (lower bounds +1.3 and +6.3).
- Power: probes needed for a 3-point bound at 80% power (cluster-aware) are 13,216 against `native-local` and 6,517 against `native-terra`; the shared probes are 1,496 and 1,462. The test is not powered to certify a difference near the margin. Against `native-local` the lower bound is 3.9 points above the bar.
- By probe type (accuracy %, `tuck-norecall` / `native-local` / `native-terra`): error class 29.1 / 24.7 / 14.7; files changed 82.6 / 78.9 / 72.3; test-runner summary 52.5 / 31.6 / 38.1; required tag 96.4 / 99.3 / 93.3; result-line rule 97.5 / 100.0 / 100.0. The two comparators' accuracies are over their own probe sets, not paired.
- By cut number (accuracy %, `tuck-norecall` / `native-local`): cut 1 69.3 / 63.7; cut 2 65.4 / 62.0; cut 3 74.9 / 63.6; cut 4 63.9 / 60.1; cut 5 61.9 / 57.1; cut 6 57.1 / 60.7; cut 7 82.1 / 57.1; cut 8 47.6 / no probes (21 probes for `tuck-norecall`). Against `native-terra`, `tuck-norecall` is ahead at cuts 1 to 7 and behind at cut 8 (47.6 / 57.1, 21 probes).
- By probe age, in tasks back, on the shared probes (accuracy %, `tuck-norecall` / `native-local`, probes): age 1 69.6 / 64.0 (414); age 2 66.7 / 61.7 (520); age 3 72.1 / 61.0 (269); age 4 66.0 / 54.7 (159); age 5 59.4 / 57.8 (64); age 6 68.9 / 66.7 (45); age 7 80.0 / 68.0 (25). Against `native-terra`, `tuck-norecall` is ahead at every age except age 8 (40.0 / 40.0, 5 probes).

## Answers stopped by the wall: the registered rule hides a large share of the arm

The replay stops an answer after 15 minutes (the same script and wall for every arm). The registered stats drop every answer set that ended in an error, the rule of the main replay. The registration does not mention the wall.

| Arm | Answer sets stopped by the wall | Probes in those sets |
|---|---|---|
| `tuck-norecall` | 15 of 95 (all at 900 s) | 322 |
| `native-local` | 0 of 95 | 0 |
| `native-terra` | 1 of 87 | not counted |
| `tuck` (main replay, with recall tools) | 52 of 95 | not counted |

Descriptive check (a), registered before it was computed: the same pairing, bootstrap and seed, with every stopped answer set kept and its probes scored as wrong, in every arm.

| Comparator | D | Shared probes | Lower bound | Chain-clustered bound | Against the −3 bar |
|---|---|---|---|---|---|
| `native-local` | −0.8 | 1,677 | −8.2 | −10.0 | not met |
| `native-terra` | +2.2 | 1,706 | −4.7 | −6.8 | not met |

Counting the stopped sets as wrong is the worst case, not an estimate: a stopped answer might have been right had it had more time. The registered result stands as registered. Its support depends on dropping the 16% of answer sets that the arm could not finish in 15 minutes; with those sets counted as misses the lower bound does not clear the bar against either comparator.

## Other observations

- `tuck-norecall` called `tuck_recall` in 2 of the 95 answer sets (1 call and 4 calls) although the tool was not active. Pi's agent loop answers a call to a tool outside the active list with "Tool … not found", so those calls returned no data (read in `agent-loop.js`; not re-run).
- Descriptive, from the main replay and this test: pi-tuck with its recall tools scored 89.7% on its 783 probes (the 43 answer sets that finished); `tuck-norecall` scored 67.7% on its 1,559. On the 686 probes both were asked, D = −20.3 (lower bound −24.3). By probe type, with recall tools versus without: error class 80.2 versus 29.1; test-runner summary 90.1 versus 52.5; files changed 84.5 versus 82.6. The 52 answer sets of the recall-tool arm that were stopped by the wall are outside this comparison.

## What this shows, and what it does not

- Under the registered rule, pi-tuck's summary and kept messages, without its recall tools, answered the replay's mechanical probes no worse than 3 points below either comparator's summary, against only these two comparators, on this model and on these 20 recordings.
- It is not a claim about the best LLM compactors, and not a statement about recall, which this test does not measure.
- The result is sensitive to the 15 stopped answer sets of the arm (check (a)). The probes are mechanical; the judge-scored next-step probes are not in this test.
