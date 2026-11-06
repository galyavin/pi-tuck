#!/bin/sh
# The cut-later test (PREREG-CUTLATER.md): arms H (1.0.8 base) and J (cut later) on t01-t05, two chains at once. Builds must be exported first:
# runs/tuck-v110c and runs/tuck-cutlater1010. The trim loop (returns deleted task images to the host) is started once the driver exists, and ends with it.
cd "$(dirname "$0")/.." || exit 1
runs/.venv/bin/python harness/run_live_all.py --suite w32 --tuck runs/tuck-v110c --pairs 2 --arms HJ --sessions t01,t02,t03,t04,t05 \
  --tuck-arm H=runs/tuck-v110c --tuck-arm J=runs/tuck-cutlater1010 &
driver=$!
sleep 5
harness/trim_loop.sh >/dev/null 2>&1 &
wait $driver
