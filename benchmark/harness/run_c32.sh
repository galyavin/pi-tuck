#!/bin/sh
# Arm C (B′, PREREG-32K.md addendum) on t01-t05. t01 and t02 are finished chains for A, B and M, so they run at once; t03-t05 wait until the
# first-batch driver has left them, so that no chain has its images pruned under it.
cd "$(dirname "$0")/.." || exit 1
PY=runs/.venv/bin/python
$PY harness/run_live_all.py --suite w32 --tuck runs/tuck-0fd4b92 --pairs 1 --arms C --sessions t01,t02
while pgrep -f "run_live_all.py --suite w32 --tuck runs/tuck-1.0.3" >/dev/null; do sleep 60; done
$PY harness/run_live_all.py --suite w32 --tuck runs/tuck-0fd4b92 --pairs 1 --arms C --sessions t03,t04,t05
