# PREREG addendum: independent questions and recall by meaning

Written 2026-10-31, before any answer of this measurement exists (`BACKLOG.md`, item 2). `PREREG.md` is unchanged. Code: `recall/`.

**Two things this checks.** (1) The main retention probes are mechanical facts (files changed, last test result, a tag, an error class) chosen by us; a reader can fairly ask whether they suit pi-tuck. Here a model that has seen neither compactor writes the questions. (2) The README calls search by meaning (`tuck_search`) a differentiator and has no numbers. Here each question comes in a wording close to the source's and a paraphrase that shares none of its distinctive terms, so keyword recall has nothing to match on.

## Set-up

- **Recordings and cuts.** The six recordings `s01`-`s03` (both arms), at the cuts the main replay already made (same raw positions for every compactor). Evidence must lie at least 35,000 raw tokens before the cut, as in the main retention test. Source of this pick: the eval lead (these are the recordings every summarizer covers).
- **Questions.** For each cut, two tasks drawn at random (seeded by recording and cut) from the tasks that end before that evidence limit. A writer reads one task's transcript (tool output clipped) and writes five candidate questions, each with: a `close` wording, a `paraphrase` wording, a reference answer of at most 25 words, and the transcript entries it rests on. Kinds asked for: a decision and its reason, a value or result seen, a cause found, an approach tried and dropped, where something is.
- **Mechanical wording checks.** A *distinctive term* of the cited entries is a token of 6 or more characters that contains `_`, `.`, `/`, a digit or an interior capital letter, or a number of 4 or more digits. A `paraphrase` must contain none of them; a `close` must contain at least two. A candidate failing either check is dropped.
- **Validation.** A second call sees only the cited entries and the `close` question and answers; the judge must score it correct against the reference, else the candidate is dropped. At most three questions per task survive, in the writer's order: up to six per cut, each asked in both wordings.
- **Models.** Writer, validator, judge and answering agent: `openrouter/deepseek/deepseek-v4.1-flash-1017` (the dated snapshot, pinned to the one upstream DigitalOcean with no fallback, as in `PREREG-32K.md`; the first start of this measurement used the moving alias, was stopped and set aside before any result was read) (writer and agent thinking `high`, validator and judge `medium`); per-token, no load on the local server. The judge sees the question, the reference and the answer, never the compactor. Source of this pick: the CEO's allowance for DeepSeek flash.
- **Answering.** As in the main retention test: a real Pi session over the replayed state after the cut, with the compactor's real tools, one prompt with all of a cut's questions. `close` and `paraphrase` go in **separate sessions**, so one cannot help answer the other.
- **Arms**, all at the same cuts: `tuck` (summary, `tuck_recall` and `tuck_search` with meaning search on), `tuck-lexical` (same, meaning search off), `tuck-norecall` (same summary, both tools removed), `native-local` (Pi's built-in summary written by `mac-studio/main`, no recall tool). pi-tuck is run at both builds, 1.0.1 (`d71234a`, the main run) and 1.0.3 (`656f77a`, the shipped build), each reported on its own; `native-local` is shared.
- **Dropped per arm:** a question whose cited entries the arm kept in its tail after the cut, as in the main test.
- **Spend line:** if the cumulative cost passes $25, stop and ask the CEO (eval lead's pick).

## Readouts, bounds only, no pass threshold except where stated

For each build and each wording: accuracy per arm, and paired differences by question with a one-sided 95% lower bound from a bootstrap (10,000 draws, seed 1) clustered **by recording** and, as a second view, **by cut**. With six recordings the first is coarse; a statement below is made only if the lower bound clears its threshold under **both** clusterings.

1. **Search by meaning:** `tuck` minus `tuck-lexical`, on `paraphrase`, and on `close`; and the difference between the two (paraphrase gain minus close gain). The README may call search by meaning a differentiator only if the paraphrase lower bound is above 0 and the paraphrase gain is larger than the close gain. Otherwise the README's wording is tempered to what was measured.
2. **Keyword recall:** `tuck-lexical` minus `tuck-norecall`, both wordings.
3. **Against Pi's built-in summary on questions we did not write:** `tuck` minus `native-local`, both wordings. The main retention margin applies: supported if the lower bound is above -3 points.
4. **By question kind**, descriptive only.

## Not claimed

Nothing about other models, other task types or longer sessions. A questions-and-judge pipeline by one model family can carry that family's habits; the question set, answers and judge verdicts are published so they can be audited, and a sample of 30 questions is read by hand and the verdict reported with the results.
