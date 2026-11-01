# The 1.0.8 candidate gate: pi-tuck `a2e7d1a` against 1.0.7, 32k chains t01 and t02

Registered in `PREREG-V108.md` before any result (commit `9dac3d5`; the cuts-and-turns readouts were added at about 09:10 on 2026-11-01, after the first attempt started and before any result of it or of this run was read). Run 2026-11-01, 09:42 to 12:45, with `analysis/v108_report.py`.

## Setup

- Arm F: pi-tuck 1.0.7 (`387c575`). Arm G: pi-tuck `a2e7d1a`, 1.0.7 plus a clip of a fresh tool result the room cannot hold and a cut at the end of a run that ends at or above the band.
- 32k suite settings: window 32,768, reserve 16,384, `deepseek/deepseek-v4.1-flash-1017` pinned to DigitalOcean, 30 minutes and 120 turns per task, chains t01 and t02 (30 tasks each, 60 paired tasks), both arms of a chain run together.
- A first attempt (08:55) was stopped by a full host disk at about 09:33 and set aside unread (`DEVIATIONS.md`, entry of 09:40). This is the second attempt, fresh from task 1. Its logs show no disk-full message, no crash and no wait for space; every task has a grade.

## The gate

| Condition | Arm F | Arm G | Result |
|---|---|---|---|
| Dead tasks (lost because an earlier task or prompt failed) | 0 | 0 | G has 0: met |
| Resolved of 60 | 46 | 46 | G no lower: met |

**G passes the gate as registered.**

## What the run does and does not show

- Arm F also had 0 dead tasks and 0 mid-run refusals on these chains (arm C, a 1.0.5 candidate, had 2 mid-run refusals on t01). So the run shows that G introduced no refusal. It does not show that the clip prevents one, because no refusal occurred in the base arm to prevent.
- The resolved counts are equal, 46 and 46, with 3 tasks resolved only by G and 3 only by F. The paired difference is +0.0 points with a one-sided 95% lower bound of −6.7 (paired bootstrap, 10,000 draws, seed 1). Sixty tasks cannot show that two runs are the same or different by less than that.

## Readouts with no pass line

| | Arm F | Arm G |
|---|---|---|
| Turns per task (mean) | 25.37 | 26.10 |
| Cuts (compaction entries) | 764 | 770 |
| Cuts per task | 12.73 | 12.83 |
| of which at run end | 7 (0.12 per task) | 16 (0.27 per task) |
| of which in the loop | 757 (12.62) | 754 (12.57) |
| Tasks ended at the turn cap (121 turns) | 3 | 2 |
| Tasks ended at the wall cap | 0 | 1 (sympy__sympy-13551, resolved) |
| Mid-run refusals | 0 | 0 |
| Input tokens | 3,657,786 | 3,463,333 |
| Output tokens | 388,153 | 382,878 |
| Cache-read tokens | 9,267,584 | 9,765,760 |
| Total tokens | 13,313,523 | 13,611,971 |
| Pi cost estimate (sum of the four sessions) | $0.37 | $0.36 |

- Paired G minus F turns per task: +0.73 (one-sided 95% upper bound +6.00); on the 43 tasks both arms resolved, +1.00.
- Cut classes: a cut is at run end when the entry just before it is an assistant message with no tool call, and in the loop otherwise. G has 9 more cuts at run end than F; the cuts in the loop are the same to within 3. Both arms cut about 12.7 times per task, mostly inside runs.
- Per session total tokens: F 7,144,340 (t01) and 6,169,183 (t02); G 7,654,482 and 5,957,489.

## Limits

- The gate's second condition is a point comparison of counts on 60 tasks. It is met with equality, and run-to-run variation between two runs of one build is larger than any difference seen here.
- One model, one window, one run per arm; two chains.
- The label "secondary, added after t01 and t02 were read" printed by `analysis/w32_stats.py` belongs to the 32k suite's earlier analysis, not to this run.
