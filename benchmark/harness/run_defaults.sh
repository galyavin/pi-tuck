#!/bin/sh
# The Pi-defaults check (PREREG-DEFAULTS.md): one pi-tuck arm on mac-studio/main, one session per chain. Usage: [ARM=K TUCK=runs/tuck-v108] run_defaults.sh t06 [t07]
# (arm K = 1.0.8; arm N = the 1.0.10 candidate, TUCK=runs/tuck-v110c.) Each chain holds one mac-studio lane; at most 3 lanes were in use across all workers at the time of these runs.
# The trim loop (returns deleted task images to the host) starts once the driver exists, and ends with it.
cd "$(dirname "$0")/.." || exit 1
ARM=${ARM:-K}; TUCK=${TUCK:-runs/tuck-v108}
sessions=$(echo "$@" | tr ' ' ',')
runs/.venv/bin/python harness/run_live_all.py --suite w32m --tuck "$TUCK" --pairs 2 --arms "$ARM" --sessions "$sessions" --tuck-arm "$ARM=$TUCK" &
driver=$!
sleep 5
harness/trim_loop.sh >/dev/null 2>&1 &
wait $driver
