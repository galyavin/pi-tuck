"""Dead-task audit for the 32k acceptance run (PREREG-32K.md, definition of 15:00): refused tasks per chain, with no outcome (resolved or not) printed.
Usage: dead_tasks.py LIVE32_DIR ARM [CHAIN ...]
A task is dead when pi-tuck refused it before any request carried tokens, or when it was refused right after a refused task (a failure carried
forward). Every other refused task is a mid-run refusal; its prompt size and largest tool result are printed so that it can be audited by hand
against its own fresh tool round.
Added 2026-11-06: a task whose prompt was dropped at a cut (no refusal, so nothing above counts it) is listed on its own line and in its own total; see prompt_drops.py. The dead and mid-run counts are unchanged."""
import json
import re
import sys
from pathlib import Path

from prompt_drops import dropped_prompt_tasks
from w32_stats import TASK, text_of, scan_events


def biggest_result(folder: Path) -> dict:
    task, big = 0, {}
    for line in (folder / "events.jsonl").read_text().splitlines():
        if '"toolResult"' not in line and "Task " not in line:
            continue
        try:
            e = json.loads(line)
        except ValueError:
            continue
        m = e.get("message") or {}
        if e.get("type") == "message_start" and m.get("role") == "user":
            found = TASK.search(text_of(m.get("content") or ""))
            task = int(found.group(1)) if found else task
        elif e.get("type") == "message_end" and m.get("role") == "toolResult":
            c = m.get("content")
            big[task] = max(big.get(task, 0), sum(len(b.get("text", "")) for b in c if isinstance(b, dict)) if isinstance(c, list) else 0)
    return big


root, arm, *chains = sys.argv[1:]
dead_total = mid_total = dropped_total = 0
for folder in sorted(Path(root).glob(f"t[0-9][0-9]-{arm}")):
    if chains and folder.name.split("-")[0] not in chains:
        continue
    tasks = {}
    if (folder / "tasks.jsonl").exists():
        for line in (folder / "tasks.jsonl").read_text().splitlines():
            if line.strip():
                t = json.loads(line)
                tasks[t["index"]] = t
    refused, largest = scan_events(folder)
    big = biggest_result(folder) if (folder / "events.jsonl").exists() else {}
    sent = lambda t: sum((t.get("usage") or {}).get(k, 0) for k in ("input", "output", "cacheRead")) > 0
    dead = {k for k in refused if k in tasks and (not sent(tasks[k]) or (k - 1) in refused)} | {k for k, t in tasks.items() if not sent(t) and t.get("aborted_for") != "wall"}  # a task that ended by itself with no tokens is lost whatever the notice (2026-11-01); one that sat on an unanswered request to the wall cap is a stall, reported apart (2026-11-05)
    mid = refused - dead
    dead_total += len(dead)
    mid_total += len(mid)
    print(f"{folder.name}: {len(tasks)} tasks done; refused {len(refused)}: dead {sorted(dead)}; mid-run {sorted(mid)}")
    for k in sorted(mid):
        print(f"    mid-run task {k}: largest prompt {largest.get(k, 0)} tokens, largest tool result {big.get(k, 0)} characters")
    dropped = dropped_prompt_tasks(folder)
    dropped_total += len(dropped)
    print(f"    prompt dropped at a cut (receipt) in tasks {sorted(dropped)}")
print(f"TOTAL arm {arm}: dead {dead_total}, mid-run {mid_total}, prompt dropped at a cut {dropped_total}")
