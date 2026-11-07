# pi-tuck

**Compaction for [Pi](https://pi.dev) with no model call, and a history the agent can search by keyword, and on Apple silicon by meaning, all on your machine.** In our 128k live run, a cut took a median 0.08 s (pi-tuck 1.0.1). It costs no tokens. The same session always gives the same summary. And nothing is lost: the agent can read back anything earlier, word for word, and on Apple silicon it can find it by meaning.

```sh
pi install npm:pi-tuck
```

## pi-tuck against Pi's built-in compaction

Pi's built-in compaction asks a model to write a summary. pi-tuck builds the summary from the session itself. The time, context and task rows compare pi-tuck 1.0.1 with Pi 1.4.0's built-in compaction, where a local model writes the summary. Each measured result in this README names the pi-tuck build or version it was measured on; the release you install may be newer.

| | Pi's built-in (local model writes the summary) | pi-tuck |
|---|---|---|
| Model call per cut | One, to a model you pay for or wait on | None |
| Time per cut | **235 s** (median) | **0.08 s** (median; an upper bound, see below) |
| Context carried after a cut | 27,750 tokens | 26,790 tokens (about the same) |
| Facts cut away, asked back at 128k (mechanical probes) | Answered from the summary alone, with no recall tool | Answered from the summary and pi-tuck's recall tools, cuts 1 to 4 only. Claim line below the table |
| Tasks resolved at 128k (300 SWE-bench Verified tasks per arm, pi-tuck 1.0.1) | 251 of 300 | 258 of 300. The registered claim is only "no loss larger than 0.4 points"; chain s09 matters, see below |
| Same session, same summary | Not guaranteed, since a model writes it | Yes |
| Can the agent get dropped detail back | No recall tool in Pi 1.4.0. The full history stays in the session file, but the agent has no tool made to search it | Yes. `tuck_recall` reads any original exactly |
| Search history by meaning | No | Yes, with `tuck_search`, on macOS with Apple silicon. It runs locally on your Mac's GPU, and no text leaves your machine. Elsewhere there is no `tuck_search`, and `tuck_recall` searches by keyword |
| Can the summary invent history | It can, since a model writes it | No, it holds only recorded text |
| What the summary leaves out | Whatever the model dropped | Tool output only; the agent reads it back exactly |
| Tasks resolved at a 32k window (150 SWE-bench Verified tasks, one model, pi-tuck 1.0.5) | 94 of 150 | 120 of 150 (+17.3 points, 95% lower bound +10.7). Limits below the table |

The time and context rows are from the 128k live run: 10 chains of 30 tasks, pi-tuck 1.0.1, medians over 46 pi-tuck cuts and 48 cuts by Pi's compaction. pi-tuck's cut time is an upper bound, read from the session file ([`benchmark/DEVIATIONS.md`](benchmark/DEVIATIONS.md)).

The retention row is a paired replay on mechanical probes only: files changed, test-runner summary, required tag, error class and the session's result-line rule. No probe judged how well an agent reasons. The claim line, as [`benchmark/RESULTS-MAIN.md`](benchmark/RESULTS-MAIN.md) words it: **pi-tuck, answering with its recall tools, retains probed facts at a rate not more than 3 points below that of "Pi's compaction prompts on mac-studio/main:xhigh" (20 recordings) or of "Pi's compaction prompts on GPT-6.1 Terra" (19 of 20 recordings, s09-A missing), each answering from its summary alone, on these probes.** This is not summary against summary: it compares pi-tuck's summary together with its recall tools against Pi's compaction without them, and the run has no pi-tuck arm without its recall tools. It says nothing about any other compactor, model or window.

In the replay behind pi-tuck's retention numbers, 52 of its 95 answer sets ended in an abort (0 of 95 for Pi's compaction prompts on the same local model), so those numbers cover cuts 1 to 4 only and no retention claim is made past cut 4; see [`benchmark/RESULTS-MAIN.md`](benchmark/RESULTS-MAIN.md).

The 32k row is one model, one window and five chains. Observation masking, a third approach, resolved 117 of the same 150 tasks (pi-tuck +2.0 points, lower bound −2.7: no difference shown). In the 32k run only pi-tuck was held to the 16,384-token room: Pi's built-in compaction sent a request over it in 97 of 150 tasks. Every number comes from a file in this repository. Conditions, sample sizes and the full limits are in [Benchmarks](#benchmarks).

