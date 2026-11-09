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

## Restart of 2026-11-07, registered before any result of the restarted run

The first run of this gate (arms L = 1.0.11 and O = `21fa1a4`) was stopped by hand on 2026-11-06 at 22:58 with no result read, on word of a defect in the pi-tuck build that arm L ran: a prompt could be dropped when a cut kept nothing of the conversation before it (`DEVIATIONS.md`, 22:58, and the dropped-prompt sections of the result notes). Its folders are kept, unmoved in content, under `runs/live81-stopped-1`; its tasks are never pooled with this run. Everything above stands for the restarted run except what is replaced here.

**Builds, replacing the section "Builds".**
- **Arm L (base)**: pi-tuck 1.0.12, commit `e8ffa4c` (tag `v1.0.12`), exported to `runs/tuck-1.0.12`.
- **Arm O (candidate)**: commit `882f6f6` (branch `claude/adaptive-cut-half-tail`), exported to `runs/tuck-adaptive-882f6f6`. It descends from `v1.0.12` (checked with `git merge-base --is-ancestor`); against `v1.0.12` its `src/` differs in ten files (`index.ts`, `src/budget.ts`, `src/build-id.ts`, `src/compaction.ts`, `src/omissions.ts`, `src/semantic-recall.ts`, `src/tuck.ts`, `src/tuck/core/global-indices.ts`, `src/tuck/core/normalize.ts`, `src/tuck/cut.ts`); `src/assets.ts` is identical, so both arms use the cloned semantic runtime. It still reports version 1.0.12 until its release commit, which changes only the version and the notes, so the two arms are told apart by path and by the build hash in each cut's receipt (both read at the start). Its replay differs from the release's, so it keeps its live gate.
- The explicit cut point (`cutAt`) is unset on both sides.

**Lanes.** Four mac-studio lanes in all, two chains' worth of arms each: chains `t06`, `t08`, `t10` in one run and `t07`, `t09` in another, started by `SESSIONS=… LANES=2 harness/run_adaptive_gate.sh`; the two runs never share a chain.

**Bar (Tier 2), condition 3 replaced.** Conditions 1 and 2 stand as written. **Lost tasks: 0 on O**, counted as the sum of (a) dead tasks by `analysis/dead_tasks.py`, (b) tasks whose prompt was dropped at a cut: a compaction entry with reason `prompt`, `keptUserTurns` 0 and an empty `firstKeptEntryId` (`analysis/prompt_drops.py`, and `analysis/v108_report.py --count-dropped-prompts` for the bar), and (c) tasks the audit below finds started without their prompt. On these builds (b) reads zero by construction, because 1.0.12 names the prompt as the first entry a cut keeps; (c) is the check that can still find a loss. The base arm's count is printed beside it.

**Audit (c).** `analysis/prompt_evidence.py` lists, for both arms, every task whose session has a cut with reason `prompt` and whose first four assistant messages show a sign that the prompt is missing: confusion or missing-task wording, another task number named as the current one, or the previous task's tag or issue named instead of this one's. I read each listed task's first four messages and count it lost when they show the model without this task's prompt. The same signs are counted on the tasks with no cut at a prompt, as the base rate (7% of such tasks in the 1.0.10 and 1.0.11 sessions read for the dropped-prompt notes). Each arm's listing, my reading of each listed task and the controls are published with the result.

**Reported with no pass line, added.** Prompt cuts per arm and the tasks of each with signs; the lanes in use, the requests completed per minute by lanes in use, and the server's connections every 60 s (`harness/gate_load_sampler.sh`, `analysis/gate_throughput.py`).

## Later gates

One line per later gate is appended below before the gate starts (base, candidate, tier, suite, chains), and lane counts and start commands are not registered terms of any gate in this file from here on.

- 2026-11-08: base pi-tuck 1.0.15 (`85f71d5`, tag `v1.0.15`, arm L), candidate pi-tuck 1.0.16 (`dee0eab`, tag `v1.0.16`, arm O), tier 1 (at least 60 pairs, lower bound above −10 points, lost tasks counted as in the restart section), suite `w81`, chains `t06`, `t07`, `t08` (90 pairs).

- 2026-11-08 (replaces the line above before any result; its run was cut off 2 minutes after its start with no task finished): base the recorded arm O of the adaptive gate (`882f6f6`, the code of pi-tuck 1.0.13; chains `t06` and `t07` of `runs/live81`, run on 2026-11-07 on the same model sha `d2c36f5557c43295`; 1.0.14 and 1.0.15 are replay-matching patches of it), candidate pi-tuck 1.0.16 (`dee0eab`, tag `v1.0.16`) run alone as arm O in `runs/live81b`, tier 1 (at least 60 pairs, lower bound above −10 points, lost tasks counted as in the restart section), suite `w81`, chains `t06` and `t07` (60 pairs). The two arms are therefore not run side by side: the base ran on 2026-11-07 and the candidate runs on 2026-11-08, on one model sha.

- 2026-11-08: base the recorded arm O of the 1.0.16 gate (pi-tuck 1.0.16, commit `dee0eab`; chains `t06` and `t07` of `runs/live81b`, run on 2026-11-08 on model sha `d2c36f5557c43295`, replay-identical to 1.0.17), candidate pi-tuck 1.0.18 (tag `v1.0.18`, commit `2d1f830`, npm tarball shasum `ab8f23a0f525714aa08e58e9b820042a5a3c9419`) run alone as arm O in `runs/live81c`, tier 1 (at least 60 pairs, lower bound above −10 points, lost tasks counted as in the restart section), suite `w81`, chains `t06` and `t07` (60 pairs). The two arms are not run side by side.
