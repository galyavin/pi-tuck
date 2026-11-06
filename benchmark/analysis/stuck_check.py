"""Stuck sessions, as PREREG-DEFAULTS.md defines them: a session is stuck when its event log has a gap of 3,600 s or more between two events
(the harness waits 3,600 s for any Pi answer), or when it ended unfinished (fewer than 30 task records or no stats.json).
Usage: stuck_check.py SESSION_DIR [SESSION_DIR ...]"""
import json
import sys
from pathlib import Path

GAP = 3600
for folder in map(Path, sys.argv[1:]):
    times = [json.loads(l)["_t"] for l in (folder / "events.jsonl").read_text().splitlines() if l.strip() and '"_t"' in l]
    gaps = sorted((b - a for a, b in zip(times, times[1:])), reverse=True)
    tasks = sum(1 for l in (folder / "tasks.jsonl").read_text().splitlines() if l.strip()) if (folder / "tasks.jsonl").exists() else 0
    finished = (folder / "stats.json").exists() and tasks == 30
    stuck = bool(gaps and gaps[0] >= GAP) or not finished
    print(f"{folder.name}: {tasks} task records, finished {finished}, events {len(times)}, longest gap {gaps[0] if gaps else 0:.0f} s, gaps >= {GAP} s: {sum(1 for g in gaps if g >= GAP)} -> {'STUCK' if stuck else 'not stuck'}")
