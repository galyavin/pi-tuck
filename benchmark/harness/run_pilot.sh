#!/bin/sh
# The thinking-level pilot (PREREG-PILOT.md): arm S (medium) and arm U (xhigh), pi-tuck 1.0.11 (runs/tuck-v111), chain p01, no wall cap, 3,600 s stall guard.
# Both arms run with the same thinking flag per session, so the two thinking levels run as two drivers started together.
cd "$(dirname "$0")/.." || exit 1
runs/.venv/bin/python harness/run_live_all.py --suite w32g --tuck runs/tuck-v111 --pairs 1 --arms S --sessions p01 --tuck-arm S=runs/tuck-v111 --wall-seconds 0 --stall-seconds 3600 --thinking medium &
d1=$!
runs/.venv/bin/python harness/run_live_all.py --suite w32g --tuck runs/tuck-v111 --pairs 1 --arms U --sessions p01 --tuck-arm U=runs/tuck-v111 --wall-seconds 0 --stall-seconds 3600 --thinking xhigh &
d2=$!
sleep 5
harness/trim_loop.sh >/dev/null 2>&1 &
wait $d1 $d2
