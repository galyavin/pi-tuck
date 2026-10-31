# PREREG addendum: the 32k live suite

Written 2026-10-31, before any result of this suite. `PREREG.md` is unchanged and still governs the main run. The first half of this file fixes the setup, the second half what is measured and how it is read.

**Why.** At the main run's 128k window, 52 of 53 live cuts kept the whole current task word for word (R&D, `rnd/postcut.py`), so the main live run never tests a summary on work in progress. A 32k window makes tasks larger than the room common, so cuts must summarise part of the task at hand. Decision by the CEO.

## Setup

- **Same** harness (`harness/live.py`), prompts, container tools, grader, caps (30 minutes of working time, 120 turns) and rules as the main run. A chain with a task that ended in a provider error is redone, as in the main run.
- **Model**, for both arms: `openrouter/~deepseek/deepseek-flash-latest`, thinking `high`, through `OPENROUTER_API_KEY` (per-token, approved by the user as the fallback; spend reported). The window is forced to 32,768 and the reply cap to 8,192 in each arm's isolated agent dir (`modelOverrides`), so Pi's reserve is 8,192 and the input room 24,576 for both arms. The model's own window is 1M; without the override neither compactor would see 32k.
- **Reserve 8,192, not 16,384** (CEO approved). A first smoke at a 16,384 reserve (room 16,384) made pi-tuck 1.0.1 refuse with "mandatory context cannot fit or reduce the request budget" on the second and third task of a three-task chain, and the aborted run left the next task aborted at once; Pi's compaction ran normally. The tool schemas, system prompt and task prompt leave too little of a 16k room. This is reported as a finding about pi-tuck at a 16k room (the 1.0.3 result of the same check is in the results when it exists). The smokes are kept under `runs/smoke32-old/` and `runs/smoke32-r16/` and are not results.
- **`keepRecentTokens` = 5,000** for Pi's native compaction: the main run's 20,000 of a 98,304 room scaled to 24,576. Same setting in both arms. Pi-tuck has no such setting.
- **Arms.** A: Pi's built-in compaction. B: pi-tuck **v1.0.3, commit `656f77a`** (npm latest at the time, lean cuts and the small-window tail fix included), semantic recall on. This is not the main run's pin (1.0.1, `d71234a`), by decision of the CEO: 1.0.1 re-cuts every round or two at small windows (a defect fixed after it), so testing it here would measure a known bug, not what users get. The main run is unaffected and stays at 1.0.1. An earlier plan for a third arm (1.0.1 plus only the tail fix) was dropped for the same reason.
- **Tasks.** Chains of 30 tasks, same order in both arms, seed 20261031 (`harness/select_w32.py`). **First batch, run now: five chains** (`t01`-`t05`, 150 per arm), drawn from the eligible instances that no running main chain uses: the 61 the main draw left over, the 16 of the pilot and the 90 of the finished main chains `s01`-`s03` (167 in all, 150 used). Disjoint from `s04`-`s10`, so the suites never share a task image at the same time. **Second batch, after the main run has finished and freed its disk and images: five more chains** (`t06`-`t10`), drawn with the same seed from the 17 tasks the first batch left plus the tasks of `s04`-`s10`. The CEO set five plus five because three chains give about 25 affected tasks and about two discordant pairs, too few to decide anything (R&D's count from its 32k replays).
- **Spend.** Tokens and dollars come from Pi's usage cost per session (not the account total, which other work shares). Tripwire (eval lead's pick): if the suite's cumulative cost passes $60, stop and ask the CEO.

## What counts as summarising the current task

For each compaction entry in a session file, the task is the one whose prompt entry most recently precedes it. The cut **summarises part of the current task** if the entry named by `firstKeptEntryId` comes after that task's prompt entry (R&D's rule in `rnd/postcut.py`). Per arm.

The **primary subset S** is the paired tasks where such a cut happened in A or in B (either). Sensitivity subsets: in A only, in B only, in both. S is defined from the runs themselves, so it is not blind to the arm; this is why all paired tasks are reported next to it.

## Readouts

1. **Resolve rate**, B against A, paired by chain and task: the difference in points (B minus A), discordant counts, and a one-sided 95% lower bound from a paired bootstrap over tasks (10,000 draws, seed 1). Reported on S and on all paired tasks, and per chain. Tasks in one chain share a context, so the task-level interval is narrower than the truth; a bootstrap over chains is shown beside it once at least ten chains are in, and the per-chain differences always.
2. **Turns per task**, B against A: mean paired difference with the same bootstrap, on S and on all paired tasks, and on tasks both resolved.
3. **Secondary:** tokens per session (input plus output with and without cache reads); cuts per session and the context carried after a cut, from the session files (`analysis/sessionlog.py`); the share of tasks stopped by the wall or turn cap or ended in a provider error, per arm; pi-tuck refusals ("mandatory context cannot fit") per arm; spend.
4. **Claim form**, as for Test 2: report the bound. A statement of "no loss larger than X points" is made only for an X the lower bound supports. No pass threshold is set before the result.

## Rules

- **Batches.** The first look is the first batch alone, and its result is reported as such. The second batch is part of the plan, not a response to the first batch's sign; the final tables report the two batches separately and pooled. No further chains are added except by the CEO's decision on interval width.
- **Setup misbehaves.** If in both arms more than 40% of tasks end stopped by a cap or in a provider error, the window is the problem, not a compactor: stop and ask the CEO. A pi-tuck-only failure (refusals, aborted runs) is a result and is reported, not a reason to stop.
- **Not claimed.** Nothing here carries to other models or windows, and the suite does not replace the main run's claims. A pi-tuck refusal that ends a run counts as unresolved, like any task not resolved.