## Ask your history

A summary cannot hold everything. So pi-tuck lets the agent look things up instead of guess. Say you fixed a login bug two hours ago, and the summary no longer holds the details. You ask:

> "What was the reason we dropped the retry on the token refresh?"

The original message says "removing the backoff loop from the auth renewal". The words differ, so a keyword search finds nothing. The agent calls `tuck_search`, which also searches by meaning:

```json
{ "query": "why did we drop the retry on token refresh" }
```

It gets back the original passage, with a pointer such as `#212`. It reads the whole message, exactly as it was written:

```json
{ "index": 212 }
```

That is `tuck_recall`. The agent answers from the original text, not from a model's memory of it.

*This example is an illustration. It is not a recorded session.* The call shapes are real. **Semantic search has no measured quality numbers yet.** A test of it is pre-registered in [`benchmark/PREREG-RECALL.md`](benchmark/PREREG-RECALL.md); it has no result yet. The benchmarks below measure cut time, cost and answer retention after cuts, not how well `tuck_search` finds a passage. `tuck_search` exists only on macOS with Apple silicon. Elsewhere the agent has `tuck_recall` and its keyword search, and the example above would not find its match.

## Install

```sh
pi install npm:pi-tuck
```

Then start a new Pi session. That is all. pi-tuck takes over Pi's compaction, both automatic and `/compact`. You change no setting.

