# The thinking-level pilot: pi-tuck 1.0.11 candidate `22043bb` on mac-studio/main, `medium` against `xhigh`, chain p01

Registered in `PREREG-PILOT.md` before any run (2026-11-05). Run 2026-11-05, 11:04 to 13:41, with `analysis/pilot_report.py` (the registered rule, written down as a script) and `analysis/stuck_check.py`. It is a coarse screen that picks one setting for two gates; it is not a gate of any build.

## Setup

- Arm S: `22043bb`, thinking level `medium`. Arm U: the same build, thinking level `xhigh`. Suite `w32g` (`mac-studio/main`, window 32,768, output cap 16,384, `reserveTokens` 16,384, `keepRecentTokens` 3,333), a 120-turn cap per task, no wall cap, a 3,600 s stall guard.
- Chain `p01`, the six tasks of the registration in the same order, both sessions at the same time on two lanes. Both finished all six tasks (S at 13:33, U at 13:41), well inside the 4-hour limit.

## Decision

| Registered condition | Result |
|---|---|
| (1) Total seconds of `xhigh` ÷ total seconds of `medium` over the common tasks is at least 2 | 9,243 ÷ 8,774 = **1.05: not met** |
| (2) `medium` resolves at least one task and at least half as many as `xhigh` | 5 against 6: met |

**Both gates use `xhigh`**, as the registration says for this outcome. `medium` was not faster in this run.

## Readouts

| | Arm S (`medium`) | Arm U (`xhigh`) |
|---|---|---|
| Tasks finished, both arms | 6 | 6 |
| Seconds per task (each task) | 1,462 mean (212, 1,519, 3,203, 1,238, 1,033, 1,570) | 1,540 mean (208, 2,047, 3,084, 1,621, 928, 1,355) |
| Total seconds | 8,774 | 9,243 |
| Turns per task (each task) | 69.2 (15, 62, 34, 121, 62, 121) | 90.8 (12, 121, 94, 121, 76, 121) |
| Resolved of 6 | 5 | 6 |
| Tasks ended at the turn cap (121 turns) | 2 | 3 |
| Completed requests | 415 | 545 |
| Seconds per completed request, median / mean | 7.1 / 12.4 | 5.9 / 10.3 |
| Output tokens | 204,563 | 297,949 |
| Longest gap between events | 1,077 s | 704 s |

- Dead tasks 0 and mid-run refusals 0 in both arms. No stall: no gap of 3,600 s or more. (`stuck_check.py` prints "STUCK" for both folders only because it expects 30 task records and a finished run; each folder has the 6 records the pilot registered.)
- `medium` used fewer turns per task (69 against 91) and fewer output tokens per request (493 against 547), but a request took about as long at either setting, so the seconds per task came out within 5%. The one task `medium` did not resolve is `django__django-13516` (62 turns, 1,033 s); `xhigh` resolved it in 76 turns.

## What the run shows, and what it does not

- The server was fast during this run: a completed request took a median of 6 to 7 s at either setting. The registration's premise of 100 to 140 s per request, and its estimates of about 3 days for tier 1 and 7.4 days for tier 2, came from earlier runs on a slower or more loaded server; this pilot does not say which speed the gates will meet. At the pilot's pace for `xhigh` (1,540 s per task) 60 paired tasks would take about 26 hours per arm and 150 about 64 hours, with the two arms on two lanes in parallel. That is an observation of one run on one afternoon, not an estimate to schedule by.
- Six tasks, one run per arm, two sessions sharing the server: the pilot cannot show that `medium` and `xhigh` take equal time, only that `medium` was not twice as fast in this run. Three of the six `xhigh` tasks and two of the six `medium` tasks ended at the turn cap, so the six tasks are harder than a typical chain and capped tasks set the totals.
- No claim about resolve rate: 5 against 6 on six tasks is inside run-to-run variation.
