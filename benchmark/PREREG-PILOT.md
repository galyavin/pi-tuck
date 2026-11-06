# PREREG addendum: the thinking-level pilot (mac-studio/main, medium against xhigh)

Written 2026-11-05, before any run of this pilot. `PREREG.md` and `PREREG-32K.md` are unchanged. This is a short pilot that decides one setting for the two mac-studio gates (the 1.0.11 tier 1 gate and the cut-later tier 2 test). It is not a gate of any build.

**Why.** On mac-studio/main at `xhigh`, a request takes about 100 to 140 s even when it generates little, and 27 of 30 tasks of arm N ended at the 30-minute cap (`RESULTS-DEFAULTS-1010.md`). Tier 1 at 60 pairs would take about 3 days and tier 2 at 150 about 7.4 days (my estimate). The maintainers decided to test whether `medium` is at least twice as fast per task and still resolves tasks; if so both gates use `medium`, since each gate compares two builds at the same setting.

## Arms

- **S**: pi-tuck 1.0.11, commit `22043bb`, thinking level `medium`.
- **U**: the same build, thinking level `xhigh`.

## Setup

- Suite `w32g`: `mac-studio/main`, window 32,768, output cap 16,384, `reserveTokens` 16,384 and `keepRecentTokens` 3,333 (the 32k suite's compaction settings, which both gates use). Rule approved by the maintainers on 2026-11-02: a 120-turn cap per task, **no wall cap**, and a task with no event for 3,600 s is an infrastructure stall (the session ends and is set aside, never scored).
- One chain `p01`: the first six tasks of t06 (`django__django-16569`, `django__django-13794`, `sympy__sympy-15809`, `django__django-15368`, `django__django-13516`, `django__django-14315`), the same tasks in the same order for both arms, the two sessions at the same time on two mac-studio lanes. The pilot stops when both sessions have finished the six tasks or after 4 hours of running, whichever comes first; only tasks finished in both arms are compared.

## Decision rule (the maintainers', with my definitions)

Both gates use `medium` when both hold:

1. **At least 2× faster per task**: over the tasks finished in both arms, the total seconds of arm U divided by the total seconds of arm S is at least 2.
2. **Still resolves tasks**: arm S resolves at least one task, and at least half as many as arm U on the same tasks.

Otherwise both gates use `xhigh`, and the durations I gave stand.

## Reported with the decision

Seconds per task, turns per task, seconds per completed request (median and mean) and output tokens per arm; resolved tasks per arm on the common tasks; tasks finished, tasks ended at the turn cap; any stall.

## Limits (stated before the result)

- Six tasks, one run per arm: the decision is a coarse screen, not a measurement of resolve rate. Two sessions share the server, so absolute times belong to that load.
- Turns can differ between the settings; the rule uses seconds per task, which includes that.
