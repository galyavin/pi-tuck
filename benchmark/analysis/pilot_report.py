"""The thinking-level pilot's readout, as PREREG-PILOT.md fixes it (arm S = medium, arm U = xhigh, chain p01).
Usage: pilot_report.py LIVE32G_DIR [--chain p01] [--slow S] [--fast U]   (the arm after --slow is the one expected to be faster; default S slow=U fast=S)
Decision: both gates use `medium` only if (1) total seconds of U / total seconds of S over the tasks finished in both arms is at least 2, and
(2) S resolves at least one task and at least half as many as U on the same tasks. Otherwise both use `xhigh`.
Also printed: seconds and turns per task, seconds per completed request (assistant message_start to message_end in the event log; median and mean),
output tokens, tasks ended at the turn cap, and the longest gap between events (a gap of 3,600 s or more is a stall)."""
import argparse
import json
import statistics
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("root")
parser.add_argument("--chain", default="p01")
parser.add_argument("--medium", default="S")
parser.add_argument("--xhigh", default="U")
args = parser.parse_args()
root = Path(args.root)


def load(arm):
    folder = root / f"{args.chain}-{arm}"
    tasks = {r["index"]: r for r in map(json.loads, filter(str.strip, (folder / "tasks.jsonl").read_text().splitlines()))}
    events = [json.loads(l) for l in (folder / "events.jsonl").read_text().splitlines() if l.strip()]
    return tasks, events


def requests_and_gap(events):
    durations, started = [], None
    times = [e["_t"] for e in events if "_t" in e]
    for e in events:
        role = (e.get("message") or {}).get("role")
        if e.get("type") == "message_start" and role == "assistant":
            started = e.get("_t")
        elif e.get("type") == "message_end" and role == "assistant" and started is not None and e.get("_t") is not None:
            durations.append(e["_t"] - started)
            started = None
    return durations, max((b - a for a, b in zip(times, times[1:])), default=0)


data = {arm: load(arm) for arm in (args.medium, args.xhigh)}
common = sorted(set(data[args.medium][0]) & set(data[args.xhigh][0]))
resolved = lambda t: bool((t.get("grade") or {}).get("resolved"))
stat = {}
for arm in (args.medium, args.xhigh):
    tasks, events = data[arm]
    rows = [tasks[k] for k in common]
    durations, gap = requests_and_gap(events)
    stat[arm] = {
        "seconds": sum(t["seconds"] for t in rows), "turns": [t["turns"] for t in rows], "resolved": sum(resolved(t) for t in rows),
        "capped": sum(t.get("aborted_for") == "turns" for t in rows), "output": sum((t.get("usage") or {}).get("output", 0) for t in rows),
        "requests": durations, "gap": gap, "per_task": [round(t["seconds"]) for t in rows],
    }
    s = stat[arm]
    print(f"arm {arm} ({'medium' if arm == args.medium else 'xhigh'}): tasks finished in both arms {len(common)}, total {s['seconds']:.0f} s ({s['seconds'] / len(common):.0f} s per task; per task {s['per_task']}), "
          f"turns per task {statistics.fmean(s['turns']):.1f} {s['turns']}, resolved {s['resolved']}, ended at the turn cap {s['capped']}, output tokens {s['output']:,}, "
          f"completed requests {len(s['requests'])} (median {statistics.median(s['requests']):.1f} s, mean {statistics.fmean(s['requests']):.1f} s), longest gap between events {s['gap']:.0f} s")
m, x = stat[args.medium], stat[args.xhigh]
ratio = x["seconds"] / m["seconds"]
c1 = ratio >= 2
c2 = m["resolved"] >= 1 and m["resolved"] >= x["resolved"] / 2
print(f"(1) seconds of xhigh / seconds of medium = {ratio:.3f} (>= 2): {c1}")
print(f"(2) medium resolved {m['resolved']}, xhigh resolved {x['resolved']} (medium >= 1 and >= half of xhigh): {c2}")
print(f"DECISION: both gates use {'medium' if c1 and c2 else 'xhigh'}")
