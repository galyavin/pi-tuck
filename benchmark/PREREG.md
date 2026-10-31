# Pre-registration: does pi-tuck compact as well as an LLM, faster and cheaper?

Frozen before any main run (git history shows when). Later changes go in `DEVIATIONS.md`, never here. The 3-recording pilot shaped the design and counts toward no claim. A test that fails is reported as failed. Versions: `PINS.md`.

## Systems
pi-tuck 1.0.1 (commit `d71234a`), semantic search on; "semantic off" is secondary. LLM compactors: Pi's own summarize and update-the-previous-summary prompts (keepRecent 20,000), run on **local** `mac-studio/main:xhigh` (what live arm A ships) and **frontier** `openai/gpt-6-astra:high` (plan-billed; no per-token API anywhere). Window 128,000, reply reserve 32,768.

## Data
- **Live**: 10 chains of 30 SWE-bench Verified tasks (seed 20261030, `data/sessions.json`; instances with a native arm64 image, estimated under 1 hour), one Pi session per chain on `mac-studio/main:xhigh`, 300 tasks per arm. A = Pi's compaction, B = pi-tuck; same model entry, settings, tools, prompts, isolated agent folders. Official grading. A task over 30 minutes or 120 turns is unresolved. A chain leaves tests 2 and 3 only if infrastructure fails in either arm, and then in both.
- **Replay**: the 20 recordings. Every compactor cuts at the same raw positions (first where the request reaches the cut band, then every 50,000 raw tokens, at tool-round boundaries); a later cut updates that compactor's own summary.
- **Probes** after each cut, on facts whose evidence is at least 35,000 raw tokens before the cut (dropped for a compactor that kept it anyway): up to 5 each of files changed in a named task, last test-runner summary of a named task, tag the user required for a named task, last exception class in a named task; the session's result-line rule; one "next step" scored by a `mac-studio/main:xhigh` judge against what the agent did next. Other answers are computed from the recording. Agents answer with their tools (pi-tuck keeps `tuck_recall` and `tuck_search`).
- **Agents**: primary `mac-studio/main:xhigh`; secondary `openai/gpt-6-astra:medium`. The frontier compactor and agent run on a ChatGPT plan with a cap too small for the full design, so they run as a throttled queue in recording-name order and cover a prefix.

## Test 1: retention (decides the claim)
D = accuracy(pi-tuck) minus accuracy(comparator) in points over shared probes, equal weight per probe, comparator = the better LLM compactor on those probes. One-sided 95% lower bound, bootstrap over recordings (10,000 draws, seed 1).
- 1a: primary agent, all 20 recordings, vs the local compactor.
- 1b: primary agent, vs the frontier compactor, on the recordings it completed.
- 1c: secondary agent, vs the better compactor, on the recordings it completed.

**Supported** only if 1a's lower bound exceeds -3 points, and 1b's does, and 1c's does when it has 10 or more recordings. With fewer than 10 recordings for 1b, the claim is stated against the local compactor only and the frontier comparison is reported as untested. A positive point estimate with a lower bound at or below -3 is "not supported". Also reported: by probe type, cut number and age, mechanical probes alone, semantic-off, and the probe count a 3-point bound needs.

## Test 2: end to end (reports a bound)
Resolved rate B minus A, paired by task, with the one-sided 95% lower bound (bootstrap over chains). We claim only "no loss larger than that bound".

## Test 3: speed and cost
(a) Median latency per cut: replay, each compactor; live, B vs A. (b) Tokens per session, B vs A, paired by chain: Pi's session total (input, output, cache, summarization included) and, separately, input plus output without cache reads. Supported if the mean paired difference and its one-sided 95% upper bound are below zero. (c) Context carried after each cut, informational.

## Not claimed
Anything beyond fixed-size SWE-bench-style tasks on one local model; `activeInputTokens` lean cuts (later follow-up); a cold semantic index (replay warms it with one search first, as a session that has already searched would).
