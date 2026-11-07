#!/bin/sh
# The live gate of the adaptive line (PREREG-ADAPTIVE.md): arm L = L_BUILD, arm O = O_BUILD (defaults: pi-tuck 1.0.12 `e8ffa4c` and the adaptive candidate `882f6f6`), suite w81 (window 81,920,
# reserve 16,384, Pi's default keepRecentTokens), mac-studio/main at xhigh, 120-turn cap, no wall cap, 3,600 s stall guard. Start it only after the gate's line is in PREREG-ADAPTIVE.md.
# Starts whole: 4 mac-studio lanes (LANES, default 4; each chain of each arm holds one), so 2 chains run at once and the rest of SESSIONS (default t06 to t10) follow as chains end.
# The model sha at the start is saved to runs/live81/model-fingerprint-at-start.log; harness/fingerprint_guard.sh then samples every 5 minutes into runs/live81/model-fingerprints.log and stops the gate
# if a sample carries another sha (a failed sample, such as a 503, does not count); harness/gate_load_sampler.sh logs the lanes and server connections every minute.
# Usage: harness/run_adaptive_gate.sh   (from anywhere; the model key must be in the environment, as for every live run)
cd "$(dirname "$0")/.." || exit 1
L_BUILD=${L_BUILD:-runs/tuck-1.0.12}; O_BUILD=${O_BUILD:-runs/tuck-adaptive-882f6f6}
LANES=${LANES:-4}; PAIRS=$((LANES / 2)); [ "$PAIRS" -lt 1 ] && PAIRS=1
mkdir -p runs/live81
F1=$(harness/fingerprint_guard.sh now runs/live81/model-fingerprint-at-start.log)
[ -n "$F1" ] || { echo "no model sha at the start (server error or no key in the environment): not starting" >&2; exit 1; }
runs/.venv/bin/python harness/run_live_all.py --suite w81 --tuck "$L_BUILD" --pairs "$PAIRS" --arms LO --sessions "${SESSIONS:-t06,t07,t08,t09,t10}" \
  --tuck-arm L="$L_BUILD" --tuck-arm O="$O_BUILD" --wall-seconds 0 --stall-seconds 3600 &
d=$!
sleep 5
harness/trim_loop.sh > /dev/null 2>&1 &
harness/gate_load_sampler.sh > /dev/null 2>&1 &
harness/fingerprint_guard.sh watch "$d" "$F1" > /dev/null 2>&1 &
wait $d
