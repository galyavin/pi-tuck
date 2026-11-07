# Live gate of the adaptive candidate (Tier 2), on the new model setup at 81,920 tokens

Registered 2026-11-06 before any run of it. A bar set before results, as written; no reading of it is changed after the results.

## Question

In live paired sessions on the new model setup, does the adaptive candidate lose tasks, or lower the resolved count by more than the margin, against pi-tuck 1.0.11? The candidate is meant to change effectiveness (its cut trigger adapts to any window), so it carries the Tier 2 bar: at least 150 paired tasks, a one-sided 95% lower bound above −5 points, and 0 lost tasks counted separately.

## Builds

- **Arm L (base)**: pi-tuck 1.0.11, commit `b231800` (tag `v1.0.11`), exported to `runs/tuck-1.0.11`.
- **Arm O (candidate)**: commit `21fa1a4` (branch `claude/adaptive-cut-half-tail`), exported to `runs/tuck-adaptive-21fa1a4`. Its `src/`, `index.ts` and `package.json` are identical to those of `e35e21e` (checked with `git diff`); the commit adds only the merge of main. Its replay differs from the previous release's, so it keeps its live gate.
- The explicit cut point (`cutAt`) is unset on both sides: each build runs with its own default.

## Setup

- Suite `w81` (`harness/common.py`): `mac-studio/main` at thinking `xhigh`, window **81,920**, output cap 16,384, Pi's default compaction settings (`reserveTokens` 16,384, `keepRecentTokens` 20,000).
- Chains **t06 to t10**, 30 tasks each: **150 tasks per arm**, the same tasks in the same order for both arms, the 32k suite's grader. A 120-turn cap per task, **no wall cap**, and a 60-minute no-event stall guard (a stalled session is set aside and redone, never scored). Retry settings as in every live run.
- The two arms of a chain start together and run side by side, one lane each; up to 8 lanes while the allowance lasts (4 chains at once, then the fifth), 3 lanes after the next maintenance. A chain that restarts moves its partial folder aside under a free name; nothing is deleted (`harness/run_live_all.py`).
- Started by `harness/run_adaptive_gate.sh`, only on the new model setup.

## Model identity

`harness/model_fingerprint.py` saves the server's listing for `main` and a fixed completion as one `sha` at the start (F1) and every 5 minutes. The run is valid only while every sample reads F1. If the `sha` changes, the run stops; the tasks both arms finished before the change are reported as incomplete and are never pooled with tasks run on another model. A Tier 2 result needs at least 150 pairs on one model.

## Bar (Tier 2)

1. **Pairs**: at least 150 tasks finished by both arms.
2. **Resolved**: the one-sided 95% lower bound of (O − L) in resolved points, over the paired tasks, is above **−5**. Paired bootstrap over tasks, 10,000 draws, seed 1, by `analysis/v108_report.py --base L --cand O --sessions t06,t07,t08,t09,t10 --tier 2`; the chain-clustered bound is printed beside it and the registered bound decides.
3. **Lost tasks**: **0** dead tasks on O, as counted by `analysis/dead_tasks.py` (a task lost because an earlier task or prompt failed, or a refusal notice with no request after it). The base's count is reported; if L also has 0, the condition shows only that O introduced none.

## Reported with no pass line

Turns per task (ratio of means over the tasks both arms resolve, with a paired bootstrap interval); tokens per task by kind (input, cache read, cache write, output) and the billed-equivalent from a fixed price table applied afterwards to Pi's usage (the local server has no bill); cuts per task by class from the session files; mid-run refusals per arm with each hand-audited; tasks ended at the turn cap per arm; the lanes in use, the server load every 60 s and the seconds per request.

## Not claimed

Only this pair of builds, on this model setup, window and these chains. Turns and spend are reported, not claimed: an effectiveness claim needs its own bar, set before its results. Nothing about other windows, models or builds.
