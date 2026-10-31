# Running another pi-tuck variant as a replay arm

For R&D experiments. Needs the main replay to be finished (recordings and probes exist). Do not edit `PREREG.md`; report such runs as exploratory.

Layout (all under `benchmark/runs/`, gitignored): `recordings/<chain>-<arm>.jsonl` are the 20 live sessions; `replay/<chain>-<arm>/` holds `probes.json`, `cuts-<variant>.json` (each cut's summary, latency, mode `dialogue|ranked`, `firstKeptIndex`), `answers-*.jsonl` and `scores-*.jsonl`.

Export your source folder (a `git archive` of the commit, plus `ln -s <repo>/node_modules node_modules`), then per recording, from `benchmark/`:

```sh
J=../node_modules/.bin/jiti; SRC=/abs/path/to/your/source; ARM=tuck-lean   # any name starting "tuck-"; do not end it "-lexical"
for REC in runs/recordings/*.jsonl; do
  D=runs/replay/$(basename $REC .jsonl)
  $J replay/cuts.ts   $REC $D --variants $ARM --tuck-dir $SRC
  A=$D/answers-mac-studio_main_xhigh-$ARM.jsonl
  $J replay/answer.ts $REC $D $D/probes.json $A --agent mac-studio/main:xhigh --variant $ARM --tuck-dir $SRC
  $J replay/score.ts  $D/probes.json $A ${A/answers/scores}
done
python3 analysis/replay_stats.py runs/replay --sut $ARM     # compares $ARM with the local and frontier LLM compactors
```

Notes: use at most 2 parallel streams (mac-studio answers 429 at about 8 total, and live runs share it). Compare against the baseline `tuck` rows, per view (`mode` in the cut log), since a smaller summary can keep the full dialogue where the baseline fell back to the ranked view. Add your own probes by writing a `probes.json` in the same schema (`id`, `cut`, `type`, `question`, `truth`, `evidenceIndex`); `score.ts` needs a mechanical rule per new `type`.
