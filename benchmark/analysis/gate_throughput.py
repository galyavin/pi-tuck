"""Throughput of the w81 gate by lanes in use, from Pi's own event streams.
Usage: gate_throughput.py [ROOT=runs/live81]
Every chain arm's events.jsonl stamps each event (`_t`); an assistant `message_end` is one completed request. A minute counts a chain arm as a lane in use when it completed a request or its
stream was still open in that minute (first to last event). Per lane count over the gate's chain arms: minutes observed, completed requests per minute (all lanes and per lane), median
seconds per request. Lanes of other jobs on the server are not counted here; `load.log` beside the streams has the gate's lanes and the server's connections."""
import glob
import json
import statistics
import sys
from collections import defaultdict

root = sys.argv[1] if len(sys.argv) > 1 else "runs/live81"
spans, ends = {}, defaultdict(list)
for f in sorted(glob.glob(root + "/t*-[LO]/events.jsonl")):
    first = last = None
    prev = None
    for line in open(f):
        try:
            e = json.loads(line)
        except ValueError:
            continue
        t = e.get("_t")
        if t is None:
            continue
        first = first if first is not None else t
        last = t
        if e.get("type") == "turn_start":
            prev = t
        if e.get("type") == "message_end" and e["message"].get("role") == "assistant":
            ends[f].append((t, t - prev if prev else None))
    if first is not None:
        spans[f] = (first, last)
minutes = defaultdict(lambda: [set(), 0])
for f, (a, b) in spans.items():
    for m in range(int(a // 60), int(b // 60) + 1):
        minutes[m][0].add(f)
    for t, _ in ends[f]:
        minutes[int(t // 60)][1] += 1
by_lanes = defaultdict(list)
for m, (lanes, n) in minutes.items():
    by_lanes[len(lanes)].append(n)
secs = [s for v in ends.values() for _, s in v if s]
print("lanes in use (gate chain arms) | minutes | requests/min all lanes | per lane")
for k in sorted(by_lanes):
    v = by_lanes[k]
    print(f"{k} | {len(v)} | {sum(v) / len(v):.2f} | {sum(v) / len(v) / k:.2f}")
if secs:
    print(f"median seconds per request (turn start to the end of the answer): {statistics.median(secs):.0f}")
