# The main run: pi-tuck 1.0.1 against Pi's compaction, 10 chains of 30 tasks (tests 1a, 1b-Terra, 2 and 3)

Registered in `PREREG.md` (frozen before the run) with the addenda `PREREG-TERRA.md` and `PREREG-CLUSTER.md`. Read on 2026-11-05 after all 20 live sessions and the replay had finished, in the registered order: test 1a, then tests 2 and 3, then test 1b-Terra once its recording set was closed (below). Raw session files and events stay outside git.

## What ran

- pi-tuck 1.0.1 (`d71234a`), semantic search on, against Pi's own compaction (keepRecent 20,000), on `mac-studio/main:xhigh` (Qwen3.8 Flash Next IQ3_S), window 128,000, reply reserve 32,768.
- Live: 10 chains of 30 SWE-bench Verified tasks (seed 20261030), arm A = Pi's compaction and arm B = pi-tuck, 300 tasks per arm, official grading, 30 minutes and 120 turns per task.
- Replay: the 20 recordings (10 chains, A and B each); every compactor cuts at the same raw positions and is probed on facts whose evidence is at least 35,000 raw tokens before the cut.
- Infrastructure failures during the main run (chains s01 and s09 among them) are recorded in `DEVIATIONS.md`; the affected attempts were set aside unread and the chains redone from task 1 in both arms.

Comparator names, used exactly: **"Pi's compaction prompts on mac-studio/main:xhigh"** (the local compactor, `native-local`) and **"Pi's compaction prompts on GPT-6.1 Terra"** (`native-terra`).

## What tests 1a and 1b-Terra compare (read this before the numbers)

These are **not summary against summary.** In both tests the agent that answered the probes was the same model (`mac-studio/main:xhigh`), but its tools differed by variant (`replay/answer.ts`):

- **pi-tuck** (`tuck`) answered with pi-tuck's real **`tuck_recall` and `tuck_search`** tools, which read back the original history preserved before the cut; `tuck-lexical` (semantic search off) kept `tuck_recall` and the keyword lookup.
- **"Pi's compaction prompts on mac-studio/main:xhigh" and "Pi's compaction prompts on GPT-6.1 Terra"** answered with **no recall tool**: a Pi session over the replayed history and the compaction entry, with Pi's built-in tools in an empty working folder, so the answer came from the summary and the kept recent messages alone.

So the tests compare pi-tuck's summary together with its recall tools against Pi's summary alone. **There is no arm of pi-tuck without its recall tools in tests 1a and 1b**, so no difference and bound for that exist in this run, and none were run for this record. (The separate recall benchmark, `PREREG-RECALL.md`, has a `tuck-norecall` arm on a different set of questions; it has not been analysed and cannot give a difference for these probes.) The probes ask for facts whose evidence is at least 35,000 raw tokens before the cut, which is where a recall tool can matter most.

Details, from the answer logs:

