# Main-run tables (`RESULTS-MAIN.md`)

Exported by `analysis/export_csv.py runs/live runs/replay data/main-run --exclude-variant=native-terra --exclude-variant=native-frontier`. The raw session files and events stay outside git.

- `live_tasks.csv`: one row per task of the 20 live sessions (10 chains, arms A = Pi's compaction and B = pi-tuck): resolved, empty patch, seconds, turns, requests, tokens, cap that ended the task, tag followed.
- `live_cuts.csv`: one row per cut in the session files; `seconds_upper_bound` is the time from the entry before the cut to the compaction entry.
- `replay_scores.csv`: one row per scored probe for `tuck`, `tuck-lexical` (semantic search off) and `native-local` ("Pi's compaction prompts on mac-studio/main:xhigh"), over the 20 recordings.
- `replay_cuts.csv`: one row per replay cut for the same variants.

**Left out until test 1b-Terra is final:** every row of `native-terra` ("Pi's compaction prompts on GPT-6.1 Terra") and of `native-frontier` (the withdrawn comparator's partial view). They are added, with the 1b-Terra result, when its recording set is final.
