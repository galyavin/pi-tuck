#!/bin/sh
# The 1.0.8 candidate gate (PREREG-V108.md): arms F (v1.0.7, 387c575) and G (a2e7d1a) on t01 and t02 at once, four sessions in all.
# The trim loop (returns deleted task images to the host) is started once the driver exists, and ends with it.
cd "$(dirname "$0")/.." || exit 1
runs/.venv/bin/python harness/run_live_all.py --suite w32 --tuck runs/tuck-v107 --pairs 2 --arms FG --sessions t01,t02 \
  --tuck-arm F=runs/tuck-v107 --tuck-arm G=runs/tuck-a2e7d1a &
driver=$!
sleep 5
harness/trim_loop.sh >/dev/null 2>&1 &
wait $driver