- **Tools.** pi-tuck's agent had Pi's built-in tools plus `tuck_recall` and `tuck_search`; the comparators' agents had Pi's built-in tools only. Tool calls over all asks: pi-tuck `tuck_recall` 2,034, `tuck_search` 205, `bash` 9; Pi's compaction prompts on mac-studio/main:xhigh `bash` 178, `read` 1, and 1 call to `tuck_recall`, a tool it did not have; Pi's compaction prompts on GPT-6.1 Terra `bash` 236, `read` 2, and 1 call to `tuck_recall`.
- **Could a comparator read the original history?** Not through a recall tool. The replayed history lives in memory (no session file) and the working folder was an empty temporary folder. But `bash` was unrestricted and the recordings sit on the same disk, and the log keeps tool-call counts, not their commands, so I cannot rule out that a comparator read one; nothing in the logs shows it, and the comparators' low accuracy on the error-class and test-runner probes does not suggest it.
- **Recall calls by pi-tuck.** Over all 95 asks (one ask per cut, all of a cut's probes in one prompt; 1,961 probes): 1.04 `tuck_recall` and 0.11 `tuck_search` calls per probe, 1.14 together; every ask made at least one call. The variant with meaning search off made 1.25 per probe.
- **Probe types.** The 783 probes behind test 1a and the 728 behind 1b-Terra are all mechanical: files changed (194 and 180), test-runner summary (172 and 162), required tag (202 and 187), error class (172 and 159), result-line rule (43 and 40). The judge-scored next-step probes (95 in the replay probe set, scored for every variant) are not in them: their evidence is the step the agent took at the cut, which lies at or after the first entry kept, so they fail the registered rule that a probe counts only if the compactor did not keep its evidence. The size of what each compactor writes also differs: median summary 85,561 characters for pi-tuck, 23,598 for the local compactor and 11,200 for Terra, while the context carried after a cut is similar (27,656, 25,790 and 22,784 tokens).

## Test 1a: retention against Pi's compaction prompts on mac-studio/main:xhigh (all 20 recordings)

| | pi-tuck | Pi's compaction prompts on mac-studio/main:xhigh |
|---|---|---|
| Accuracy on the probes each was asked | 89.7% (783 probes) | 61.8% (1,677 probes) |

The two accuracies are over different probe sets (a probe counts for a compactor only if that compactor did not keep its evidence in the tail). The registered difference D is over the **783 probes both were asked**:

- **D = +25.7 points. One-sided 95% lower bound +22.0** (bootstrap over recordings, 10,000 draws, seed 1, under the registered two-comparator command; +21.9 when run alone, because the bootstrap's random numbers are shared in sequence) and **+22.3** by the chain-clustered robustness bound (`PREREG-CLUSTER.md`). Both bounds are above the −3 point margin and agree.
- **Test 1a is supported**: pi-tuck's retention is not more than 3 points below that of Pi's compaction prompts on mac-studio/main:xhigh, on these probes. It is not a statement about any other compactor.
- Mechanical probes alone: D = +25.7, lower bound +22.0. Paired disagreement 27% of the 783 probes. Probes needed for a 3-point bound at 80% power (cluster-aware): 2,969. The 783 shared probes are fewer than that, so the test is not powered to certify a difference near the margin, but the observed bounds are far above it.
- By probe type (accuracy %, pi-tuck / Pi's compaction prompts on mac-studio/main:xhigh): error class 80.2 / 24.7, files changed 84.5 / 78.9, result-line rule 100.0 / 100.0, required tag 100.0 / 99.3, test-runner summary 90.1 / 31.6.
- By cut number (pi-tuck / local): cut 1 91.8 / 63.7, cut 2 89.6 / 62.0, cut 3 83.7 / 63.6, cut 4 93.7 / 60.1; the local compactor was probed to cut 7, pi-tuck to cut 4.
- Secondary: pi-tuck with semantic search off scored 86.1% (879 probes).

## Test 1b-Terra: retention against Pi's compaction prompts on GPT-6.1 Terra (19 of 20 recordings; s09-A missing)

**Recordings: 19 of the 20 registered. s09-A is missing.** Its Terra cut job failed on every try for 72 hours (2026-11-01 to 2026-11-04) and again at a restart on 2026-11-05 with "The ChatGPT user has reached their Subscription Sharing usage limit": a usage cap, unrelated to any outcome. The user closed the set at 19 on 2026-11-05, before any Terra score, accuracy or comparison had been read, and it stays closed even if Terra becomes available later (`DEVIATIONS.md`, entry of 11:22). The comparator is named exactly **"Pi's compaction prompts on GPT-6.1 Terra"** (Pi's own summarise and update-the-previous-summary prompts, model `openai/gpt-6.1-terra`, thinking `xhigh`, through Pi's ChatGPT-plan sign-in); it is a lower tier than the withdrawn comparator model.

| | pi-tuck | Pi's compaction prompts on GPT-6.1 Terra |
|---|---|---|
| Accuracy on the probes each was asked | 89.7% (783 probes, 20 recordings) | 57.8% (1,685 probes, 19 recordings) |

- The registered difference D is over the **728 probes both were asked**: **D = +33.7 points, one-sided 95% lower bound +30.4** (bootstrap over recordings, 10,000 draws, seed 1) and **+30.1** by the chain-clustered robustness bound, where chain s09 carries only its B recording. Both are above the −3 point margin and agree. Paired disagreement 36% of 728 probes; probes needed for a 3-point bound at 80% power (cluster-aware): 2,062.
- **Test 1b-Terra is supported**: pi-tuck's retention is not more than 3 points below that of Pi's compaction prompts on GPT-6.1 Terra, on these probes, and Terra completed 19 recordings (the rule needs 10 or more). Mechanical probes alone: D = +33.7, lower bound +30.4.
- By probe type (accuracy %, pi-tuck / Terra): error class 80.2 / 14.7, files changed 84.5 / 72.3, result-line rule 100.0 / 100.0, required tag 100.0 / 93.3, test-runner summary 90.1 / 38.1.
- By cut number (pi-tuck / Terra): cut 1 91.8 / 57.0, cut 2 89.6 / 57.0, cut 3 83.7 / 58.6, cut 4 93.7 / 62.2; Terra to cut 5 57.1, cut 6 53.6, cut 7 50.0, cut 8 57.1 (21 probes).
- Power as stated before the results (`analysis/power_1b.py`, with the spread of all 20 recordings): at 19 recordings and a true difference of 0 the median lower bound is −3.7 and clears −3 in 38% of simulated studies; at +2 points 70%; at +4 points 95%. The observed lower bound of +30.4 is far outside that range.

### The claim, worded against the compactors that ran

Under the registered rule the comparator for claim 1 is the better LLM compactor on the shared probes; here that is Pi's compaction prompts on mac-studio/main:xhigh (61.8%, above Terra's 57.8%). The registered claim line is supported, and it is stated only as: **pi-tuck, answering with its recall tools, retains probed facts at a rate not more than 3 points below that of "Pi's compaction prompts on mac-studio/main:xhigh" (test 1a, 20 recordings) or of "Pi's compaction prompts on GPT-6.1 Terra" (test 1b-Terra, 19 of 20 recordings, s09-A missing), each answering from its summary alone, on these probes.** It says nothing about any other compactor, model or tier, and it is not worded as "at least as effective as the best LLM compactors" (`PREREG-TERRA.md`). The withdrawn comparator's partial view (8 recordings, not a test) is not part of this record.

### Post hoc and descriptive, with no pass line: how much pi-tuck used its recall tools in test 1a

Asked of the existing answer logs after the results were read; nothing was run for it.

- **No probe answer lacks the tools, so there is no summary-only arm.** In the 43 asks that hold the 783 probes behind test 1a, every ask made at least one `tuck_recall` or `tuck_search` call, so 783 of 783 probes were answered in an ask that used them. The log counts calls per ask, not per probe, so "the share of answers that made a call" cannot be measured at probe level, and there is no group of answers with no call whose accuracy could be given. Answers with no call would not have been a true summary-only arm anyway, because the tools were still offered to the agent.
- Calls per probe in these asks: 1.25 overall, from 0.57 to 2.27 across asks.
- Split by thirds of asks by calls per probe (fewest, middle, most): pi-tuck's accuracy on the probes was 87.9%, 90.8% and 90.0%, against 64.6%, 64.3% and 63.1% for Pi's compaction prompts on mac-studio/main:xhigh on the same probes. Pi-tuck's accuracy does not rise with more calls per probe in this split, but the split does not separate the effect of the summary from the effect of the tools.

## Test 2: end to end (pi-tuck 1.0.1 minus Pi's compaction, paired by task, bootstrap over chains)

| | arm A | arm B |
|---|---|---|
| Resolved of 300 | 251 (83.7%) | 258 (86.0%) |

- All 10 chains: 10 tasks resolved only by B, 3 only by A; difference **+2.3 points, one-sided 95% lower bound +0.3 points**.
- Without chain s09 (9 chains, 270 tasks): 7 only by B, 3 only by A; difference +1.5 points, **lower bound −0.4 points**.
- The registered claim is only "no loss larger than that bound". With all chains the bound is above zero, so the data show no loss; without s09 the bound is −0.4, so the claim is **no loss larger than 0.4 points**.
- Per chain (A resolved / B resolved / B-only / A-only): s01 23/25/3/1, s02 28/28/0/0, s03 24/23/0/1, s04 25/26/1/0, s05 23/25/2/0, s06 27/28/1/0, s07 27/27/0/0, s08 24/23/0/1, s09 23/26/3/0, s10 27/27/0/0.
- **Chain s09 matters.** In s09-A Pi's compaction failed 44 times with "generation hit the token cap" (3 more were aborted) from task 23 on, and the chain ended 7 tasks at the 30-minute cap against 4 for s09-B; no other chain has a failed compaction. The chain stays as registered (no infrastructure failed). Wall-ended tasks over all chains: arm A 15, arm B 14; none ended at the turn cap.

## Test 3: speed and cost

- **(a) Latency per cut.** Live: median **0.081 s for pi-tuck (46 cuts)** against **235.3 s for Pi's compaction (48 cuts)**; p90 0.279 s and 403.8 s; no failed cut among the counted cuts of either arm (the 44 failed compaction attempts in s09-A appear as errors in its events and have no compaction entry in the session file). Replay, per compactor: pi-tuck median 0.061 s (95 cuts), Pi's compaction prompts on mac-studio/main:xhigh 154.6 s (86 cuts), Pi's compaction prompts on GPT-6.1 Terra 53.2 s (87 cuts over 19 recordings; Terra's cuts ran through Codex, not on the local server).
- **(b) Tokens per session, paired by chain (bootstrap over sessions, 10,000 draws, seed 1).**
  - Pi's session total (input, output, cache, summarisation included): arm B uses 3.37 million fewer tokens per session on average (6 of 10 sessions lower), but the one-sided 95% upper bound is +1.60 million, so **not supported**.
  - Input plus output without cache reads: 241,000 fewer per session (7 of 10 lower), upper bound −21,000, so **supported with all chains**. Without s09 the mean is −174,000 and the upper bound +43,000, so **not supported without s09**.
- **(c) Context carried after a cut, informational.** Live medians 26,790 tokens (arm B) and 27,750 (arm A); replay medians 27,656 for pi-tuck, 25,790 for Pi's compaction prompts on mac-studio/main:xhigh and 22,784 for Pi's compaction prompts on GPT-6.1 Terra (summary medians 85,561, 23,598 and 11,200 characters).
- Agent wall time per session: arm B minus A is +431 s over 10 chains (+1,798 s over 9, without s09).

## Limits (the registered "not claimed", and what this run adds)

- Tests 1a and 1b-Terra compare pi-tuck with its recall tools against summaries alone (section above); they do not show how much of pi-tuck's result comes from the summary and how much from recall.
- Fixed-size SWE-bench-style tasks, one local model, one build of each system. Nothing here is a statement about any other compactor, model, tier or window.
- The probe set depends on the compactors: accuracies are over different probes, and D is over the shared ones.
- The Test 2 and Test 3(b) verdicts change when chain s09 is left out, so both views are given.
- 1b-Terra rests on 19 of 20 recordings; the set is closed and s09-A is missing because of a usage cap.
