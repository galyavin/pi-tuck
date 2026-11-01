#!/bin/sh
# Exit with a reason when something needs a look: DONE (live driver finished), DEAD <chain> (an unfinished chain has no live.py process),
# STALL (no live event for 20 minutes), REPLAY-DEAD / REPLAY-FAIL (the replay driver stopped, or a job failed), HEARTBEAT (after $1 minutes).
cd "$(dirname "$0")/.." || exit 1
LIMIT=${1:-180}; n=0
fails=$(grep -c ' FAIL ' runs/replay.out 2>/dev/null)
while :; do
  sleep 60; n=$((n+1))
  pgrep -f run_live_all.py >/dev/null || { echo DONE; break; }
  for d in runs/live/s[0-9]*-[ABC] runs/live32/t[0-9]*-[ABCM]; do
    [ -f "$d/run.json" ] && [ ! -f "$d/stats.json" ] || continue
    [ -f "$d/DIED" ] && continue  # set aside to be redone (DEVIATIONS)
    name=$(basename "$d"); session=${name%-*}; arm=${name#*-}
    pgrep -f "live.py --arm $arm --session $session " >/dev/null || { echo "DEAD $name"; break 2; }
  done
  newest=$(find runs/live -name events.jsonl -newermt '-20 minutes' 2>/dev/null | head -1)
  [ -z "$newest" ] && { echo STALL; break; }
  pgrep -f "run_replay.py runs/recordings" >/dev/null || { echo REPLAY-DEAD; break; }
  [ "$(grep -c ' FAIL ' runs/replay.out 2>/dev/null)" -gt "$fails" ] && { echo REPLAY-FAIL; break; }
  [ $n -ge $LIMIT ] && { echo HEARTBEAT; break; }
done
date
