# The adaptive candidate `882f6f6` against pi-tuck 1.0.12, window 81,920, chains t06 to t10 (Tier 2)

Registered in `PREREG-ADAPTIVE.md` (restart section, before any result of this run). Run on `mac-studio/main` at xhigh, suite `w81`, from 2026-11-06 23:32 to 2026-11-07 13:26 by the clock of the machine that ran it, ten sessions of 30 graded tasks, read with `analysis/v108_report.py --base L --cand O --sessions t06,t07,t08,t09,t10 --tier 2 --count-dropped-prompts`. An earlier start of this gate (1.0.11 against `21fa1a4`) was stopped by hand with no result read; its folders are kept apart and none of its tasks is pooled (`DEVIATIONS.md`, entry of 22:58).

## Setup

- Arm L (base): pi-tuck 1.0.12, commit `e8ffa4c`. Arm O (candidate): `882f6f6`, which descends from 1.0.12 and differs in ten `src/` files. No `cutAt` on either side.
- Suite `w81`: window 81,920, reserve 16,384, `keepRecentTokens` 20,000, 120 turns per task, no wall cap, 60-minute stall guard. Chains t06 to t10, 150 paired tasks, the same tasks in the same order in both arms.
- One model throughout: the fingerprint was sampled at the start and every 5 minutes, 167 samples, every one `d2c36f5557c43295`; the longest gap between samples was 308 s. No task was aborted or ended in a provider error, and no session was set aside.

## The registered bar (Tier 2)

| # | Condition | Arm L | Arm O | Result |
|---|---|---|---|---|
| 1 | At least 150 tasks finished by both arms | 150 | 150 | **met** |
| 2 | One-sided 95% lower bound of resolved (O − L) above −5 points | 131 of 150 | 131 of 150 | difference +0.0, lower bound −1.3 (paired bootstrap, 10,000 draws, seed 1): **met** |
| 3 | 0 lost tasks on O (dead tasks, tasks whose prompt was dropped at a cut, tasks the audit finds started without their prompt) | 0 | 0 | **met** |

**O meets the Tier 2 bar as registered.** The lower bound over the five chains (resampling chains, 10,000 draws, seed 1) is also −1.3. Per chain, resolved difference in points: t06 0.0, t07 −3.3, t08 0.0, t09 0.0, t10 +3.3. The two tasks that differ had no cut in either arm: t07 task 11 (`django__django-14311`) was resolved by L and not by O, and t10 task 23 (`django__django-13297`) by O and not by L.

## Lost tasks, in the three parts registered

- (a) Dead tasks (`analysis/dead_tasks.py`): 0 in L, 0 in O. Mid-run refusals: 0 and 0.
- (b) Dropped prompts (a compaction entry with reason `prompt`, `keptUserTurns` 0 and an empty `firstKeptEntryId`; `analysis/prompt_drops.py`): 0 in L, 0 in O. Every cut at a prompt (5 in L, 6 in O) carries a non-empty `firstKeptEntryId`.
- (c) Audit (`analysis/prompt_evidence.py`, then a reading of the first messages): the sign filter listed 0 tasks in L and 0 in O. All 11 tasks with a cut at a prompt were also read by hand, and in every one the model's first messages work on that task (they name its issue and the upstream fix): L tasks t07-13, t08-15, t08-20, t09-23, t10-27; O tasks t06-21, t07-3, t07-24, t08-4, t08-14, t08-17. Four of the cuts kept no earlier turn (t08-L 15, t09-L 23, t10-L 27, t08-O 17) and the prompt still reached the model. The same signs on tasks with no cut at a prompt, the base rate: 9 of 140 in L, 5 of 139 in O.

## Readouts with no pass line

| | Arm L | Arm O |
|---|---|---|
| Resolved of 150 | 131 | 131 |
| Turns per task (all 150) | 20.88 | 20.07 |
| Turns per task on the 130 tasks both resolved | 20.02 | 18.98 |
| Cuts (compaction entries) | 108 | 95 |
| Cuts per task (at run end / in the loop) | 0.72 (0.05 / 0.67) | 0.63 (0.03 / 0.60) |
| Cuts by reason | tool-loop 96, run-end 6, prompt 5, threshold 1 | tool-loop 84, run-end 4, prompt 6, threshold 1 |
| Tasks ended at the turn cap | 0 | 0 |
| Input / output / cache-read tokens | 4.73 M / 1.11 M / 89.02 M | 4.27 M / 1.05 M / 86.33 M |
| Cache-write tokens | 0 | 0 |
| Seconds per task (mean) | 397 | 336 |
| `tuck_recall` calls | 116 | 101 |

- Paired O minus L: turns −0.81 per task (95% upper bound +0.43); on the 130 tasks both resolved, the ratio of mean turns is 0.949 (95% interval 0.874 to 1.029, paired bootstrap, 10,000 draws, seed 1). Seconds per task: ratio 0.847 (95% interval 0.706 to 1.015). Neither interval excludes 1.
- Tokens: O sent 9.8% fewer input, 5.9% fewer output and 3.0% fewer cache-read tokens than L (3.4% fewer in total). No price table was registered and the local server has no bill, so no billed-equivalent figure is computed; with any fixed non-negative price table, O's billed-equivalent is lower than L's by an amount between 3.0% and 9.8%, because it is a weighted mean of those per-kind ratios (`DEVIATIONS.md`, entry of 13:33).
- Lanes (not registered terms, reported): chains ran on 1 to 4 lanes. Completed requests per minute, all lanes together: 2.72 on 1 lane (170 min), 7.62 on 2 (455 min), 10.04 on 3 (57 min), 10.86 on 4 (151 min), measured on a server shared with other jobs; median 7 s per request (`analysis/gate_throughput.py`).

## Not claimed

Only this pair of builds, on this model setup, window and these chains, one run per arm. The resolved result is a bound, not a gain: the data are compatible with a small difference either way, and the lower bound is −1.3 points. Turns, tokens and seconds are reported, not claimed: an effectiveness claim needs its own bar, set before its results. Nothing about other windows, models or builds, and nothing about retention past the cuts of these tasks.
