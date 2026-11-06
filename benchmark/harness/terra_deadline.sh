#!/bin/sh
# The 24-hour rule for s09-A's Terra cut job (DEVIATIONS.md, 2026-11-05): if the job has not finished all 8 cuts by the deadline ($1, epoch seconds), stop the
# runner and the job and leave a marker; 1b-Terra is then final at 19 recordings. Exits early when the cuts file is complete.
cd "$(dirname "$0")/.." || exit 1
DEADLINE=$1; F=runs/replay/s09-A/cuts-native-terra.json
while :; do
  if [ -f "$F" ] && runs/.venv/bin/python -c "import json,sys; d=json.load(open('$F')); sys.exit(0 if len(d.get('cuts', [])) >= len(d.get('positions', [1])) and d.get('cuts') else 1)"; then echo COMPLETE; break; fi
  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    pkill -f "run_replay.py runs/recordings" ; pkill -f "replay/cuts.ts runs/recordings/s09-A.jsonl"
    date '+%Y-%m-%d %H:%M:%S %Z: s09-A Terra cut job stopped at its 24-hour limit; 1b-Terra is final at 19 recordings' > runs/replay/s09-A/TERRA-24H-EXPIRED
    echo EXPIRED; break
  fi
  sleep 60
done
date
