#!/bin/sh
# Arm C on the build named by $1 (a directory under runs/): t01 and t02 at once, t03-t05 after the first-batch driver has left them.
cd "$(dirname "$0")/.." || exit 1
PY=runs/.venv/bin/python
$PY harness/run_live_all.py --suite w32 --tuck "$1" --pairs 1 --arms C --sessions t01,t02
while pgrep -f "run_live_all.py --suite w32 --tuck runs/tuck-1.0.3" >/dev/null; do sleep 60; done
$PY harness/run_live_all.py --suite w32 --tuck "$1" --pairs 1 --arms C --sessions t03,t04,t05
