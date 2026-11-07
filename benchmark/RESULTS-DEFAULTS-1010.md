# Pi's default compaction settings at the 32k window on mac-studio/main: the 1.0.10 candidate (arm N) and 1.0.11 (arm X), chain t06

Registered in `PREREG-DEFAULTS.md` (amendments of 2026-11-01, commits `683dc9b` and `543c91f`; X's commit recorded in `90dfe0f`) before either run. The first run of this check, arm K on 1.0.8, lost 28 of 30 tasks (`RESULTS-DEFAULTS.md`). Read on 2026-11-05 with `analysis/dead_tasks.py`, `analysis/stuck_check.py` and `analysis/refusal_audit.py`; both runs finished on 2026-11-02 and were not read until then.

## Setup

- Arm N: pi-tuck `a67ec30` (the 1.0.10 candidate). Arm X: pi-tuck `22043bb` (1.0.11, `a67ec30` plus one commit).
- Suite `w32m`: `mac-studio/main` at thinking level `xhigh`, window forced to 32,768, output cap 16,384 (room 16,384), Pi's default compaction (`reserveTokens` 16,384, `keepRecentTokens` 20,000), 30 minutes and 120 turns per task. Chain t06 (30 tasks), one session and one mac-studio lane each, running at the same time as each other for most of their length. N ran 19:41 to 09:56 (14.2 hours) and X 22:54 to 12:16 (13.4 hours).
- Each session has 30 task records, no disk-full message, no crash and no wait for space.

## The bar (0 lost tasks, 0 stuck sessions), against the registered text as written

`PREREG-DEFAULTS.md` states the first condition as "0 dead tasks, as counted by `analysis/dead_tasks.py` (a task lost because an earlier task or prompt failed)". Arm N's amendment says the count is "with the counter that matches both refusal notices" (commit `683dc9b`, 19:33 on 2026-11-01); arm X's says "with the corrected counter" (commit `543c91f`, 22:48), and between the two the counter was extended at 22:29 to count a task with no token as dead.

Three tasks decide the count: N tasks 12 and 16 and X task 21. Each ran to the 30-minute wall cap on a first request the server never answered, recorded no token, and was followed by a task that ran normally. They are not refusals.

| Counter | Arm N | Arm X |
|---|---|---|
| As of arm N's registration (`683dc9b`: refusal notices of both texts) | 0 dead | 0 dead |
| As of arm X's registration (`543c91f`: also any task with no token) | 2 dead | 1 dead |
| The definition in the bar, "a task lost because an earlier task or prompt failed" | 0 dead | 0 dead |
| Stuck sessions (no gap of 3,600 s or more; 30 task records) | 0 (longest gap 1,802 s) | 0 (longest gap 1,800 s) |

**Arm N passed as registered**: the counter its amendment names counts 0 dead tasks, the definition also gives 0, and it was not stuck. (The later counter would count 2, but that counter did not exist when N was registered.)

**Arm X: the registered text does not decide it.** The counter its amendment names counts 1 dead task (task 21), which would mean it failed; the definition written in the bar counts 0, which would mean it passed. Both readings are given, and the choice goes to the user. It was not stuck.

**The user's decision (2026-11-05, relayed by the CEO): arm X counts as passed, under the bar's definition ("a task lost because an earlier task or prompt failed"), so 0 lost tasks.** This is the user's decision on an ambiguous text, not a reading of mine. Both readings and the facts of task 21 stay above: it ran to the 30-minute wall cap on a first request the server never answered (1,800 s, 1 turn, no token recorded), and the next task ran normally. No rerun.

The counter was refined on 2026-11-05, after the results were seen, so that a no-token task counts as dead only if it ended by itself; the refinement lowers the counts and is not used to decide anything here (`DEVIATIONS.md`, entry of 2026-11-05).

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
- The three stalled tasks decide arm X's verdict under the registered counter; both readings are given above.

## Dropped prompts at a cut (added 2026-11-06)

"0 dead tasks and 0 stuck sessions" is the registered condition and it stands as registered, but the counter behind it counts refusals and cannot see this failure. The session files show a cut at the prompt that kept no turn (reason `prompt`, `keptUserTurns` 0, empty `firstKeptEntryId`) in **8 of arm N's 30 tasks** (4, 8, 9, 10, 13, 14, 17, 21) and **7 of arm X's 30 tasks** (3, 8, 10, 17, 20, 22, 25). In 12 of those 15 the model's first messages show it did not have the task's prompt (the other 3 are not clear from the records); 1 of the 15 resolved (X task 25, after 60 turns) and 12 ended with an empty patch. So a pass on this test shows no refusal, not that every task began with its prompt: about a quarter of the tasks did not. 1.0.12 fixes the cause.
