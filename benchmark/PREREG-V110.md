# PREREG addendum: the 1.0.10 candidate gate (32k chains t01 and t02)

Written 2026-11-01, before any run of this measurement. `PREREG.md` and `PREREG-32K.md` are unchanged. This file adds one two-arm measurement on chains t01 and t02 of the 32k suite. It gates release 1.0.10, because the candidate changes cut timing. The bar is the one the CTO relayed, read as for the 1.0.8 gate.

**Why.** In the candidate a prompt's cut is pi-tuck's own: planned on the input, carried by the run's requests and saved at its first boundary, so Pi's `keepRecentTokens` no longer blocks it. The Pi-defaults check on 1.0.8 lost 28 of 30 tasks to that block (`RESULTS-DEFAULTS.md`). Cut timing therefore changes in every session, and this test checks that nothing is lost on the suite's own settings.

## Arms

- **P**: pi-tuck 1.0.9, commit `cd4626b` (tag `v1.0.9`), the base.
- **Q**: pi-tuck 1.0.10 candidate, commit `a67ec30` (branch `claude/prompt-cut`): `cd4626b` plus `f483253` (a prompt's cut is pi-tuck's own, not Pi's `compact()`) and `a67ec30` (a cut saved at a boundary starts semantic indexing). Replay on the 29 recordings, per the CTO: 0 dead tasks, 0 faults, gate 1 passes.
- `src/assets.ts` is identical to arm C's build, so both arms use the cloned semantic runtime.

## Setup

- As the 1.0.8 gate: harness `harness/live.py`, suite `w32` (window 32,768, reserve 16,384, keepRecentTokens 3,333), `deepseek/deepseek-v4.1-flash-1017` through OpenRouter pinned to DigitalOcean, 30 minutes and 120 turns per task, the same container tools and grader. Chains t01 and t02 (30 tasks each, 60 paired tasks), both arms of a chain run together, four sessions. No mac-studio lane is used.
- Chains damaged by infrastructure are set aside whole and redone in both arms, under the rules recorded in `DEVIATIONS.md`.

## Gate

Set by the CTO: **0 tasks lost on Q, and resolved tasks no lower**, read as for the 1.0.8 gate.

- **Tasks lost**: dead tasks as counted by `analysis/dead_tasks.py`, which now matches both of pi-tuck's refusal notices. The count over t01 and t02 in arm Q must be 0.
- **Resolved no lower**: resolved tasks in Q over the same 60 tasks are at least those in P.
- Q passes when both hold.

## Also reported, no pass line

Mid-run refusals in each arm with each hand-audited; the dead-task count for P; the paired Q−P difference in resolved tasks with a paired bootstrap interval (10,000 draws, seed 1); turns per task; cuts per task by class (at run end, in the loop) as defined in `PREREG-V108.md`; tasks ended at the wall or turn cap; tokens per arm (input, output, cache reads) and the Pi cost estimate; and the longest event gap per session. All from `analysis/v108_report.py --base P --cand Q`.

## Limits (stated before the result)

- "No lower" is a point comparison of counts on 60 tasks; run-to-run variation between two runs of one build can exceed any difference seen.
- If arm P also has 0 dead tasks, the gate shows only that Q introduced none.
- One model, one window, one run per arm; two chains.
