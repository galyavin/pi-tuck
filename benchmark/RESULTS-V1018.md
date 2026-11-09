# pi-tuck 1.0.18 against the recorded 1.0.16 arm, window 81,920, chains t06 and t07 (Tier 1)

Registered in `PREREG-ADAPTIVE.md` ("Later gates", the line for pi-tuck 1.0.18) before the run started. pi-tuck 1.0.18 (tag `v1.0.18`, commit `2d1f830`) ran alone as arm O on `mac-studio/main` at xhigh, `w81` settings in its own results folder, 60 tasks (chains t06 and t07, 30 tasks each), on two lanes from 2026-11-08 18:55 to 2026-11-09 about 01:40. The build is the unpacked npm tarball (shasum `ab8f23a0f525714aa08e58e9b820042a5a3c9419`, checked against the registry's and the publisher's); its `src/` is byte-identical to commit `1ea1e1e`, the one replay and the stress test measured. The base is the recorded arm O of the 1.0.16 gate (pi-tuck 1.0.16, `dee0eab`; replay-identical to 1.0.17), chains t06 and t07 as run on 2026-11-08 from 08:38 to 17:51, `RESULTS-V1016.md`.

## Limits of the design

The two arms did not run side by side: the base ran earlier on the same day. Turns, cuts and tokens do not depend on the load of the machine; seconds do, so they are not compared. One model throughout: the fingerprint was read at the start and every 5 minutes, 78 samples, every one `d2c36f5557c43295`, none failed.

## The registered bar (Tier 1)

| # | Condition | Base (1.0.16) | 1.0.18 | Result |
|---|---|---|---|---|
| 1 | At least 60 paired tasks | 60 | 60 | **met** |
| 2 | One-sided 95% lower bound of resolved (candidate − base) above −10 points | 56 of 60 | 56 of 60 | difference +0.0, lower bound +0.0 (paired bootstrap, 10,000 draws, seed 1): **met** |
| 3 | 0 lost tasks on the candidate (dead tasks, dropped prompts, hand audit) | 0 | 0 | **met** |

**pi-tuck 1.0.18 meets the Tier 1 bar as registered.** The two arms resolved the same 56 tasks: no task differs, in either direction, on either chain.

Lost tasks: dead tasks 0 and mid-run refusals 0 in both arms; dropped prompts (a compaction entry with reason `prompt`, `keptUserTurns` 0 and an empty `firstKeptEntryId`) 0 in both arms. The audit (`analysis/prompt_evidence.py`) listed one task of the candidate, t06 task 21 (`django__django-14351`), for a sign of a missing prompt (the model names the task's identifier while it reads the issue); read by hand, its first messages work on that task's issue (they quote its title), so it is not lost; the same task was listed, and read the same way, in the 1.0.16 run. The other two candidate tasks with a cut at a prompt (t06 task 8, t07 task 24) also read as on their own task. The same signs on tasks with no cut at a prompt: 5 of 55 in the candidate arm and 5 of 54 in the base.

## Readouts with no pass line

| | Base (1.0.16) | 1.0.18 |
|---|---|---|
| Resolved of 60 | 56 | 56 |
| Turns per task | 29.35 | 22.27 |
| Turns per task on the 56 tasks both resolved | 28.79 | 21.91 |
| Cuts (compaction entries) | 61 (1.02 per task) | 57 (0.95 per task) |
| Cuts in the loop / at run end | 59 / 2 | 54 / 3 |
| Tasks ended at a wall or turn cap | 0 | 0 |
| Input / output / cache-read tokens | 4.29 M / 0.64 M / 57.14 M | 2.69 M / 0.57 M / 37.02 M |
| Total tokens | 62.1 M | 40.3 M |

- On the 56 tasks both arms resolved, 1.0.18 took 0.76 times the turns of the 1.0.16 arm (95% interval 0.63 to 0.92, paired bootstrap, 10,000 draws, seed 1) and 0.65 times its total tokens. Paired difference over all 60 tasks: −7.08 turns per task, 95% upper bound −3.28. Cuts fall by 7% (57 against 61).
- Against the 1.0.13 arm of the earlier gate (the base of `RESULTS-V1016.md`), 1.0.18 is at 22.27 turns per task against 20.22 and 40.3 M tokens against 37.4 M; the two comparisons are different pairs of runs, a day apart, and are not pooled.

## Not claimed

Only this pair of builds, on this model setup and window and these 60 tasks, one run per arm, the base run earlier the same day. The resolved result is a bound, not a gain: the data are compatible with a small difference either way. Turns, cuts and tokens are reported, not claimed, because the bar names none of them. Nothing about other windows, models or builds.
