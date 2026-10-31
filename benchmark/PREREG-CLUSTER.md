# PREREG addendum: a chain-clustered robustness bound beside the registered bound

Written 2026-10-31 18:06 CDT, before any outcome of Test 1a was read. `PREREG.md` is unchanged; the registered bound stays the decision rule for every test, and the decision to keep the registered number of recordings (20) was made without reference to any outcome.

## Why
The A and B recordings of one chain hold the same 30 tasks in the same order. In the spread of Test 1a's probes (no means), the per-recording mean difference of the two arms of a chain correlates +0.42 across the 7 chains that had both. So the registered bootstrap over recordings treats as independent clusters that are not, and its interval is too narrow. The chain is the independent unit.

## What is added
- **A robustness bound** for **Test 1a** and **Test 1b** (and 1b-Terra): the same difference D and the same one-sided 95% lower bound by bootstrap (10,000 draws, seed 1), but resampling **chains**, each carrying both of its recordings together, instead of single recordings. `analysis/replay_stats.py` prints it beside the registered bound on every comparator line, and under the claim line it says whether it agrees with the registered bound on clearing the -3 point margin.
- **Test 2** already resamples chains with both arms of each chain together (`analysis/live_stats.py`: bootstrap over session chains, tasks paired); the registered bound there is the cluster-aware one, so nothing is added; the text says so.

## Rules
- **The registered bound decides.** The robustness bound does not change a verdict; it is reported beside it in every write-up (README tables, results notes), side by side.
- **If the two disagree on clearing -3, the text says so plainly**, in the same sentence as the verdict, with both numbers.
- **The registered number of recordings stays 20** (10 chains). Power figures for 1a and 1b are stated for both clusterings (`analysis/power_1b.py`); the interim outcomes play no part in any of these decisions and are not cited as a reason.
