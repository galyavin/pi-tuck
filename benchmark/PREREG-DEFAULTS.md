# PREREG addendum: pi-tuck 1.0.8 at Pi's default compaction settings (32k window, mac-studio/main)

Written 2026-11-01, before any run of this measurement. `PREREG.md` and `PREREG-32K.md` are unchanged. This file adds one single-arm robustness check. It has its own bar and is not compared with any DeepSeek arm.

**Why.** The 32k suite scales Pi's `keepRecentTokens` to the room (3,333 of 16,384). Pi's own default is 20,000, larger than the whole 16,384-token room, and pi-tuck's replay gate found a refusal at a prompt under that setting. This check runs pi-tuck 1.0.8 at Pi's defaults on a second model family, to see whether sessions lose tasks or hang.

## Arm

- **K**: pi-tuck 1.0.8, commit `86935e9` (tag `v1.0.8`; `a2e7d1a` plus the 1.0.7 merge, replay requests byte-identical on all 29 recordings, per the CTO). `src/assets.ts` is identical to arm C's build, so the cloned semantic runtime applies.
- One arm only; no base arm, no comparison.

## Setup

- Harness `harness/live.py`, suite `w32m`: model `mac-studio/main` at thinking level `xhigh` (the main run's model entry, Qwen3.8 Flash Next IQ3_S on the mac-studio server), with the window forced to 32,768 and the output cap left at the model's 16,384, so the room is 16,384.
- Compaction settings are Pi's defaults (`settings-defaults.js`): `reserveTokens` 16,384, `keepRecentTokens` 20,000. Retry settings as in the main run.
- Same prompts, container tools, grader and caps (30 minutes of working time, 120 turns per task) as the rest of the live work.
- Chains t06 and t07 (30 tasks each, 60 tasks) from the 32k suite's pre-registered second-batch draw (`harness/select_w32.py --second`, seed 20261031; task lists in `data/sessions.json`), one session per chain. The user's limit is 3 concurrent lanes on the mac-studio server across all seats, and builders keep one. Until the replay's last mac-studio job (the answers of the Terra comparator on s09-A) has ended, the arm uses one lane: t06 runs alone, and t07 starts when that job has ended, or after t06 if it has not. Once it has ended, the two sessions may run at the same time. A chain's sessions are never run in a way that puts more than 3 lanes in use. These chains are disjoint from t01 to t05, so the cut-later test (`PREREG-CUTLATER.md`) and this check never share a task image.
- Chains damaged by infrastructure are set aside whole and redone from task 1, under the rules in `DEVIATIONS.md`.

## Bar

Set by the CEO. K passes when, over t06 and t07:

1. **0 lost tasks**: 0 dead tasks, as counted by `analysis/dead_tasks.py` (a task lost because an earlier task or prompt failed).
2. **0 stuck sessions**: as defined and counted by `analysis/stuck_check.py`. A session is stuck when its event log has a gap of 3,600 s or more between two events (the harness waits 3,600 s for any Pi answer, and a compaction or a tool run has taken up to about 30 minutes), or when it ended unfinished: fewer than 30 task records or no `stats.json`.

## Reported, no pass line

Mid-run refusals (a task refused on its own fresh tool round) with each hand-audited by `analysis/refusal_audit.py`; resolved tasks; cuts per task by class, turns per task, tasks ended at the turn or wall cap; tokens per session; the largest prompt and the tasks with a request over the 16,384-token room; the longest event gap per session.

## Limits (stated before the result)

- One arm, two chains, 60 tasks: a pass shows no lost task and no stuck session in these 60 tasks, not that none can occur.
- The model is a local quantised one, served to several lanes at once; slowness and 429 retries come from the server and are not counted as stuck unless a gap reaches 3,600 s.
- Resolved counts here are not comparable with any other arm: different model, different chains, different time.

## Amendment of 2026-11-01: rerun on the 1.0.10 candidate

The first run (arm K, 1.0.8, `86935e9`, t06) did not meet the bar; its record is `RESULTS-DEFAULTS.md` and it stays. At the CEO's direction the same check is rerun on t06 with the CTO's fix build as **arm N**: pi-tuck commit `a67ec30` (1.0.10 candidate, branch `claude/prompt-cut`; replay on the 29 recordings: 0 dead tasks, 0 faults), a fresh session. Everything else is as above: suite `w32m`, `mac-studio/main` at `xhigh`, window 32,768, Pi's default compaction settings, the same caps, one lane, the same bar (0 lost tasks, 0 stuck sessions, counted with the counter that matches both refusal notices) and the same limits. Written before the rerun starts.

## Second amendment of 2026-11-01: the Pi-defaults check on 1.0.11, in parallel

Arm N (the 1.0.10 candidate, `a67ec30`) runs at about 26 minutes a task, so its 30 tasks take roughly 10 to 15 hours. At the CEO's direction, to avoid a serial wait, the same check also runs on the CTO's 1.0.11 as **arm X**: pi-tuck commit `22043bb` (1.0.11, branch `claude/release-1.0.11`, `a67ec30` plus one commit; replay on the 29 recordings: 0 dead tasks, 0 faults; recorded 2026-11-01 22:50, before the run), a fresh session on chain **t06** (the chain of arms K and N, so the three builds run the same 30 tasks). One mac-studio lane, in parallel with N: the user's limit is 3 lanes across all seats, so the two arms use 2, builders keep 1, and the replay's last job (the Terra comparator's answers on s09-A) waits for a free lane. Everything else is as above: suite `w32m`, `mac-studio/main` at `xhigh`, window 32,768, Pi's default compaction settings, the same caps, **the same bar (0 lost tasks, 0 stuck sessions, counted with the corrected counter)** and the same limits. Chain t07 is not used because the cut-later rerun (`PREREG-CUTLATER2.md`) uses it. Arm N stays as registered and is read when it ends; X is read when it ends. The mid-run refusal in N's task 5 is passed to the CTO as a case for the 1.0.11 replay. Written before the run starts.
