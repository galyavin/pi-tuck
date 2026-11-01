# PREREG addendum: the frontier comparator becomes GPT-6.1 Terra

Written 2026-10-31 17:59 CDT, before any result with this model exists and before any outcome of the withdrawn comparator's queue was read as a test. `PREREG.md` is unchanged and stays the frame; this addendum replaces one comparator in it.

## What happened
The project owner withdrew the frontier comparator model on 2026-10-31: the only model authorised in Codex is **GPT-6.1 Terra**, because the subscription is very limited and higher tiers (Sol and Astra) are not to be used. `PREREG.md` named `openai/gpt-6-astra:high` as the frontier compactor (test 1b) and `openai/gpt-6-astra:medium` as the secondary agent (test 1c). All astra jobs were stopped at 18:00 CDT (the one running job, s04-B frontier cuts at cut 5 of 7, was killed; scheduler slots for plan jobs set to 0).

## Consequences for the astra comparisons (decided by `PREREG.md`'s own rule)
- **1b against astra is reported as untested**: it completed 8 recordings (s01-A, s01-B, s02-A, s02-B, s03-A, s03-B, s04-A, s05-B), fewer than the 10 the rule needs. Those 8 recordings (cuts, answers, scores) are kept and shown as a **labelled partial view**, "astra, 8 recordings, model withdrawn, not a test", never pooled with Terra and never called a test result. The four astra cuts of s04-B (incomplete) are discarded.
- **1c is reported as not run.** No secondary-agent session ran on astra.

## What is added
- **A replacement compactor `native-terra`, named in every write-up exactly "Pi's compaction prompts on GPT-6.1 Terra"** (never "best-in-class", never "the frontier compactor"; Terra is a lower tier than the withdrawn model). Pi's own summarize and update-the-previous-summary prompts (`prepareCompaction` + `compact()`, keepRecent 20,000, window 128,000, reserve 32,768), model `openai/gpt-6.1-terra`, thinking `xhigh`, through Pi's ChatGPT-plan sign-in (Codex). Per-token API is not used.
- **Same design otherwise:** the same raw cut positions as every other compactor, the same frozen probes (`probes.json`), the same primary agent (`mac-studio/main:xhigh`), scoring and judge (local `mac-studio/main:xhigh`, no frontier model anywhere). Only the cut-writing model is new.
- **All 20 recordings, in recording-name order** (the registered queue order, covering a prefix if the cap stops it), one plan slot; a capped job retries every 10 minutes. The recordings of chains s09 and s10 join as those chains end.

## Test 1b-Terra (the registered 1b with the comparator named)
D = accuracy(pi-tuck) minus accuracy(Pi's compaction prompts on GPT-6.1 Terra) in points over the probes both were asked, equal weight per probe, one-sided 95% lower bound by bootstrap over recordings (10,000 draws, seed 1). **Supported** only if the lower bound exceeds -3 points **and** Terra completed 10 or more recordings; with fewer than 10 the Terra comparison is reported as untested. Claim 1's comparator stays "the better LLM compactor on those probes", now chosen among the local compactor and Terra; the claim is worded against whichever compactors actually ran and never as "at least as effective as the best LLM compactors". `analysis/replay_stats.py --llms native-terra,native-local` runs it; `--llms native-frontier,native-local --partial` prints the astra partial view, with no claim line.

## Power (stated before results)
From the spread of Test 1a's probes only (`analysis/power_1b.py`; SD of the per-recording mean difference 12.2 points, 14 recordings): at true parity the one-sided lower bound is a median -3.3 at 16 recordings and -3.0 at 20, and clears -3 in 40% and 50% of simulated studies; if pi-tuck is truly 2 points ahead, in 87% and 92%. A Terra comparison near parity is therefore reported as underpowered, not as a failure or a success.

## Amendment, 2026-10-31 18:10 CDT (project owner's decision, before any Terra result): limits and the model rule
Codex usage limits and their resets are managed by the project owner. The sections of this addendum on priority for the plan and on measuring and reporting the cap are withdrawn: no work holds off the plan for test 1b, and the cap and weekly limit are not reported. The Terra queue runs as registered (recording-name order, all 20 recordings, capped jobs retrying every 10 minutes) and covers whatever the plan allows; if it completes fewer than 10 recordings, the registered rule applies and the Terra comparison is untested. The one rule for every Codex or OpenAI model call in this project: `openai/gpt-6.1-terra`, never Sol, Astra or a -pro model. The 32k suite stays on DeepSeek as registered.

## Not claimed
Nothing about a higher-tier model, about Claude, or about any compactor that did not run. The registered 1b claim ("at least as effective as the best LLM compactors") cannot be made from this test.
