# The 1.0.10 candidate gate: pi-tuck `a67ec30` against 1.0.9, 32k chains t01 and t02

Registered in `PREREG-V110.md` before any run (commit `683dc9b`, with the DEVIATIONS entry of 19:33 on 2026-11-01). Run 2026-11-01, 19:33 to about 20:35, with `analysis/v108_report.py --base P --cand Q`.

## Setup

- Arm P: pi-tuck 1.0.9, `cd4626b` (tag `v1.0.9`). Arm Q: pi-tuck `a67ec30`, the 1.0.10 candidate: `cd4626b` plus `f483253` (a prompt's cut is pi-tuck's own) and `a67ec30` (semantic indexing after a boundary-saved cut).
- 32k suite settings: window 32,768, reserve 16,384, `keepRecentTokens` 3,333, `deepseek/deepseek-v4.1-flash-1017` pinned to DigitalOcean, 30 minutes and 120 turns per task, chains t01 and t02 (60 paired tasks), both arms of a chain run together.
- Four sessions, each with 30 graded tasks, no disk-full message, no crash, no wait for space, no gap between events of 3,600 s or more (longest 137 s).

## The gate

| Condition | Arm P | Arm Q | Result |
|---|---|---|---|
| Dead tasks (counted with the corrected counter) | 0 | 0 | Q has 0: met |
| Resolved of 60 | 50 | 49 | Q is one task lower: **not met** |

**Q does not pass the gate as registered**: "resolved tasks no lower" fails by one task. Mid-run refusals: 0 in both arms.

## What the difference is

- 5 tasks were resolved by one arm only: 3 by P only (t01 tasks 3 and 16, t02 task 16) and 2 by Q only (t01 task 29, t02 task 29). The paired difference is −1.7 points with a one-sided 95% lower bound of −8.3 (paired bootstrap, 10,000 draws, seed 1).
- The registered limit applies: "no lower" is a point comparison of counts on 60 tasks, and run-to-run variation between two runs of one build can exceed one task. This run cannot tell a one-task difference from that variation. It was registered as written and is reported as written.

## Readouts with no pass line

| | Arm P | Arm Q |
|---|---|---|
| Turns per task (mean / median) | 25.08 / 15 | 29.12 / 15 |
| Cuts (compaction entries) | 731 | 884 |
| Cuts per task | 12.18 | 14.73 |
| of which at run end / in the loop | 12 / 719 | 10 / 874 |
| Tasks ended at the turn cap / the wall cap | 3 / 0 | 3 / 0 |
| Input tokens | 3,355,892 | 3,976,225 |
| Output tokens | 396,093 | 465,100 |
| Cache-read tokens | 9,319,040 | 10,680,192 |
| Total tokens | 13,071,025 | 15,121,517 |
| Pi cost estimate (four sessions) | $0.77 | $0.91 |

- Paired Q minus P turns per task: +4.03 (one-sided 95% upper bound +10.87). On the 47 tasks both arms resolved the difference is −0.34, so the extra turns are on the 13 tasks that at least one arm did not resolve.
- Q cuts 21% more often per task than P, uses 16% more tokens in total and 18% more by the Pi cost estimate. The medians of turns per task are equal.

## Limits

- One model, one window, one run per arm; two chains. The run is on the suite's own settings (`keepRecentTokens` 3,333); it does not test the Pi-defaults case, which is the t06 rerun.
- If arm P also has 0 dead tasks (it does), the gate shows only that Q introduced none.
- The label "secondary, added after t01 and t02 were read" printed by `analysis/w32_stats.py` belongs to the 32k suite's earlier analysis, not to this run.

## Dropped prompts at a cut (added 2026-11-06)

A later check of the session files found that in the candidate arm (pi-tuck `a67ec30`) 6 of the 60 tasks had a cut at their prompt that kept no turn (the compaction entry's receipt has reason `prompt`, `keptUserTurns` 0 and an empty `firstKeptEntryId`): tasks 7 and 24 of chain t01 and tasks 14, 15, 16 and 18 of chain t02. In all 6 the model's first messages after the cut show it did not have the task's prompt. The task's tag, which exists only in the prompt, appears in the model's own messages in all 6, so the prompt reached it again before the end; 4 of the 6 were resolved (7, 24, 15, 18) and 2 were not (14, 16). The base arm (1.0.9) makes no cuts of this kind. The result stands as registered: dead tasks as counted by `dead_tasks.py` were 0 in both arms because that counter counts refusals and this failure raises none, and resolved tasks were 50 and 49 of 60. Read the "0 dead tasks" line with this count: 6 of the candidate's 60 tasks began without their prompt. Counted with `analysis/prompt_drops.py`, the candidate arm has 6 and the base 0. 1.0.12 fixes the cause.
