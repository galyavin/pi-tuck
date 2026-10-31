# PREREG addendum: LongMemEval-S at 32k and 64k windows

Written 2026-10-31, before any result and before the data is downloaded (`BACKLOG.md`, item 3). `PREREG.md` is unchanged. Code, when written: `lme/`.

**Why.** LongMemEval (ICLR 2025) asks a chat assistant questions about facts spread over a long history of conversations. It is a public benchmark readers know, it needs no containers, and its `S` set carries about 115,000 tokens of history per question, so compaction fires at a small window: about seven cuts at a 16,384-token room, about one at 128k. It is also where search by meaning should show or not show an advantage.

## Set-up

- **Data.** `longmemeval_s_cleaned.json` (277 MB, MIT per its Hugging Face card, `xiaowu0162/longmemeval-cleaned`): 500 questions in six types, 30 of them abstention questions. **Subset:** 100 questions, stratified by type in proportion (about 6 abstention), seed 20261031, same 100 for every arm and window. Source of this pick: the eval lead (cost; 100 questions at the arms below fit the $25 line).
- **Session.** For each question the haystack sessions are loaded in date order as one Pi session of plain user and assistant messages (no tools), each session opening with its date. The question, with its question date, is asked as the next user message after the last session.
- **Windows**, both with a 16,384 reply reserve for every arm, as in the 32k suite: **32k** (window 32,768, room 16,384, `keepRecentTokens` 3,333) and **64k** (window 65,536, room 49,152, `keepRecentTokens` 10,000; the same 20% share of the room as the end-to-end suites). Cuts at message boundaries (an assistant message followed by a user message), the first where the request reaches the cut band, then every half room of new raw history, the same for every compactor; the question is asked in the state after the last cut.
- **Arms**, at the same cuts: `tuck` (summary, `tuck_recall` and `tuck_search`, meaning search on), `tuck-lexical` (meaning search off), `tuck-norecall` (same summary, both tools removed), `native` (Pi's built-in summary), and `full` (no compaction, the whole history in a 1M window: the ceiling). pi-tuck at both builds, 1.0.1 (`d71234a`) and 1.0.3 (`656f77a`), each reported on its own.
- **Models.** Agent, Pi's summary writer and judge: `openrouter/deepseek/deepseek-v4.1-flash-1017` (the dated snapshot, pinned to the one upstream DigitalOcean with no fallback, as in `PREREG-32K.md`; the first start of this measurement used the moving alias, was stopped and set aside before any result was read) (agent and summary writer thinking `high`, judge `medium`); per-token, approved by the user as the fallback. Spend line: $25 cumulative, then stop and ask the CEO (eval lead's pick).
- **Grading.** The official LongMemEval judge prompts per question type (single-session, temporal reasoning with the off-by-one rule, knowledge update, preference rubric, abstention), with `yes` in the reply read as correct, **but with the DeepSeek judge instead of GPT-4o**. This is a deviation from the benchmark's published setup; it is reported with the numbers, and 40 answers are re-judged by a second judge (the ChatGPT-plan model, as quota allows) and the agreement reported. Numbers are therefore comparable across our arms, not to the leaderboard.

## Readouts, bounds only

Per window and build: accuracy by arm and by question type; paired differences by question (`tuck` minus `native`, `tuck` minus `tuck-lexical`, `tuck-lexical` minus `tuck-norecall`, each arm minus `full`), one-sided 95% lower bounds from a bootstrap over questions (10,000 draws, seed 1). Each question has its own history, so questions are independent clusters. Statements follow the same form as `PREREG-RECALL.md`: search by meaning is called a differentiator only if the `tuck` minus `tuck-lexical` lower bound is above 0 at a window; the comparison with Pi's summary uses the -3 point margin of `PREREG.md`.

## Not claimed

Not a leaderboard entry: different judge, a 100-question subset, a small-window harness. Nothing about other windows or models.
