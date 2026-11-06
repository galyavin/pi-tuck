#!/bin/sh
# watch.sh for a 32k-suite run: exit with DONE (the driver finished), DEAD <chain> (an unfinished chain has no live.py process), STALL (no event for 20 minutes)
# or HEARTBEAT (after $1 minutes). Usage: watch32.sh MINUTES ARMS SESSIONS [ROOT], e.g. watch32.sh 180 FG t01,t02 (ROOT: live32, or live32m for the Pi-defaults arm)
cd "$(dirname "$0")/.." || exit 1
LIMIT=${1:-180}; ARMS=${2:-FG}; SESSIONS=${3:-t01,t02}; ROOT=${4:-live32}; n=0
while :; do
  sleep 60; n=$((n+1))
  pgrep -f run_live_all.py >/dev/null || { echo DONE; break; }
  for s in $(echo "$SESSIONS" | tr , ' '); do
    for a in $(echo "$ARMS" | sed 's/./& /g'); do
      d=runs/$ROOT/$s-$a
      [ -f "$d/run.json" ] && [ ! -f "$d/stats.json" ] || continue
      [ -f "$d/DIED" ] && continue
      pgrep -f "live.py --arm $a --session $s " >/dev/null || { echo "DEAD $s-$a"; break 3; }
    done
  done
  [ -n "$(find runs/$ROOT -name events.jsonl -newermt '-20 minutes' 2>/dev/null | head -1)" ] || { echo STALL; break; }
  [ $n -ge $LIMIT ] && { echo HEARTBEAT; break; }
done
date
