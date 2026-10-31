"""Cuts as the session file records them. pi-tuck's tool-loop cuts write a compaction entry but emit no compaction_start/end events, so the
events undercount arm B; the session file is complete for both arms. Counts, tokens before and the context carried after each cut (after_est,
from replay/live_after.ts) come from the file for both arms; after_reported is what the arm itself reported. Latency is the time from the entry written just before the cut to the
compaction entry: the cut runs between the last message and the next request, so this is the cut time plus any queueing in between (an
upper bound)."""
import json
from datetime import datetime
from pathlib import Path


def _time(entry) -> float:
    return datetime.fromisoformat(entry["timestamp"].replace("Z", "+00:00")).timestamp()


def session_cuts(folder: Path) -> list[dict]:
    path = folder / "session.jsonl"
    if not path.exists():
        return []
    cuts, previous = [], None
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        entry = json.loads(line)
        if "timestamp" not in entry or not isinstance(entry["timestamp"], str):
            continue
        if entry.get("type") == "compaction" and previous is not None:
            details = entry.get("details") or {}
            cuts.append({"seconds": _time(entry) - previous, "before": entry.get("tokensBefore"), "after_reported": details.get("tokensAfter"), "after_est": None,
                         "from_hook": bool(entry.get("fromHook")), "ok": True})
        previous = _time(entry)
    events = folder / "events.jsonl"
    if events.exists():  # arm A: the events carry Pi's post-cut estimate; they only match when none were missed
        after = [(json.loads(l).get("result") or {}).get("estimatedTokensAfter") for l in events.read_text().splitlines() if '"compaction_end"' in l]
        if len(after) == len(cuts):
            for cut, value in zip(cuts, after):
                cut["after_reported"] = cut["after_reported"] or value
    measured = folder / "cuts-after.json"  # replay/live_after.ts: the same carried-context estimate replay uses, for both arms
    if measured.exists():
        for cut, row in zip(cuts, json.loads(measured.read_text())):
            cut["after_est"] = row["carriedAfter"]
    return cuts
