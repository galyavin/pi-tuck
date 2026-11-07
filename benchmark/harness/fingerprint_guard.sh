#!/bin/bash
# Stops a live gate when the model behind mac-studio/main changes (PREREG-ADAPTIVE.md, "Model identity": the run is valid only while every sample reads the start sha).
# Usage:  harness/fingerprint_guard.sh now [LOG]            print the current sha (nothing if the sample failed) and append the sample to LOG
#         harness/fingerprint_guard.sh watch GATE_PID SHA   every GUARD_EVERY seconds (default 300) sample; if a sample carries a sha other than SHA, stop the gate
# A sample with no sha (server error, 503, timeout) is logged and does not count as a change. Stopping = SIGTERM to every process whose command line holds GATE_PATTERN
# (default "--suite w81": the chain runner and its arms), then the arms' task containers (tuck-<chain>-<arm>-<n>) removed, then one note at GUARD_NOTE
# (default runs/live81/STOPPED-FINGERPRINT.txt) with the time, both shas, the containers removed and the tasks each chain arm had finished. Partial chain folders stay as they are.
cd "$(dirname "$0")/.." || exit 1
LOG=${GUARD_LOG:-runs/live81/model-fingerprints.log}
sample() { runs/.venv/bin/python harness/model_fingerprint.py --log "${1:-$LOG}" 2>/dev/null | tail -n 1 | python3 -c 'import json,sys
try: print(json.loads(sys.stdin.read()).get("sha",""))
except Exception: print("")'; }
case "$1" in
  now) mkdir -p "$(dirname "${2:-$LOG}")"; sample "$2" ;;
  watch)
    pid=$2; expect=$3; [ -n "$pid" ] && [ -n "$expect" ] || { echo "usage: $0 watch GATE_PID SHA"; exit 2; }
    pattern=${GATE_PATTERN:---suite w81}; note=${GUARD_NOTE:-runs/live81/STOPPED-FINGERPRINT.txt}
    while kill -0 "$pid" 2>/dev/null; do
      sleep "${GUARD_EVERY:-300}"
      kill -0 "$pid" 2>/dev/null || exit 0
      seen=$(sample)
      if [ -n "$seen" ] && [ "$seen" != "$expect" ]; then
        { echo "$(date '+%F %T') gate stopped: the model sha changed from $expect to $seen"
          echo "processes stopped (pattern '$pattern'): $(pgrep -f -- "$pattern" | tr '\n' ' ')"; } > "$note"
        pkill -TERM -f -- "$pattern"; sleep 10; pkill -KILL -f -- "$pattern"
        cut=$(docker ps --format '{{.Names}}' | grep -E '^tuck-t[0-9]+-[A-Z]-[0-9]+$' | tr '\n' ' ')
        [ -n "$cut" ] && docker rm -f $cut > /dev/null 2>&1
        { echo "task containers cut off: ${cut:-none}"
          for d in runs/live81/t[0-9][0-9]-[A-Z]; do [ -f "$d/tasks.jsonl" ] && echo "$d: $(grep -c . "$d/tasks.jsonl") tasks finished"; done; } >> "$note"
        exit 0
      fi
    done ;;
  *) echo "usage: $0 now [LOG] | watch GATE_PID SHA"; exit 2 ;;
esac
