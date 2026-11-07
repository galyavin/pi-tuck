#!/bin/sh
# The live gate of the adaptive candidate (PREREG-ADAPTIVE.md): arm L = pi-tuck 1.0.11 (b231800), arm O = the adaptive candidate (21fa1a4), chains t06 to t10, suite w81 (window 81,920,
# reserve 16,384, Pi's default keepRecentTokens), mac-studio/main at xhigh, 120-turn cap, no wall cap, 3,600 s stall guard. Start it only on the new model setup, after the go-ahead.
# LANES mac-studio lanes (default 8; each chain of each arm holds one), so LANES/2 chains run at once. The model fingerprint at the start is saved; the 5-minute sampler
# (harness/model_fingerprint.py --every 300) runs beside it. SESSIONS picks the chains (default all five); two runs on different chains can overlap safely.
# Usage: LANES=8 harness/run_adaptive_gate.sh   (from anywhere)
cd "$(dirname "$0")/.." || exit 1
LANES=${LANES:-8}; PAIRS=$((LANES / 2)); [ "$PAIRS" -lt 1 ] && PAIRS=1
mkdir -p runs/live81
runs/.venv/bin/python harness/model_fingerprint.py --log runs/live81/model-fingerprint-at-start.log > /dev/null
runs/.venv/bin/python harness/run_live_all.py --suite w81 --tuck runs/tuck-1.0.11 --pairs "$PAIRS" --arms LO --sessions "${SESSIONS:-t06,t07,t08,t09,t10}" \
  --tuck-arm L=runs/tuck-1.0.11 --tuck-arm O=runs/tuck-adaptive-21fa1a4 --wall-seconds 0 --stall-seconds 3600 &
d=$!
sleep 5
harness/trim_loop.sh > /dev/null 2>&1 &
wait $d
