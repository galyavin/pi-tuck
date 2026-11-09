# pi-tuck 1.0.16 against the recorded 1.0.13 arm, window 81,920, chains t06 and t07 (Tier 1)

Registered in `PREREG-ADAPTIVE.md` ("Later gates", the line for the candidate run alone) before any result of this run; design change and restarts in `DEVIATIONS.md` (entry of 2026-11-08 08:50). pi-tuck 1.0.16 (commit `dee0eab`, tag `v1.0.16`) ran alone as arm O on `mac-studio/main` at xhigh, suite `w81` settings in its own results folder, 60 tasks (chains t06 and t07, 30 tasks each), from 2026-11-08 08:38 to 17:51 on two lanes. The base is the recorded arm O of the adaptive gate (`882f6f6`, the code of 1.0.13; 1.0.14 and 1.0.15 are replay-matching patches of it), chains t06 and t07 as run on 2026-11-07, on the same model sha. Two earlier starts of this run (08:33 and 08:36) were cut off within minutes with no task finished and are kept apart.

## Limits of the design

The two arms did not run side by side: the base ran a day earlier. Turns, cuts and tokens do not depend on the load of the machine, but seconds do (the candidate's tasks ran while other jobs shared the Docker VM), so seconds are not compared. One model throughout: the fingerprint was read at the start and every 5 minutes, 105 samples, every one `d2c36f5557c43295`; three further samples failed with a server error and carry no sha, so they do not count against it.

## The registered bar (Tier 1)

| # | Condition | Base (1.0.13) | 1.0.16 | Result |
|---|---|---|---|---|
| 1 | At least 60 paired tasks | 60 | 60 | **met** |
| 2 | One-sided 95% lower bound of resolved (candidate − base) above −10 points | 55 of 60 | 56 of 60 | difference +1.7, lower bound +0.0 (paired bootstrap, 10,000 draws, seed 1): **met** |
| 3 | 0 lost tasks on the candidate (dead tasks, dropped prompts, hand audit) | 0 | 0 | **met** |

**pi-tuck 1.0.16 meets the Tier 1 bar as registered.** Per chain, resolved difference in points: t06 0.0, t07 +3.3. The one task that differs is t07 task 11 (`django__django-14311`), resolved by 1.0.16 and not by the base.

Lost tasks: dead tasks 0 and mid-run refusals 0 in both arms; dropped prompts (compaction entry with reason `prompt`, `keptUserTurns` 0 and an empty `firstKeptEntryId`) 0 in both arms. The audit (`analysis/prompt_evidence.py`) listed one task of the candidate, t07 task 5 (`django__django-14792`), for a sign that the prompt was missing (the model names ticket numbers); read by hand, its first messages work on that task's issue (they quote its title), so it is not lost. The other three candidate tasks with a cut at a prompt (t06 tasks 7 and 21, t07 task 19) also read as on their own task. The same signs on tasks with no cut at a prompt: 5 of 54 in the candidate arm and 2 of 55 in the base.

## Readouts with no pass line

| | Base (1.0.13) | 1.0.16 |
|---|---|---|
| Resolved of 60 | 55 | 56 |
| Turns per task | 20.22 | 29.35 |
| Turns per task on the 55 tasks both resolved | 19.51 | 28.95 |
| Cuts (compaction entries) | 35 (0.58 per task) | 61 (1.02 per task) |
| Cuts in the loop / at run end | 33 / 2 | 59 / 2 |
| Most cuts in one task | 2 | 3 |
| Tasks ended at a wall or turn cap | 0 | 0 |
| Input / output / cache-read tokens | 1.79 M / 0.40 M / 35.25 M | 4.29 M / 0.64 M / 57.14 M |
| Total tokens | 37.4 M | 62.1 M |

- On the 55 tasks both arms resolved, 1.0.16 took 1.48 times the turns of the base (95% interval 1.34 to 1.64, paired bootstrap, 10,000 draws, seed 1), and its total tokens were 1.66 times the base's. Paired difference over all 60 tasks: +9.13 turns per task, upper bound +11.53.
- The extra turns sit with the extra cuts: on the 13 tasks where only 1.0.16 cut, it took 21 more turns per task than the base; on the 3 tasks where only the base cut, 1.33 fewer. The 1.0.16 release notes report an unchanged cut rate on replay of recorded single-task sessions; in these live tasks the cut count rises by 74%.

## Not claimed

Only this pair of builds, on this model setup and window and these 60 tasks, one run per arm, the base run a day before the candidate. The resolved result is a bound, not a gain: the data are compatible with a small difference either way. Turns, cuts and tokens are reported, not claimed, because the bar names none of them; the registration for them would need to be set before its results. Nothing about other windows, models or builds.
