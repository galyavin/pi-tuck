#!/bin/bash
# The abort check (PREREG-ABORTCHECK.md): answer sets that the main replay lost, each asked again in setup A (pi-tuck d71234a, compaction off, as the main replay) and
# setup B (pi-tuck v1.0.10, compaction on). Every pending (set, setup) pair starts at once, one mac-studio lane each; a pair with an output file is skipped, so a stop
# at any moment loses only the runs in flight (an output file is written when a run ends). While it runs, a sampler appends the load on the server to
# runs/abortcheck/load.log every 60 s. Writes only runs/abortcheck/.
# Usage: harness/run_abortcheck.sh ["REC CUT" ...]   (default: s01-A 5, s05-A 5, s09-B 5; from anywhere)
cd "$(dirname "$0")/.." || exit 1
J=../node_modules/.bin/jiti
SETS=("$@"); [ ${#SETS[@]} -eq 0 ] && SETS=("s01-A 5" "s05-A 5" "s09-B 5")
mkdir -p runs/abortcheck/logs
# The server whose load is sampled: MAC_STUDIO_HOST, else the host of the mac-studio entry in the agent folder's models.json (a local file, not committed).
HOST=${MAC_STUDIO_HOST:-$(python3 -c 'import json,urllib.parse;print(urllib.parse.urlparse(json.load(open("runs/agent/B/models.json"))["providers"]["mac-studio"]["baseUrl"]).hostname)')}
( while true; do echo "$(date +%H:%M:%S) abortcheck_runs=$(pgrep -f replay/abortcheck.ts | wc -l | tr -d ' ') server_connections=$(lsof -nP -iTCP@$HOST -sTCP:ESTABLISHED 2>/dev/null | tail -n +2 | wc -l | tr -d ' ')" >> runs/abortcheck/load.log; sleep 60; done ) &
SAMPLER=$!
for SET in "${SETS[@]}"; do
  set -- $SET; REC=$1; CUT=$2; D=runs/replay/$REC
  for SETUP in A B; do
    if [ "$SETUP" = A ]; then TUCK=runs/tuck-1.0.1; COMP=off; else TUCK=runs/tuck-1.0.10; COMP=on; fi
    OUT=runs/abortcheck/$SETUP/$REC-cut$CUT.jsonl
    [ -f "$OUT" ] && continue
    ( echo "$(date +%H:%M:%S) start $SETUP $REC cut $CUT"
      $J replay/abortcheck.ts runs/recordings/$REC.jsonl "$D" "$D/probes.json" "$OUT" --agent mac-studio/main:xhigh --variant tuck-lexical --cuts $CUT --tuck-dir $TUCK --compaction $COMP
      echo "$(date +%H:%M:%S) end $SETUP $REC cut $CUT $([ -f "$OUT" ] && echo written || echo FAILED)" ) > runs/abortcheck/logs/$SETUP-$REC-cut$CUT.log 2>&1 &
  done
done
wait $(jobs -p | grep -v "^$SAMPLER$") 2>/dev/null
kill $SAMPLER 2>/dev/null
echo "$(date +%H:%M:%S) runner done"
