# PREREG addendum: the 1.0.8 candidate gate (32k chains t01 and t02)

Written 2026-11-01, before any result of this measurement. `PREREG.md` and `PREREG-32K.md` are unchanged. This file adds one two-arm measurement on chains t01 and t02 of the 32k suite. It gates release 1.0.8. It replaces `PREREG-CLIP.md`, which was not run.

## Arms

- **F**: pi-tuck 1.0.7, commit `387c575` (tag `v1.0.7`).
- **G**: pi-tuck `a2e7d1a` (1.0.8 candidate): branches from 1.0.6 (`e15de72`) plus five commits, not from 1.0.7 (corrected on 2026-11-01 after the run, which used the builds as exported; this line first said `387c575` plus three commits, which was wrong; see `RESULTS-V108.md`). `f03ae4b` and `9a188a4` clip a fresh tool result the room cannot hold instead of refusing the run; `b313d1a` cuts at the end of a run that ends at or above the band.
- `src/assets.ts` is identical to arm C's build, so the semantic runtime id is the same and both arms use the cloned runtime.

## Setup

- Same as arm C: harness `harness/live.py`, window 32,768, reserve 16,384, the same tasks in the same order for t01 and t02 (30 tasks each), the same container tools, grader, caps (30 minutes of working time, 120 turns) and rules. Fresh Pi sessions; both arms of a chain run together; t01 and t02 run at once (four sessions).
- Model: `deepseek/deepseek-v4.1-flash-1017` through OpenRouter, pinned to DigitalOcean, as in the rest of the 32k suite. Confirmed for this measurement before launch (2026-11-01); a later change is recorded in `DEVIATIONS.md` first.
- Chains damaged by infrastructure are set aside whole and redone in both arms, under the rules recorded in `DEVIATIONS.md`.

## Gate

Set by the CEO and relayed by the CTO: **0 tasks lost on arm G, and resolved tasks no lower.** Read as follows.

- **Tasks lost** (reading confirmed before launch): dead tasks as defined in `DEVIATIONS.md` and counted by `analysis/dead_tasks.py` (a task lost because an earlier task or prompt failed). The count over t01 and t02 in arm G must be 0.
- **Resolved no lower**: resolved tasks in arm G, counted over the same 60 tasks, are at least those in arm F.
- G passes when both hold.

## Also reported, not part of the gate

- Mid-run refusals (a task refused on its own fresh tool round) in each arm, each hand-audited with `analysis/refusal_audit.py`; the dead-task count for arm F.
- The paired G−F difference in resolved tasks with a paired bootstrap interval (10,000 draws, seed 1), turns per task, tasks ended at the wall cap per arm, and token use per arm (input, output, cache reads; per session and in total).
- **Cuts and turns, no pass line** (added at the CEO's request at about 09:10, after the four sessions started and before any result of this measurement was read; the gate is unchanged). Per arm over its 60 tasks: total cuts, cuts per task, and turns per task (mean and the paired G−F difference with the same bootstrap). A cut is a compaction entry in the arm's `session.jsonl`, the count `analysis/sessionlog.py` uses. Each cut is classed **at run end** when the entry just before it is an assistant message with no tool call, and **in the loop** otherwise; both classes are reported for each arm, so that the effect of 1.0.8's cut at the end of a run can be seen apart from the others.
- Arm-C counts on t01 and t02 for reference only: a different build, run at a different time.

## Limits (stated before the result)

- "No lower" is a point comparison on 60 tasks. The resolved-rate difference between two runs of one build on 60 tasks can be several tasks either way, so a result below arm F is not evidence that G resolves less.
- If arm F also has 0 dead tasks, the gate shows only that G introduced none.
- One model, one window, one run per arm.
