#!/bin/sh
# The 1.0.10 candidate gate (PREREG-V110.md): arms P (v1.0.9, cd4626b) and Q (a67ec30) on t01 and t02 at once, four sessions in all.
# The trim loop (returns deleted task images to the host) is started once the driver exists, and ends with it.
cd "$(dirname "$0")/.." || exit 1
runs/.venv/bin/python harness/run_live_all.py --suite w32 --tuck runs/tuck-base109 --pairs 2 --arms PQ --sessions t01,t02 \
  --tuck-arm P=runs/tuck-base109 --tuck-arm Q=runs/tuck-v110c &
driver=$!
sleep 5
harness/trim_loop.sh >/dev/null 2>&1 &
wait $driver
