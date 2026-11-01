#!/bin/sh
# Redo all three arms of chain t04 (A, B and M each died at a grading timeout, DEVIATIONS 16:27 and the entry after 17:57) once the first-batch driver has finished t05.
cd "$(dirname "$0")/.." || exit 1
while pgrep -f "run_live_all.py --suite w32 --tuck runs/tuck-1.0.3 --pairs 1 --arms ABM" >/dev/null; do sleep 5; done
mkdir -p runs/live32-died && for arm in A B M; do mv runs/live32/t04-$arm runs/live32/t04-$arm.out runs/live32-died/ 2>/dev/null; done
runs/.venv/bin/python harness/run_live_all.py --suite w32 --tuck runs/tuck-1.0.3 --pairs 1 --arms ABM --sessions t04
