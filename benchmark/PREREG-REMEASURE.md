# Re-measure of retention on pi-tuck 1.0.11: every cut, Pi's compaction on, every answer set counted

Registered 2026-11-06 before any run of it. It replaces nothing: tests 1a and 1b-Terra stand as registered, for the answer sets that finished at cuts 1 to 4 (`RESULTS-MAIN.md`, section "Answer sets lost to aborts in the recall arms"). No retention claim is made for pi-tuck past cut 4 until this test reports.

## Question

With Pi's compaction on, as in a live session, does pi-tuck 1.0.11 keep what the agent needs at every cut, 1 to 8, compared with Pi's compaction prompts on `mac-studio/main:xhigh` and on GPT-6.1 Terra, and how many answer sets still end in an abort?

## Build, cuts, setup

- **Build**: pi-tuck 1.0.11, commit `b231800` (tag `v1.0.11`), exported to `runs/tuck-1.0.11`.
- **Cuts**: regenerated on that build by `replay/cuts.ts --variants tuck --tuck-dir runs/tuck-1.0.11` for all 20 recordings, at the same raw positions as the main replay: 95 cuts, no model call. Their summaries differ from the main replay's (the build writes the transcript in format 2; the median carried context is 26,185 tokens against 27,656), and 7 of the 95 cuts keep a different tail. The hash of the 20 cuts files is `5eb84cf6925eeb14` (SHA-256 of the sorted per-file SHA-256 list), taken before any answer run. The comparators' cuts and answers are the main replay's, unchanged.
- **Arms**: `tuck` (recall tools including meaning search, with the same warm start as the main replay) and `tuck-lexical` (meaning search off). The 95 answer sets of each arm: one agent session per cut, all probes of that cut in one prompt.
- **Setup**: `replay/abortcheck.ts` (the main replay's answer script plus observers only), `mac-studio/main:xhigh`, window 128,000, reserve 32,768, Pi's compaction **on** (`reserveTokens` 32,768, `keepRecentTokens` 20,000), the same frozen probes and prompt and retry settings, the extension's refusal reason recorded. **Wall: 60 minutes per set** (the main replay's was 15; a long first request under load made two of three compaction-on sets of an earlier check hit it).
- **Order**: cuts 5 to 8 first, then 4 to 1, so that the part the main replay could not read comes first. Lanes: up to 8 `mac-studio/main` lanes while the window allows, at most 2 sets with meaning search at once (the encoder runs on the machine), then 3 lanes after the window; a stop at any moment loses only the sets in flight, which rerun.
- **Comparators**: their existing answers, made under a 15-minute wall (0 of 95 and 1 of 87 sets ended in an error). Nothing is rerun.

## Reporting of every set (never merged)

Each set is **answered**, **aborted early** (an error before the wall, with the extension's refusal text) or **wall-bound** (60 minutes). Also reported: the answered sets that took longer than 15 minutes; requests, tool results, times the context fell by more than 5,000 tokens, peak input tokens and summed tokens per set; the server load every 60 s (my runs and the open connections to the server) and the seconds per request in every record; the lanes used at the start. A wall-bound set is rerun once, with at most 2 lanes in use, with the same wall; its first record is kept, and it is lost only if it hits the wall again.

## Scoring and bar

- Scoring and pairing are the main replay's own (`replay/score.ts`, `analysis/replay_stats.py`): a probe counts only if the compactor did not keep its evidence in the tail it left; D = accuracy of pi-tuck minus accuracy of the comparator over the probes both were asked, equal weight per probe; one-sided 95% lower bound by bootstrap over recordings (10,000 draws, seed 1), with the chain-clustered bound beside it. The judged next-step probes are scored but not in D.
- **Primary reading: every answer set counts.** A lost set (aborted early, or wall-bound after its rerun) has all its probes scored as wrong. **Retention at every cut is supported against a comparator only if this lower bound of D is above −3 points**, for `tuck` (the SUT) against each of Pi's compaction prompts on `mac-studio/main:xhigh` (20 recordings) and on GPT-6.1 Terra (19 recordings, the set closed by the 1b-Terra decision).
- Reported beside it, with no pass line: D with lost sets dropped (the main replay's rule); the same for `tuck-lexical`; D by cut and by probe type; lost sets by arm, cut and ending; probes needed for a 3-point bound.
- Power: about 1,500 shared probes per comparator (the 1,961 frozen probes less those whose evidence the tail keeps); the test is not powered to certify a difference near the margin, only to clear a bound near zero.

## Not claimed

Only against the two comparators named, on this model, these recordings and this window; never "the best LLM compactors"; nothing about any other build; not a live-session rate of aborts (these are replays of recorded sessions with Pi's compaction on). A first, exploratory look at the 20 answer sets at cuts 5 to 8 on pi-tuck `v1.0.10` with the main replay's cuts happened before this registration; it is a diagnostic, its result is in a local note, and it is not part of this test.