- Needs Pi 1.2.0 or later (tested on 1.2.0 and 1.4.0), on macOS or Linux. On an older Pi, pi-tuck stays off, Pi's own compaction runs, and pi-tuck says so once. Full features on macOS with Apple silicon; elsewhere, compaction and word recall.
- On macOS with Apple silicon, the first session also downloads a local search model in the background (about 390 MB, once). Until it is ready, search works by keyword. See [Semantic search](#semantic-search).
- Prefer GitHub? `pi install git:github.com/galyavin/pi-tuck@v1.0.12`.
- To pin a version, add it: `pi install npm:pi-tuck@1.0.12`.

## How it works

When context fills up, pi-tuck replaces the older turns with one summary. The summary keeps:

- **The dialogue.** What you asked and what the agent answered, in order, word for word. If it is too long for the room, it shrinks: the oldest assistant text is clipped first, then older prompts. Clipped text says how to read it in full.
- **The files.** Files the agent read, wrote or edited, newest first (up to 60), each with a pointer to read it back.
- **The action trail.** The agent's other tool calls, such as shell commands, newest first (up to 30). The output is left out. A pointer leads to it.
- **Your first prompt**, word for word (up to 12,000 characters).

Tool output stays in the session file, not in the summary. Each summary ends with a short instruction to the agent: re-read a file before you edit it, look things up, and treat anything not shown as unknown.

The summary is plain text, one line per record, such as `#12 user @2026-10-30T14:00:00Z: text`. The number is the index that `tuck_recall` takes. Summaries from earlier versions are still read.

The agent gets two tools to get anything back:

- **`tuck_recall`** finds earlier text by keyword. It reads any original message or tool result exactly, by the index shown in a summary. It can also write an original out to a file.
- **`tuck_search`** (macOS with Apple silicon only) finds earlier history related to a question, even when the wording differs. It combines keyword hits with local semantic search and returns the original text with pointers for `tuck_recall`.

On Apple silicon, both tools cost about 1,050 tokens of tool description per request. Elsewhere only `tuck_recall` is offered.

| Command | Does |
|---|---|
| `/tuck-semantic on\|off\|status` | Turns semantic search on or off for this session, or shows its state. |
| `/tuck-incident on\|next\|off\|status` | Records this session's compaction decisions to a file you can attach to a bug report. |

`/compact` works as usual, but pi-tuck does not take custom summary instructions. Pi's own setting `"compaction": { "enabled": false }` turns compaction off.

## What is proven, and what is not

**Measured so far.** In the 128k live run (pi-tuck 1.0.1), a pi-tuck cut took a median 0.08 s, where Pi's compaction with a local model writing the summary took a median 235 s. A cut calls no model, so it costs no tokens. After a cut, both carried about the same context. On mechanical probes about facts cut away, pi-tuck with its recall tools was not more than 3 points below Pi's compaction prompts on mac-studio/main:xhigh, or below Pi's compaction prompts on GPT-6.1 Terra, each answering from its summary alone (claim line above; cuts 1 to 4 only). Over 300 tasks per arm, pi-tuck resolved 258 and Pi's compaction 251; the registered claim is only that pi-tuck lost no more than 0.4 points. In replay, answers held when pi-tuck cut at 60% of the room instead of 100%. At a 32k window, in one suite of 150 SWE-bench Verified tasks with one model, pi-tuck 1.0.5 resolved 120 tasks and Pi's built-in compaction 94 (+17.3 points, 95% lower bound +10.7). Observation masking resolved 117 (pi-tuck +2.0 points, lower bound −2.7: no difference shown). The limits of each result are in [Benchmarks](#benchmarks).

**Not claimed.** This README does not say that pi-tuck is as good as or better than any compactor, model, window or kind of task other than those named, and it never calls it "the best LLM compactor". The retention tests compare pi-tuck with its recall tools against Pi's compaction without them. The tests were pre-registered before any result came in. The plans, and every result, including those that did not favour pi-tuck, are in [`benchmark/`](benchmark).

The pre-registered plan has three parts:

1. **A live run** at a 128k window on a local model, with pi-tuck 1.0.1. Ten chains of 30 SWE-bench Verified tasks per arm, with Pi's built-in compaction in one arm and pi-tuck in the other. Official grading.
2. **A paired replay with probe questions.** The same cuts, made by pi-tuck and by Pi's summarize prompts, then questions about facts that fell before the cut. Pre-registered rule: the claim holds only if pi-tuck is no more than 3 points worse than the better compactor, with a one-sided 95% bound. The comparators are named in [`benchmark/PINS.md`](benchmark/PINS.md) and above.
3. **A 32k suite**, where tasks are bigger than the room, so cuts must summarise work in progress. Its result is the 32k row above.

The plan: [`benchmark/PREREG.md`](benchmark/PREREG.md), [`benchmark/PREREG-32K.md`](benchmark/PREREG-32K.md), [`benchmark/PREREG-TERRA.md`](benchmark/PREREG-TERRA.md), and every change after the freeze in [`benchmark/DEVIATIONS.md`](benchmark/DEVIATIONS.md).

Known limits today:

- pi-tuck's summary does not explain why things happened. It holds the words that were said, not a model's reading of them. The agent must look things up. Each look-up costs a tool call.
- Small windows: an upstream that spends far more context on tool schemas than others (some OpenRouter upstreams do) can leave a small input room too little space. pi-tuck then refuses to cut rather than overflow. This made 1.0.1 refuse at a 32k window with Pi's default 16,384 reserve. Version 1.0.4 added a notice that says when the provider counts far above pi-tuck's estimate. In 1.0.4, after an oversize tool result or a "Nothing to compact" error from Pi, a session could keep refusing later prompts; 1.0.5 fixed both. Version 1.0.8 clips a fresh tool result that is too large for the room (its head and tail, with a `tuck_recall` locator to the rest) instead of refusing the run. If a small window still refuses, pin a different upstream, lower the reserve, or use a larger window; see [Small windows](#small-windows).
- Small window, after a stopped run (1.0.8 and 1.0.9 only; fixed in 1.0.10): Pi's default `compaction.keepRecentTokens` (20,000) can exceed pi-tuck's input room, which is the window less the larger of `compaction.reserveTokens` and the model's maximum output (16,384 at a 32k window with the default reserve). After a run that is stopped (Esc, or a time limit) with the context above the room, every later prompt could be refused with "The request needs a cut and Pi has none to make (Nothing to compact (session too small))", and the session stayed stuck. In one check at these defaults (pi-tuck 1.0.8, 32k window, one session of 30 tasks, one local model), 28 tasks were lost, tasks 3 to 30 ([`benchmark/RESULTS-DEFAULTS.md`](benchmark/RESULTS-DEFAULTS.md)). If you are on 1.0.8 or 1.0.9, upgrade to 1.0.10. In 1.0.10 the cut a prompt needs is pi-tuck's own, so `keepRecentTokens` no longer leaves it with nothing to cut. A rerun of the same check on the 1.0.10 candidate had no refusal and no stuck session. It had two caveats: two of its tasks had a first request the local server never answered, and 8 of its 30 tasks began without their prompt, which the refusal counter cannot see (fixed in 1.0.12; see Benchmarks and [`benchmark/RESULTS-DEFAULTS-1010.md`](benchmark/RESULTS-DEFAULTS-1010.md)). Windows of 128k and up were not affected at the defaults.
- A prompt could be lost, with no notice (1.0.10 and 1.0.11; fixed in 1.0.12). When a new prompt arrived over the cut point and pi-tuck's cut kept nothing of the conversation before it, which happens when everything since the last cut is one long turn, the prompt was dropped from the request and from the saved session. The model never saw it and usually went on with the previous task, so work you asked for could be lost, and could look answered. The next prompt ran normally. If you used 1.0.10 or 1.0.11 and a reply ignored what you had just asked, this is the likely cause. Upgrade to 1.0.12 ([`CHANGELOG.md`](CHANGELOG.md) 1.0.12).
- Cuts can come too often at small windows (1.0.11 and 1.0.12). With setups that leave a real summary and tail after a cut, pi-tuck cuts too often at small windows, freeing little each time: about 99 cuts in 200 tool rounds at an 81,920 window with a 24k setup. It costs time and extra work ([`CHANGELOG.md`](CHANGELOG.md) 1.0.12).
- Still applying from 1.0.11: a fresh assistant message larger than the free room is refused, and a short next prompt recovers (in an unattended `pi -p` run, a refusal ends the run). If a provider keeps rejecting requests in a wording Pi does not class as a context overflow, or with a bare HTTP 413, pi-tuck does not recover on its own: the session stays intact, and every prompt can fail until the request shrinks. Try `/compact` ([`CHANGELOG.md`](CHANGELOG.md) 1.0.11).
- Other extensions (1.0.10): a prompt's cut no longer goes through Pi's `session_before_compact`, so another extension's veto there no longer stops it. It never stopped a cut between tool rounds. Pi's own threshold and overflow cuts, and `/compact`, still ask other extensions as before.
- Semantic search (`tuck_search`) needs a Mac with Metal (Apple silicon). Elsewhere, compaction and `tuck_recall`'s word search work, there is no `tuck_search`, and nothing is downloaded.

## Benchmarks

Each row says what was measured, under which conditions, and where the data is.

| What | Result | Conditions | Source |
|---|---|---|---|
| Pi's default compaction settings, 32k window, pi-tuck 1.0.10 candidate | Passed as registered: 0 dead tasks and 0 stuck sessions on 30 tasks, on a slow local server (27 of 30 tasks hit the 30-minute wall cap, and 2 had a first request the server never answered). 6 resolved. A counter written later, which counts a task with no token as dead, would count those 2. **The registered counter counts refusals and cannot see a task that began without its prompt**: in 8 of the 30 tasks (4, 8, 9, 10, 13, 14, 17, 21) a cut at the prompt kept no turn, none of the 8 resolved, and 6 ended with an empty patch. So the pass shows no refusal, not that every task began with its prompt. The 1.0.11 candidate on the same test had 7 of 30 such tasks, 1 resolved. Fixed in 1.0.12 | Candidate `a67ec30` of 1.0.10, `mac-studio/main`, window 32,768, output cap 16,384, Pi's default `reserveTokens` 16,384 and `keepRecentTokens` 20,000, one session of chain t06. One mid-run refusal (a round with 9,020 tokens of reasoning against the 16,384-token room). One session per arm, one model. In 12 of the 15 tasks across both arms the model's own first messages show it lacked the prompt; the other 3 are not clear from the records | [`benchmark/RESULTS-DEFAULTS-1010.md`](benchmark/RESULTS-DEFAULTS-1010.md) |
| Pi's default compaction settings, 32k window, pi-tuck 1.0.8 | 28 of 30 tasks lost (tasks 3 to 30, each refused at its prompt); 1 resolved. Fails the pre-registered bar of 0 lost tasks | pi-tuck 1.0.8 (`86935e9`), `mac-studio/main`, window 32,768, output cap 16,384, `reserveTokens` 16,384 and `keepRecentTokens` 20,000 (larger than the room), one session of chain t06. One session, one model, one build: it shows that the failure occurs at these settings, not how often. Not comparable with other rows | [`benchmark/RESULTS-DEFAULTS.md`](benchmark/RESULTS-DEFAULTS.md) |
| Tasks resolved, 32k window | Pi's built-in compaction 94 of 150; pi-tuck 120 of 150 (+17.3 points, 95% lower bound +10.7); observation masking 117 of 150 (pi-tuck +2.0, lower bound −2.7: no difference shown). Turns per task: 9.4 (built-in), 24.0 (pi-tuck), 11.9 (masking). Tokens per session: 6.10 M, 6.39 M, 7.02 M. Spend per arm for the five sessions: $0.87, $0.55, $0.94 | pi-tuck 1.0.5 (commit `aa30824`, the 1.0.5 code; 1.0.6 and 1.0.7 are not measured). DeepSeek V4.1 Flash pinned to one upstream, window 32,768, reserve 16,384, 5 chains of 30 SWE-bench Verified tasks, paired by task, one-sided bootstrap over tasks. **Limits:** only pi-tuck is held to the 16,384-token room (the built-in sent a request over it in 97 of 150 tasks, masking in 73, so the window is nominal for them). The difference by chain is +10.0, −3.3, +50.0, +16.7 and +13.3 points; leaving out chain t03 it is +9.2. The bootstrap resamples tasks, not chains. The pi-tuck arm ran at a different time from the others. One model, one window. pi-tuck refused to cut mid-run in 5 tasks, where one fresh tool result was larger than the room; they count as unresolved. In the same setup pi-tuck 1.0.3 resolved 72 of 150, with 52 dead tasks (tasks refused at their prompt after an earlier failure). In the pi-tuck arm of this row there was 1 dead task (t03 task 24: refused at its prompt with "Nothing to compact"; the next task ran normally), so this build missed the pre-registered acceptance bar of zero dead tasks by one task (the other part of the bar, no loss against 1.0.3 by more than 3 points, was met) | [`benchmark/RESULTS-32K-ACCEPT.md`](benchmark/RESULTS-32K-ACCEPT.md) |
| The 1.0.10 candidate against 1.0.9, 32k window | 0 dead tasks in both arms; no mid-run refusal. Resolved 50 of 60 (1.0.9) and 49 of 60 (1.0.10 candidate): −1.7 points, 95% lower bound −8.3. **The gate failed as registered, by one task**; 1.0.10 shipped as an exception because of the small-window defect. 6 of the 1.0.10 candidate's 60 tasks began without their prompt (4 of them resolved), against 0 in the 1.0.9 arm; fixed in 1.0.12. Turns per task 25.08 and 29.12; cuts 731 and 884; total tokens 13.07 M and 15.12 M | Pre-registered gate. pi-tuck `a67ec30` against 1.0.9 (`cd4626b`). DeepSeek V4.1 Flash pinned to one upstream, window 32,768, reserve 16,384, `keepRecentTokens` 3,333, chains t01 and t02, 60 paired tasks. One model, one window, one run per arm; 60 tasks cannot separate a one-task difference from run-to-run variation | [`benchmark/RESULTS-V110.md`](benchmark/RESULTS-V110.md) |
| The 1.0.8 candidate against 1.0.7, 32k window | 0 dead tasks in both arms. Resolved 46 of 60 in both (+0.0 points, 95% lower bound −6.7). No mid-run refusal in either arm. Turns per task 25.37 (1.0.7) and 26.10 (1.0.8) | Pre-registered gate, passed as registered. pi-tuck `a2e7d1a` (the tool-result clip and the cut at the end of a run, on 1.0.6) against 1.0.7. Released 1.0.8 is that build merged with 1.0.7's Metal-only recall; its replay requests are reported byte-identical to the gated build on 29 recordings (stated in the source file, not re-run for this README). DeepSeek V4.1 Flash pinned to one upstream, window 32,768, reserve 16,384, chains t01 and t02, 60 paired tasks, both arms run together. One model, one window, one run per arm; 60 tasks cannot show a difference smaller than the bound. The run shows that the change introduced no refusal; no refusal occurred in the 1.0.7 arm for the clip to prevent | [`benchmark/RESULTS-V108.md`](benchmark/RESULTS-V108.md) |
| Cut time, live, 128k | pi-tuck median 0.081 s (46 cuts; 90th percentile 0.279 s). Pi's compaction median 235.3 s (48 cuts; 90th percentile 403.8 s). Context carried after a cut, median: 26,790 tokens (pi-tuck), 27,750 (Pi's compaction) | pi-tuck 1.0.1, Pi 1.4.0, SWE-bench Verified, 10 chains of 30 tasks, window 128,000, reply reserve 32,768, `mac-studio/main:xhigh` writing Pi's summaries. The built-in time depends on that model and on server load. pi-tuck's time is an upper bound, read from the session file: the time between the entry written just before the cut and the compaction entry, so it includes anything between the last message and the cut (pi-tuck's tool-loop cuts emit no compaction events). The 44 failed compaction attempts in chain s09-A have no compaction entry and are not in the counts | [`benchmark/RESULTS-MAIN.md`](benchmark/RESULTS-MAIN.md) test 3 |
| Cut time, paired replay, 128k | pi-tuck median 0.061 s (95 cuts). Pi's compaction prompts on mac-studio/main:xhigh 154.6 s (86 cuts). Pi's compaction prompts on GPT-6.1 Terra 53.2 s (87 cuts, 19 recordings). Context carried after a cut, median: 27,656, 25,790 and 22,784 tokens; median summary 85,561, 23,598 and 11,200 characters | The same recorded sessions cut at the same raw positions. pi-tuck 1.0.1. Terra's cuts ran through Codex, not on the local server | [`benchmark/RESULTS-MAIN.md`](benchmark/RESULTS-MAIN.md) test 3 |
| Retention, 128k, test 1a: pi-tuck with its recall tools against Pi's compaction prompts on mac-studio/main:xhigh | Registered claim: not more than 3 points below, on these probes (cuts 1 to 4 only) (supported). Accuracy on the probes each was asked: 89.7% (783 probes) and 61.8% (1,677). Difference over the 783 shared probes, which come from the 43 of pi-tuck's 95 answer sets that did not abort: +25.7 points, one-sided 95% lower bound +22.0 (+22.3 clustered by chain). By probe type, pi-tuck / comparator: error class 80.2 / 24.7, files changed 84.5 / 78.9, result-line rule 100.0 / 100.0, required tag 100.0 / 99.3, test-runner summary 90.1 / 31.6 | pi-tuck 1.0.1, 20 recordings, mechanical probes only, evidence at least 35,000 raw tokens before the cut. pi-tuck answered with its recall tools and the comparators with none, from the summary and the kept recent messages. Every one of the 43 asks behind the 783 probes made recall calls (1.25 per probe on average), so no pi-tuck answer lacked the tools; the run cannot show how much of the result comes from the summary and how much from recall. No pi-tuck arm without recall tools exists. The comparators' agents had unrestricted bash, and the logs cannot rule out that one read a recording; nothing shows it. pi-tuck's accuracy does not rise with more calls per probe (87.9%, 90.8%, 90.0% by thirds; post hoc, descriptive). The 783 shared probes are fewer than the 2,969 needed to certify a difference near the margin | [`benchmark/RESULTS-MAIN.md`](benchmark/RESULTS-MAIN.md) test 1a |
| Retention, 128k, test 1b-Terra: pi-tuck with its recall tools against Pi's compaction prompts on GPT-6.1 Terra | Registered claim: not more than 3 points below, on these probes (cuts 1 to 4 only) (supported). Accuracy on the probes each was asked: 89.7% (783) and 57.8% (1,685). Difference over the 728 shared probes, from the same 43 of pi-tuck's 95 answer sets: +33.7 points, one-sided 95% lower bound +30.4 (+30.1 clustered by chain). By probe type, pi-tuck / Terra: error class 80.2 / 14.7, files changed 84.5 / 72.3, result-line rule 100.0 / 100.0, required tag 100.0 / 93.3, test-runner summary 90.1 / 38.1 | As test 1a, on 19 of the 20 recordings: s09-A is missing because its Terra cut job hit a Codex usage limit, and the set was closed at 19 before any Terra result was read. The claim is non-inferiority. The same limits as test 1a apply | [`benchmark/RESULTS-MAIN.md`](benchmark/RESULTS-MAIN.md) test 1b-Terra |
| Tasks resolved, 128k, test 2 | Pi's compaction 251 of 300, pi-tuck 258 of 300. Registered claim: no loss larger than 0.4 points. All 10 chains: +2.3 points, lower bound +0.3. Without chain s09: +1.5 points, lower bound −0.4 | pi-tuck 1.0.1, 10 chains of 30 tasks, paired by task, bootstrap over chains. In s09-A Pi's compaction failed 44 times ("generation hit the token cap") from task 23 on, and no other chain has a failed compaction; that is why the bound changes without s09 | [`benchmark/RESULTS-MAIN.md`](benchmark/RESULTS-MAIN.md) test 2 |
| Tokens per session, input plus output without cache reads, 128k | 241,000 fewer for pi-tuck per session on average, one-sided 95% upper bound −21,000, with all 10 chains. Without chain s09 the mean is −174,000 and the upper bound +43,000 | pi-tuck 1.0.1, paired by chain, bootstrap over sessions. The line holds only with all chains | [`benchmark/RESULTS-MAIN.md`](benchmark/RESULTS-MAIN.md) test 3 |
| Answers after cutting at 60% instead of 100% | No more losses than the limit on all 4 sets. Losses / wins over n questions: 128k shared 3 / 7 of 99; 128k asymmetric 3 / 1 of 67; 32k shared 5 / 3 of 77; 32k asymmetric 9 / 5 of 343. In the 32k asymmetric set the losses lean against 60% (test_result 4 / 2, error_hit 3 / 1); it is the set to watch | Paired replay, same 5 sessions, DeepSeek flash as agent and judge. Limit, set in advance: losses minus wins at most max(2, 5% of n). Asymmetric = evidence the base keeps native and the variant has summarised | [`rnd/replay32/RESULT-lean.md`](rnd/replay32/RESULT-lean.md) |
| 1.0.2 changes (plain-text summary, shrinking dialogue view, time on user turns only) against 1.0.1 | No more losses than the limit on all 4 sets. Losses / wins: 128k 1 / 2 of 128; 128k time questions 0 / 0 of 48; 32k 4 / 2 of 127; 32k asymmetric 0 / 2 of 56 | Paired replay, 5 recorded live sessions, DeepSeek flash as agent and judge. 11 of 146 answer sessions hit a 15-minute wall limit and drop out of the pairing | [`rnd/replay32/RESULT-lean.md`](rnd/replay32/RESULT-lean.md), [`CHANGELOG.md`](CHANGELOG.md) |
| Summary size, plain-text format against the 1.0.1 JSON format | About 30% shorter where the agent writes little, about 14% shorter where it writes a lot | Same dialogue | [`CHANGELOG.md`](CHANGELOG.md) 1.0.2 |
| Small-window fix | A session that writes little prose cut 174 times in 300 tool rounds at 32k with a 16k reserve (1.0.1 code). With the fix, a test pins that no cut frees under a tenth of the room | Real planner on synthetic sessions | [`CHANGELOG.md`](CHANGELOG.md) 1.0.2 (the 174 cuts); [`test/cut-yield.test.ts`](test/cut-yield.test.ts), which pins that every cut frees at least a tenth of the room |
| Stall fix: a long session's cut | A cut at 3,888 entries took 72 s in 1.0.0 and takes 174 ms since 1.0.1. Since 1.0.1 the cost grows linearly with the session | One machine, the same synthetic session for both numbers (little prose, 128k window, reserve 16,384, turn 644) | [`CHANGELOG.md`](CHANGELOG.md) 1.0.1 |

Notes:

- The answer replays use one cheap hosted model (DeepSeek flash) as agent and judge. They compare pi-tuck with other pi-tuck settings and versions. They do not compare pi-tuck with an LLM compactor.
- The 128k rows measure pi-tuck 1.0.1. The newer versions are listed in the [changelog](CHANGELOG.md). A cut still calls no model, but the 128k run has not been repeated on them.
- Everything here is from SWE-bench-style tasks on a small set of models. It may not carry to your work.

## Settings

pi-tuck needs none. Two are optional. Put them in `pi-tuck.json` in Pi's agent folder (`~/.pi/agent`, or the folder `PI_CODING_AGENT_DIR` names):

```json
{ "cutAt": 0.6, "semanticRecall": true }
```

- **`cutAt`** (above 0, at most 1; default 0.6) is the part of the input room a request may fill before pi-tuck cuts. At 0.6, each cut leaves room to grow. `{ "cutAt": 1 }` cuts at the full room. A lower value cuts earlier and smaller. The whole room still decides which request pi-tuck refuses.
- **`semanticRecall`** (`false` turns semantic search off, on Apple silicon). Nothing is then downloaded, and `tuck_search` uses keywords only.

A bad file is reported at session start, and pi-tuck uses the defaults.

### Small windows

pi-tuck keeps room for the model's reply: the larger of the model's output limit and Pi's `compaction.reserveTokens` (default 16,384). It refuses a request that cannot fit, rather than let the provider cut it off. It estimates the request's size, and it scales that estimate by the worst gap it has seen between its count and the provider's. In a small window, an upstream that spends far more context on tool schemas (some OpenRouter upstreams do) can leave too little room. pi-tuck then refuses to cut rather than overflow. Lower the reserve for that model in Pi's `settings.json`, or use a larger window. For example, to lower it to 8,192:

```json
{ "compaction": { "modelOverrides": { "my-provider/my-model": { "reserveTokens": 8192 } } } }
```

The reserve is the larger of `reserveTokens` and the model's `maxTokens`, so lowering `reserveTokens` alone does nothing when `models.json` sets a larger `maxTokens` for that model. Lower both, and keep `maxTokens` above your largest expected reply.

If you reach the model through OpenRouter, you can also pin one upstream, so that every request is served by the same one. Put this in `models.json` in Pi's agent folder, and name the upstream you want:

```json
{ "providers": { "openrouter": { "compat": { "openRouterRouting": { "only": ["your-upstream"], "allow_fallbacks": false } } } } }
```

## Semantic search

Semantic search is on by default on macOS with Apple silicon. It runs entirely on your Mac: an embedding model, [EmbeddingGemma-2](https://huggingface.co/google/embeddinggemma-2), served by [llama.cpp](https://github.com/ggml-org/llama.cpp) on your Mac's GPU (Metal). No text leaves your machine. Elsewhere (Linux, Intel Macs) there is no `tuck_search`, and nothing is downloaded; compaction and `tuck_recall` work. On a Mac where Metal fails to start, semantic recall goes off with the reason "Semantic recall needs Metal; word recall still works".

The first time a session starts, pi-tuck downloads what it needs, once, about 390 MB, in the background. Keyword search works meanwhile:

| File | From |
|---|---|
| EmbeddingGemma-2, 8-bit GGUF (310 MB) and its tokenizer (32 MB) | huggingface.co |
| llama.cpp release b11476 for macOS arm64 (12 MB) | github.com/ggml-org/llama.cpp |
| CPython 3.13 (25 MB) and 16 Python packages for the tokenizer (9 MB) | github.com/astral-sh/python-build-standalone, pypi.org |

Every file is pinned to a SHA-256 in [src/assets.ts](src/assets.ts) and checked before use. Everything goes to `~/.pi/agent/pi-tuck`; to remove it, delete that folder. Setup needs about 6.5 GB of free disk space while it runs, and uses 460 MB after. If it fails, for example offline, pi-tuck says so and tries again at the next session start. One-shot runs (`pi -p`) do not start the setup.

Indexing starts in the background the first time a session uses `tuck_search`, and catches up after each compaction. Semantic search is off when Pi runs in a folder that contains Pi's agent folder, such as your home folder, because its own files live there. Open Pi in a project folder.

## Use from code

The package also exports its parts for hosts that embed Pi through its SDK:

```ts
import { installCompaction, createSemanticRecall, ensureSemanticRuntime } from "pi-tuck";

const config = JSON.parse(readFileSync(await ensureSemanticRuntime("/abs/path/outside/projects"), "utf8"));
const semanticRecall = createSemanticRecall(config);
const handle = await installCompaction(pi, { semanticRecall });
await handle.setSemanticEnabled(true, ctx); // e.g. in a session_start handler
```

`installCompaction` options (reply reserve, host-injected messages, recall policy, `cutAt` and others) are documented in [src/compaction.ts](src/compaction.ts). `handle.close()` stops the semantic worker; call it before disposing a session.

## Development

```sh
npm install
npm run check   # types
npm test        # unit tests (Vitest) and the Python runtime tests
npm run build   # dist/ for the library export
```

Changes are listed in [CHANGELOG.md](CHANGELOG.md). Releases are published from GitHub Actions by npm trusted publishing, with provenance.

## Credits

pi-tuck grew out of [pi-vcc](https://github.com/sting8k/pi-vcc) by sting8k and includes code from [pi-blackhole](https://github.com/k0valik/pi-blackhole) by k0valik and from [Pi](https://github.com/earendil-works/pi) by Mario Zechner, all MIT; their notices are in [LICENSE](LICENSE). The downloaded model is Apache-2.0, llama.cpp is MIT, and CPython is under the PSF license.

## License

MIT
