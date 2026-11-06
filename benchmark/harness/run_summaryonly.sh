#!/bin/bash
# The summary-only test (PREREG-SUMMARYONLY.md): pi-tuck 1.0.1 with tuck_recall and tuck_search not offered, on every main-run recording, one mac-studio lane. Resumable:
# a recording with a scores file is skipped. Usage: harness/run_summaryonly.sh   (from anywhere)
cd "$(dirname "$0")/.." || exit 1
J=../node_modules/.bin/jiti
for REC in runs/recordings/s*.jsonl; do
  D=runs/replay/$(basename "$REC" .jsonl)
  A=$D/answers-mac-studio_main_xhigh-tuck-norecall.jsonl
  S=$D/scores-mac-studio_main_xhigh-tuck-norecall.jsonl
  [ -f "$S" ] && continue
  rm -f "$A"
  $J replay/answer.ts "$REC" "$D" "$D/probes.json" "$A" --agent mac-studio/main:xhigh --variant tuck-norecall --tuck-dir runs/tuck-1.0.1 && $J replay/score.ts "$D/probes.json" "$A" "$S"
  echo "$(date +%H:%M:%S) $(basename "$REC" .jsonl) $([ -f "$S" ] && echo done || echo FAILED)"
done
