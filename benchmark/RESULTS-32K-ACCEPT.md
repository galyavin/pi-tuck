# 32k suite: acceptance test of the oversize-result fix (arm C)

Written 2026-11-01, after all five chains of arm C finished. The test, its pass bar and the definition of a dead task were fixed in `PREREG-32K.md` (addendum of 2026-10-31 13:25 and definition of 14:55) before any arm C result existed. Nothing in the bar changed.

**What ran.** pi-tuck at commit `aa30824771a91254ad1dc036c38aa88ec0232c13` (arm C, "B′") on chains t01-t05, 150 tasks, with the setup of the first batch: DeepSeek V4.1 Flash `deepseek/deepseek-v4.1-flash-1017` pinned to one upstream, window 32,768, reserve 16,384 (room 16,384), the same tasks, order, prompts, grader and caps. Arms A (Pi's built-in compaction), B (pi-tuck 1.0.3, `656f77a`) and M (observation masking) are the first batch's. **Arm C ran at a different time from A, B and M.** The t04 chains of A, B and M were redone together after the first run of them died at a grading timeout (`DEVIATIONS.md`, 2026-10-31 16:27 and 19:34); arm C's t04 ran once.

## Pass bar

| Part | Rule | Result |
|---|---|---|
| 1 | Zero dead tasks across t01-t05 | **0 dead tasks.** 5 mid-run refusals (below), counted apart by the definition. |
| 2 | d_C ≥ d_B − 3 points | d_B = +4.26 points (94 tasks before each chain's first refusal in B); d_C = +17.33 points (150 tasks); the bar is +1.26. **Pass.** |

Both parts hold, so arm C passes the acceptance test as pre-registered. The test says nothing about any build other than `aa30824`.

**Mid-run refusals in arm C, each read against the events** (`analysis/refusal_audit.py`). In each, pi-tuck refused straight after the task's own fresh tool result; the prompt before that round plus the result (characters / 4) exceeds the 16,384-token room; the next task ran normally.

| Chain, task | Prompt before the round (tokens) | Result of the round (characters) | Sum, about (tokens) |
|---|---|---|---|
| t01, 7 | 7,608 | 51,340 | 20,400 |
| t01, 22 | 9,333 | 39,852 | 19,300 |
| t04, 11 | 8,605 | 49,676 | 21,000 |
| t04, 15 | 9,146 | 38,749 | 18,800 |
| t04, 22 | 12,256 | 35,421 | 21,100 |

In t04 task 15 the round had two tool results; only the last is counted, so the sum is a lower bound. For reference, arm B (1.0.3) has 52 dead tasks and 4 mid-run refusals over the same five chains; arm C refused 55 fewer of the tasks B refused, and arm C resolved 46 of those 55 (arm A, 25 of the same 55).

## Readouts without a pass line

150 paired tasks, difference in resolved tasks in points, paired bootstrap (10,000 draws, seed 1), one-sided 95% lower bound.

| Comparison | Resolved | Difference | Lower bound |
|---|---|---|---|
| C against A, all tasks | A 94, C 120 | +17.3 | +10.7 |
| C against A, tasks where a cut summarised part of the task in either arm (S, n = 144) | A 90, C 114 | +16.7 | +9.7 |
| C against M, all tasks | M 117, C 120 | +2.0 | −2.7 |
| C against M, S (n = 141) | M 108, C 111 | +2.1 | −2.8 |

Resolved tasks of 150: A 94, B 72, C 120, M 117.

| Arm | Turns per task | Cuts | Tasks with a request over the 16,384-token room | Tokens per session | Spend (Pi usage cost, all five sessions) |
|---|---|---|---|---|---|
| A | 9.4 | 381 | 97 | 6.10 M | $0.87 |
| B | 15.4 | 1,089 | 1 | 3.91 M | $0.32 |
| C | 24.0 | 1,720 | 0 | 6.39 M | $0.55 |
| M | 11.9 | 407 | 73 | 7.02 M | $0.94 |

C takes 14.6 more turns per task than A (95% upper bound +18.0); among tasks both resolved, 11.5 more.

## Limits

- **The room is not binding for A and M.** The window is nominal: A and M sent a request over the room in 97 and 73 of 150 tasks, and B and C in 1 and 0. Pi-tuck is the only arm held to the room (`PREREG-32K.md`, 13:23 addendum).
- **Chains differ a lot.** Difference C minus A per chain (points): t01 +10.0, t02 −3.3, t03 +50.0, t04 +16.7, t05 +13.3. Arm A resolved 8 of 30 in t03 (after task 7 almost none), where C resolved 23 and M 22. The bootstrap above resamples tasks, not chains. Added after reading the numbers, for this reason only: C minus A with one chain left out is +19.2 (t01), +22.5 (t02), **+9.2 (t03)**, +17.5 (t04), +18.3 (t05) points, 120 tasks each.
- **Different time.** Arm C's t01 and t02 ran while the first batch was still running t03-t05; its t03-t05 ran after the first batch and the t04 redo had finished. Same provider route throughout; no check for drift between the periods was run.
- **The other subsets** in the output of `analysis/w32_stats.py` (in A only, in C only, in both, before and after a chain's first refusal) are descriptive; the "before the chain's first refusal" and "from the first refusal on" rows were added after t01 and t02 were read.
- One model, one window (32,768), five chains of 30 SWE-bench Verified tasks.

Reproduce: `runs/.venv/bin/python analysis/w32_accept.py runs/live32` (the run folders are kept outside git).
