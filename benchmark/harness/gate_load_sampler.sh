#!/bin/bash
# Once a minute while the w81 gate runs: the lanes this gate holds and the connections the model server holds, from any client, into runs/live81/load.log.
# Usage: harness/gate_load_sampler.sh [RESULTS_DIR, default runs/live81] &   (from anywhere; ends when no w81 chain runner is left)
cd "$(dirname "$0")/.." || exit 1
ROOT=${1:-runs/live81}
HOST=$(python3 -c 'import json,urllib.parse;print(urllib.parse.urlparse(json.load(open("runs/agent/B/models.json"))["providers"]["mac-studio"]["baseUrl"]).hostname)')
while pgrep -f "run_live_all.py --suite w81" > /dev/null; do
  echo "$(date +%H:%M:%S) gate_lanes=$(ps -axo command | grep -c "[h]arness/live.py --arm [LO] ") diag_runs=$(ps -axo command | grep -c "[a]bortcheck.ts runs/recordings") server_connections=$(lsof -nP -iTCP@$HOST -sTCP:ESTABLISHED 2>/dev/null | tail -n +2 | wc -l | tr -d " ")" >> "$ROOT/load.log"
  sleep 60
done
