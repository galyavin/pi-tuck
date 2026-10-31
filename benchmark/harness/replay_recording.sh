#!/bin/sh
# Paired replay of one recording: cuts for every compactor, probes, answers by each agent, scores.
#   replay_recording.sh RECORDING.jsonl OUT_DIR [TUCK_DIR]
# Environment: AGENTS (space-separated "provider/id:thinking", default both), FIRST_CUT, DELTA, KEEP_RECENT for pilot and smoke runs only.
set -e
REC=$1; OUT=$2; TUCK=${3:-$(cd "$(dirname "$0")/../.." && pwd)}
HERE=$(cd "$(dirname "$0")/.." && pwd)
JITI="$HERE/../node_modules/.bin/jiti"
AGENTS=${AGENTS:-"mac-studio/main:xhigh openai/gpt-6-astra:medium"}
mkdir -p "$OUT"
EXTRA=""
[ -n "$FIRST_CUT" ] && EXTRA="$EXTRA --first-cut $FIRST_CUT"
[ -n "$KEEP_RECENT" ] && EXTRA="$EXTRA --keep-recent $KEEP_RECENT"
[ -n "$DELTA" ] && EXTRA="$EXTRA --delta $DELTA"
[ -f "$OUT/cuts.json" ] || "$JITI" "$HERE/replay/cuts.ts" "$REC" "$OUT" --tuck-dir "$TUCK" $EXTRA
[ -f "$OUT/probes.json" ] || "$JITI" "$HERE/replay/probes.ts" "$REC" "$OUT/cuts.json" "$OUT/probes.json"
for AGENT in $AGENTS; do
  TAG=$(echo "$AGENT" | tr '/:' '__')
  [ -f "$OUT/scores-$TAG.jsonl" ] && continue
  rm -f "$OUT/answers-$TAG.jsonl"
  "$JITI" "$HERE/replay/answer.ts" "$REC" "$OUT/cuts.json" "$OUT/probes.json" "$OUT/answers-$TAG.jsonl" --agent "$AGENT" --tuck-dir "$TUCK"
  "$JITI" "$HERE/replay/score.ts" "$OUT/probes.json" "$OUT/answers-$TAG.jsonl" "$OUT/scores-$TAG.jsonl"
done
