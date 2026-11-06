# The cut-later test: pi-tuck `16de3a9` against the 1.0.10 candidate `a67ec30`, 32k chains t01 to t05

Registered in `PREREG-CUTLATER.md` before any run (hashes amended and dated on 2026-11-01 before the start; `DEVIATIONS.md`, entries of 19:27 and 19:42). Run 2026-11-01, 20:37 to about 22:27, ten sessions of 30 graded tasks, with `analysis/v108_report.py --cutlater`. A first attempt on `cd4626b` and `e43c1b1` was stopped after 26 minutes and set aside unread (`DEVIATIONS.md`, 19:27).

## Setup

- Arm H: pi-tuck `a67ec30` (the 1.0.10 candidate), the base. Arm J: `16de3a9`, which is `a67ec30` plus `DEFAULT_CUT_AT` 1 instead of 0.6 and the matching test pins; no other change.
- 32k suite settings: window 32,768, reserve 16,384, `keepRecentTokens` 3,333, `deepseek/deepseek-v4.1-flash-1017` pinned to DigitalOcean, 30 minutes and 120 turns per task, chains t01 to t05 (150 paired tasks), both arms of a chain run together, two chains at once.
- No disk-full message, crash or wait in any session; the longest gap between events was 300 s.

## The registered bar (four conditions)

| # | Condition | Arm H | Arm J | Result |
|---|---|---|---|---|
| 1 | Turns per task on the 112 tasks both arms resolved fall at least 15% | 23.37 | 13.53 | fall 42.1%: **met** |
| 2 | 0 lost tasks (dead tasks) on J | 0 | **1** | **not met** |
| 3 | Resolved on J no lower than on H | 116 | 122 | **met** |
| 4 | Pi usage spend per task on J no higher | $0.0058 | $0.0039 | **met** |

**J does not meet the bar as registered: condition 2 fails by one task.** Conditions 1, 3 and 4 are met by wide margins.

## The lost task

- t03 task 24 (`pylint-dev__pylint-7080`) in arm J ended in 0.02 s with 1 turn and **no request carrying a token**, with the assistant error "This operation was aborted". It is a task lost at its prompt, which is the definition of a dead task. The next task (25) ran normally.
- No pi-tuck refusal notice was logged for it, so the refusal counter (matching the two known notices) first reported 0 dead tasks and the script printed a pass. I found it with an independent check (every task that finished in under 2 s with at most 1 turn, or sent no tokens), and the counters now also count any task no request carried tokens for. A recount of every 32k arm changes only this one: A, M, F, G, P and Q have 0 dead tasks; B 52 (plus 4 mid-run); C 1 (plus 5); H 0 (plus 1 mid-run); J 1. See `DEVIATIONS.md`, entry of 2026-11-01.
- The same instance at the same position fails in other arms: arm H lost it after 3 requests (a mid-run refusal, "mandatory context cannot fit") and arm C lost it at its prompt with a refusal notice logged (`RESULTS-32K-ACCEPT.md`). So the loss is not specific to J; whether the missing notice in J has a different cause is not shown by the log.

## Readouts with no pass line

| | Arm H | Arm J |
|---|---|---|
| Resolved of 150 | 116 | 122 |
| Turns per task (all 150) | 24.70 | 13.15 |
| Cuts (compaction entries) | 1,789 | 626 |
| Cuts per task (at run end / in the loop) | 11.93 (0.11 / 11.81) | 4.17 (0.08 / 4.09) |
| Tasks ended at the wall cap | 0 | 0 |
| Mid-run refusals | 1 (t03 task 24) | 0 |
| Input / output / cache-read tokens | 8.15 M / 0.95 M / 22.59 M | 6.19 M / 0.54 M / 19.44 M |
| Total tokens | 31.69 M | 26.16 M |
| Pi cost estimate (ten sessions) | $0.87 | $0.58 |
| `tuck_recall` calls (with an offset) | 22 (1) | 60 (9) |

- Paired J minus H: resolved +4.0 points (J-only 10, H-only 4), one-sided 95% lower bound +0.0 (paired bootstrap, 10,000 draws, seed 1). Turns per task −11.55 (upper bound −8.42); on the 112 tasks both resolved, −9.84.
- Per chain, resolved difference in points: t01 −6.7, t02 +6.7, t03 −3.3, t04 +10.0, t05 +13.3.
- J reads more of the rest of clipped results: 9 `tuck_recall` calls with an offset against 1. The clip itself is applied to requests and is not recorded, so this is a proxy only; R&D's replay clips 20 results for the cut-later build against 8 for the base.

## Limits

- One model, one window and one `keepRecentTokens` (3,333); one run per arm; five chains. Nothing here tests Pi's default `keepRecentTokens` of 20,000, which is the Pi-defaults check (arm N).
- Conditions 1, 3 and 4 are point comparisons. Condition 1 is a ratio of means on 112 tasks; condition 4 uses Pi's own cost estimate, not the provider invoice.
- Condition 2 is a count of one. The registered rule is exact and is applied as registered.
