# pi-tuck 1.0.8 at Pi's default compaction settings, 32k window, mac-studio/main: chain t06

Registered in `PREREG-DEFAULTS.md` before any run (commit `dca5653`, which names the build). Run 2026-11-01, 17:48 to 18:43, one session, with `analysis/dead_tasks.py` (corrected on 2026-11-01, see below) and `analysis/stuck_check.py`.

## Setup

- pi-tuck 1.0.8, commit `86935e9` (tag `v1.0.8`). Model `mac-studio/main` (Qwen3.8 Flash Next IQ3_S) at thinking level `xhigh`, window forced to 32,768, output cap 16,384, so the room is 16,384 tokens.
- Compaction settings are Pi's defaults: `reserveTokens` 16,384 and `keepRecentTokens` 20,000, which is larger than the room.
- Chain t06 (30 tasks), one session, one mac-studio lane. Chain t07 was not run: the build is the same and the registered chain list was not changed by the result.

## Result against the bar

| Condition | Result |
|---|---|
| 0 lost tasks (dead tasks) | **28 of 30 tasks lost: tasks 3 to 30.** Fail. |
| 0 stuck sessions | The session was not stuck by the registered definition (30 task records, longest gap between events 675 s, no gap of 3,600 s), although it made no progress after task 2. |

**The bar is not met.**

## What happened

- Task 1 ran (840 s, 19 turns, resolved). Task 2 ran to the 30-minute wall cap (1,800 s, 18 turns, not resolved); the largest request in tasks 1 and 2 was 10,431 and 12,018 tokens. The session had made four pi-tuck cuts before that, the last at 16,341 tokens.
- From task 3 on, every prompt received the pi-tuck notice "The request needs a cut and Pi has none to make (Nothing to compact (session too small)); ...", after a manual compaction that failed with "Nothing to compact (session too small)". Each of the 28 tasks was refused at its prompt, in 0.01 to 0.04 s and 1 turn, with no request carrying tokens. None recovered.
- The notice says the request needs a cut and Pi found nothing to cut. The context at that point is between the 16,384-token room and the 20,000-token `keepRecentTokens`, so a cut that keeps the last 20,000 tokens keeps all of it. This is an inference from the notice text and the token sizes; this one session cannot separate it from an effect of the wall-cap abort of task 2.
- The same notice appears once in arm C's acceptance run (t03 task 24); there the next task ran normally.

## Correction found by this run

The refusal counter matched only one of pi-tuck's two refusal notices, so `dead_tasks.py` first reported 0 dead tasks for this session. The counter now matches both. The same fix adds one dead task to arm C of the 32k acceptance test (`RESULTS-32K-ACCEPT.md`, corrected). See `DEVIATIONS.md`, entry of 2026-11-01 18:47.

## Readouts

- Resolved: 1 of 30 (task 1). Tokens: input 95,100, output 13,522, cache reads 190,720, total 299,342. Assistant messages 65.
- No mid-run refusals.

## Limits

- One session on one chain, one model, one build; the result shows that this failure occurs at these settings, not how often.
- Not comparable with any other arm: different model, chains and time.
