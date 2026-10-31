# PREREG addendum: the shipped build, pi-tuck 1.0.3

Written 2026-10-31, before any result for 1.0.3 on the main suite. `PREREG.md` is unchanged and stays the pre-registered primary for **1.0.1** (`d71234a`); its results are published in full, labelled "1.0.1, pre-registered primary". This addendum adds the same tests for **pi-tuck 1.0.3 (`656f77a`)**, the build users install (decision of the CEO, from the user). `BACKLOG.md`, item 1.

## What is added

- **A replay variant `tuck-103`.** pi-tuck 1.0.3 (semantic recall on) as one more compactor in the paired replay of all 20 recordings: the same recordings, the same raw cut positions, the same probes (`probes.json`, frozen), the same agents, scoring and judge as `PREREG.md`. Run with `harness/run_variant.py --variant tuck-103 --tuck runs/tuck-1.0.3` (`replay/cuts.ts`, `replay/answer.ts`, `replay/score.ts`), and read with `analysis/replay_stats.py --sut tuck-103`. Replay applies each build's draft at the same raw positions, so it does not exercise a build's own trigger (1.0.3 cuts at 60% of the room by default; 1.0.1 at the full room); the live arm C does. The cuts are model-free and can be made as soon as a recording exists; the answers wait for the local server (after the main replay), in the order: primary agent on all 20 recordings, then the secondary agent as quota allows.
- **A live arm C.** pi-tuck 1.0.3 on the ten main chains (`s01`-`s10`, 30 tasks each, 300 tasks), as a new Pi session per chain: the same model (`mac-studio/main`, `xhigh`), window, reserve, `keepRecentTokens`, prompts, container tools, grader, caps and isolated-agent-dir settings as arms A and B (`harness/live.py --arm C`). **Arm A is shared**: C is compared with the A sessions already run, so C is not run side by side with A. This is a deviation from the main design (arms in step, same server load); the cost is that C and A saw the server at different times, which can move wall time and, through the 30-minute cap, a few outcomes at the margin; it is stated beside every time and resolve-rate comparison. C starts when the main live run has ended, four chains at a time. A chain with a task that ended in a provider error is redone, as in the main run.

## Tests (each is the main test with the build changed)

1. **Retention, 1.0.3** (Test 1): supported against the local summarizer if the one-sided 95% lower bound of (accuracy of `tuck-103` minus the local summarizer) is above -3 points, with the same views and the same frontier rule as `PREREG.md`.
2. **End to end, 1.0.3** (Test 2): the lower bound of (resolve rate C minus A), paired by task, bootstrap over chains, reported as a bound with no pass line, as in Test 2.
3. **Speed and cost, 1.0.3** (Test 3): median replay latency per cut; tokens per session C against A, paired by chain; cut counts, carried context, and the share of cuts that free less than a tenth of the room, from the session files.
4. **1.0.3 against 1.0.1, both directions.** On every readout above, the difference 1.0.3 minus 1.0.1 (probes paired for retention; chains paired for tokens; tasks paired for resolve rate, C against B), with the bound in each direction. Wherever 1.0.3 is the worse of the two on a point estimate, the results say so in plain words, with the interval.

## Which numbers are the headline

The README's headline numbers are the 1.0.3 numbers where the tests above are supported; the 1.0.1 numbers are shown beside them with their label. If a 1.0.3 test is not supported, the headline claim is narrowed to what is, and says which build it holds for.

## Not claimed

Nothing about builds after 656f77a, and nothing the 1.0.1 run did not already cover. The independent-question benchmark (`PREREG-RECALL.md`) measures both builds on its own.
