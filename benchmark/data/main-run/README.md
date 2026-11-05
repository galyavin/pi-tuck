# Main-run tables (`RESULTS-MAIN.md`)

Exported by `analysis/export_csv.py runs/live runs/replay data/main-run --exclude-variant=native-frontier`. The raw session files and events stay outside git.

- `live_tasks.csv`: one row per task of the 20 live sessions (10 chains, arms A = Pi's compaction and B = pi-tuck): resolved, empty patch, seconds, turns, requests, tokens, cap that ended the task, tag followed.
- `live_cuts.csv`: one row per cut in the session files; `seconds_upper_bound` is the time from the entry before the cut to the compaction entry.
- `replay_scores.csv`: one row per scored probe for `tuck`, `tuck-lexical` (semantic search off) and `native-local` ("Pi's compaction prompts on mac-studio/main:xhigh"), over the 20 recordings, and `native-terra` over 19.
- `replay_cuts.csv`: one row per replay cut for the same variants.

**Included:** every row of `native-terra` ("Pi's compaction prompts on GPT-6.1 Terra"), over 19 recordings; s09-A has no Terra rows because its cut job was blocked by a usage cap (`DEVIATIONS.md`, 2026-11-05).

**Left out:** `native-frontier`, the withdrawn comparator's partial view (8 recordings, not a test).
