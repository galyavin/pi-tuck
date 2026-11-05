# Pi's default compaction settings at the 32k window on mac-studio/main: the 1.0.10 candidate (arm N) and 1.0.11 (arm X), chain t06

Registered in `PREREG-DEFAULTS.md` (amendments of 2026-11-01, commits `683dc9b` and `543c91f`; X's commit recorded in `90dfe0f`) before either run. The first run of this check, arm K on 1.0.8, lost 28 of 30 tasks (`RESULTS-DEFAULTS.md`). Read on 2026-11-05 with `analysis/dead_tasks.py`, `analysis/stuck_check.py` and `analysis/refusal_audit.py`; both runs finished on 2026-11-02 and were not read until then.

## Setup

- Arm N: pi-tuck `a67ec30` (the 1.0.10 candidate). Arm X: pi-tuck `22043bb` (1.0.11, `a67ec30` plus one commit).
- Suite `w32m`: `mac-studio/main` at thinking level `xhigh`, window forced to 32,768, output cap 16,384 (room 16,384), Pi's default compaction (`reserveTokens` 16,384, `keepRecentTokens` 20,000), 30 minutes and 120 turns per task. Chain t06 (30 tasks), one session and one mac-studio lane each, running at the same time as each other for most of their length. N ran 19:41 to 09:56 (14.2 hours) and X 22:54 to 12:16 (13.4 hours).
- Each session has 30 task records, no disk-full message, no crash and no wait for space.

## The bar (0 lost tasks, 0 stuck sessions)

| Condition | Arm N | Arm X |
|---|---|---|
| Dead tasks (refused at the prompt, or lost at once with no token, or right after a refused task) | **0** | **0** |
| Stuck sessions (a gap of 3,600 s or more between events, or unfinished) | **0** (longest gap 1,802 s) | **0** (longest gap 1,800 s) |

**Both arms meet the bar as registered.**

### Three tasks counted apart (read this)

Three tasks ended at the 30-minute wall cap with their first request never answered and no token recorded: N tasks 12 and 16 and X task 21. A counter that reads "no token for this task" calls them dead (2 and 1), and my counter did until 2026-11-05. They are not tasks lost at their prompt: the request was sent, the server did not answer in 30 minutes, the run was aborted at the cap, and the next task ran normally. I refined the counter on 2026-11-05, after seeing them, to count a no-token task as dead only if it ended by itself (the t03 task 24 case in the cut-later test ended in 0.02 s). That change lowers N's and X's counts, so both readings are given here: **by the literal no-token reading N has 2 dead tasks and X has 1, and neither meets the bar; by the definition of a dead task (lost because a prompt or earlier task failed) both have 0 and both meet it.** I apply the definition and report the three tasks as server stalls. See `DEVIATIONS.md`, entry of 2026-11-05.

## What happened

- The failure of arm K (a refusal loop from task 3 that never ended) did not recur in N or X: no run of dead tasks, and X had no refusal notice at all.
- Arm N has one mid-run refusal, task 5 ("mandatory context cannot fit", task ended after 913 s and 2 turns), and the session went on to run task 6. The audit explains it: the round carried a 9,020-token reasoning output (35,104 characters of thinking) from the model, so the next request was about 8,446 (prompt) + 9,020 (that output) + 335 (tool result) = 17,801 tokens against the 16,384-token room. It is a capacity refusal on a single oversized round, which the 1.0.11 change does not address. Arm X had no such round.
- The server was very slow: 27 of N's 30 tasks and 21 of X's 30 tasks ended at the wall cap, and X had 2 more at the turn cap. Per completed request, N took a median of 96 s (mean 171 s) and X a median of 10 s (mean 72 s).

## Readouts with no pass line

| | Arm N | Arm X |
|---|---|---|
| Resolved of 30 | 6 | 10 |
| Tasks ended at the wall cap / turn cap | 27 / 0 | 21 / 2 |
| Stalled first requests | 2 (tasks 12, 16) | 1 (task 21) |
| Mid-run refusals | 1 (task 5, explained above) | 0 |
| Turns per task | 9.9 | 21.0 |
| Cuts (per task) | 112 (3.7) | 233 (7.8) |
| Total tokens | 2.42 M | 4.95 M |

- Resolved by both 4, by N only 2, by X only 6 (arm K resolved 1, with 28 tasks lost).

## Limits

- One session per arm on one chain, one model, one build each. The arms ran at different times and under different server load, so their resolved counts, turns and tokens are not comparable with each other; with most tasks ended at the wall cap they mostly measure how slow the server was.
- A pass shows no lost task and no stuck session in these 30 tasks, not that none can occur.
- The three stalled tasks are counted apart on my reading of the definition; the literal count is given above.
