# PREREG addendum: the cut-later test (32k chains t01 to t05)

Written 2026-11-01, before any result of this measurement. `PREREG.md` and `PREREG-32K.md` are unchanged. This file adds one two-arm measurement on chains t01 to t05 of the 32k suite.

**Why.** pi-tuck cuts when a request reaches a fraction `DEFAULT_CUT_AT` of the room (the 1.0.8 candidate `a2e7d1a` has the value in `src/budget.ts`; the band is the room times that fraction, less a margin). Arm C made 1,142 cuts against arm M's 315 and took 1.78 times M's turns (ratio of means; R&D). The variant cuts later (`DEFAULT_CUT_AT` = 1). This test checks whether it takes fewer turns without losing tasks or raising spend.

## Arms

- **H**: pi-tuck 1.0.10 candidate, commit `a67ec30` (branch `claude/prompt-cut`), the base. *(Amended 2026-11-01 19:42, before any run of this test: the first attempt used `cd4626b` and was set aside unread, `DEVIATIONS.md`.)*
- **J**: pi-tuck commit `16de3a9` (branch `claude/cut-later-1010`): `a67ec30` plus two commits, `dcfdc38` (the default cut point is the band at the room, `DEFAULT_CUT_AT` 1 instead of 0.6, one line in `src/budget.ts`) and `16de3a9` (the cut-point and regression-benchmark pins at cutAt 1); no other change. *(Amended 2026-11-01 19:42, before any run: the first attempt used `e43c1b1` on `cd4626b`, which R&D's replay found to lose three tasks; set aside unread.)* Corrected replay on the 29 recordings, per the CTO: 0 dead tasks, 0 faults, gate 1 passes.
- `src/assets.ts` is identical to arm C's build, so both arms use the cloned semantic runtime. No run starts until the CTO confirms that the pair has cleared his replay gate.

## Setup

- The 32k suite's harness, tasks, order, grader, caps (30 minutes of working time, 120 turns), window 32,768 and reserve 16,384, as for arm C and the 1.0.8 gate. Model: `deepseek/deepseek-v4.1-flash-1017` through OpenRouter, pinned to DigitalOcean (the suite's standing rule).
- Chains t01 to t05 (30 tasks each, 150 paired tasks). Both arms of a chain run together in fresh Pi sessions; two chains run at once. The 1.0.8 gate's arm G is not reused as the base. The base moved from 1.0.8 to 1.0.9, and then, before any run, to the 1.0.10 candidate `a67ec30`, because J must carry the prompt-cut fix (the first attempt, on 1.0.9, was set aside unread; see `DEVIATIONS.md`). The bar and the chains did not change.
- Chains damaged by infrastructure are set aside whole and redone in both arms, under the rules recorded in `DEVIATIONS.md`.
- One reading, after all five chains have finished. No interim reading of outcomes.

## Bar

Set by the CEO before any result. J passes when all four hold over the 150 paired tasks:

1. **Turns**: on the tasks both arms resolve, (mean H turns − mean J turns) / mean H turns is at least 15%. A ratio of means over that set; the choice of ratio of means is the eval lead's.
2. **Lost tasks**: 0 dead tasks on J, as counted by `analysis/dead_tasks.py` (a task lost because an earlier task or prompt failed).
3. **Resolved**: resolved tasks on J are no lower than on H, over the same 150 tasks.
4. **Spend**: Pi usage spend per task on J is no higher than on H. Spend is the sum over the arm's five sessions of the `cost` in `stats.json` (Pi's own estimate from its price table for the pinned model, cache reads at their rate), divided by the arm's task count. It is not the provider's invoice.

## Reported, no pass line

Billed input per arm (input, cache reads, cache writes, cost; per session and in total), cuts per task by class (at run end, in the loop), mid-run refusals and dead tasks per arm with each refusal hand-audited, tasks ended at the wall cap, tuck_recall calls per arm and those with an offset (a proxy only: the clip is applied to requests and is not recorded in the logs; R&D's replay clips 20 results for the cut-later build against 8 for the base, added at R&D's suggestion before the run), turns per task for each arm, and the paired J−H resolved difference with a paired bootstrap interval (10,000 draws, seed 1). All from `analysis/v108_report.py --cutlater`.

## Limits (stated before the result)

- All four conditions are point comparisons on 150 tasks. Turns and spend vary from run to run, so a miss on one condition is not evidence that J is worse, and a pass is not evidence of a 15% effect.
- Passing needs all four at once; each is read as written, with no later widening or tightening.
- If H also has 0 dead tasks, condition 2 shows only that J introduced none.
- One model, one window, one run per arm.
