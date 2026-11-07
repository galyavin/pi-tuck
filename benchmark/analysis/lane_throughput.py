"""Throughput by lanes in use, from the request traces of the abort-check style runs (exploratory look and re-measure).
Usage: lane_throughput.py DIR[:LOGDIR] ...   e.g. lane_throughput.py runs/explore-1010 runs/remeasure-1011
Every set record has its start time (first line of its log, clock time) and the end time of each request (`trace`, ms from the start). For every minute, the sets whose
span covers it are the lanes in use; the requests that completed in it, and their output tokens, are summed. Printed per lane count: minutes observed, completed requests per minute
(all lanes, and per lane), output tokens per minute (all lanes, and per lane), median seconds per request."""
import glob
import json
import re
import statistics
import sys
from collections import defaultdict

def tod(s):
    h, m, x = map(int, s.split(":"))
    return h * 3600 + m * 60 + x

sets = []  # (start_s, end_s, [(end_s, out_tokens, seconds)])
for arg in sys.argv[1:]:
    root = arg
    for f in glob.glob(root + "/*.jsonl") + glob.glob(root + "/*/*.jsonl"):
        parts = f.split("/")
        name = parts[-1][:-6]
        variant = parts[-2] if parts[-2] in ("tuck", "tuck-lexical", "A", "B") else None
        if "attempt1" in f:
            continue
        log = "/".join(parts[:-2] if variant else parts[:-1]) + "/logs/" + (f"{variant}-" if variant else "") + name + ".log"
        try:
            start = tod(re.match(r"(\d+:\d+:\d+)", open(log).readline()).group(1))
        except Exception:
            continue
        r = json.loads(open(f).readline())
        reqs, prev = [], 0
        for t in r["trace"]:
            if t["role"] == "assistant":
                if t["stopReason"] != "aborted" and (t["usage"] or {}).get("output", 0) > 0:
                    reqs.append((start + t["atMs"] / 1000, t["usage"]["output"], (t["atMs"] - prev) / 1000))
                prev = t["atMs"]
        sets.append((start, start + r["ms"] / 1000, reqs))
if not sets:
    sys.exit("no sets")
t0 = int(min(s[0] for s in sets) // 60)
t1 = int(max(s[1] for s in sets) // 60)
by_lanes = defaultdict(lambda: {"minutes": 0, "reqs": 0, "out": 0, "secs": []})
for minute in range(t0, t1):
    lo, hi = minute * 60, minute * 60 + 60
    active = [s for s in sets if s[0] < hi and s[1] > lo]
    if not active:
        continue
    n = len(active)
    b = by_lanes[n]
    b["minutes"] += 1
    for s in active:
        for end, out, secs in s[2]:
            if lo <= end < hi:
                b["reqs"] += 1; b["out"] += out; b["secs"].append(secs)
print("lanes in use | minutes | requests/min (all lanes) | per lane | output tokens/min (all lanes) | per lane | median s per request")
for n in sorted(by_lanes, reverse=True):
    b = by_lanes[n]
    if b["minutes"] < 3:
        continue
    rq = b["reqs"] / b["minutes"]; ot = b["out"] / b["minutes"]
    print(f"{n} | {b['minutes']} | {rq:.1f} | {rq / n:.2f} | {ot:.0f} | {ot / n:.0f} | {statistics.median(b['secs']):.0f}")
