#!/bin/sh
# Redo arm B of chain t04 (it died at a grading timeout, DEVIATIONS 16:30) once the first-batch driver has finished t05.
cd "$(dirname "$0")/.." || exit 1
while pgrep -f "run_live_all.py --suite w32 --tuck runs/tuck-1.0.3 --pairs 1 --arms ABM" >/dev/null; do sleep 5; done
mkdir -p runs/live32-died && mv runs/live32/t04-B runs/live32/t04-B.out runs/live32-died/ 2>/dev/null
runs/.venv/bin/python harness/run_live_all.py --suite w32 --tuck runs/tuck-1.0.3 --pairs 1 --arms B --sessions t04
