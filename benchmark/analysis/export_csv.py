"""Export the small, publishable tables (the raw session files and events stay out of git).

Usage: export_csv.py LIVE_DIR REPLAY_DIR OUT_DIR
Writes OUT_DIR/live_tasks.csv, live_cuts.csv, replay_scores.csv, replay_cuts.csv."""
import csv
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sessionlog import session_cuts  # noqa: E402

live, replay, out = (Path(a) for a in sys.argv[1:4])
out.mkdir(parents=True, exist_ok=True)


def write(name, header, rows):
    with open(out / name, "w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(header)
        writer.writerows(rows)


tasks, cuts = [], []
for folder in sorted(p for p in live.iterdir() if p.is_dir() and "-" in p.name):
    session, arm = folder.name.rsplit("-", 1)
    if (folder / "tasks.jsonl").exists():
        for line in (folder / "tasks.jsonl").read_text().splitlines():
            t = json.loads(line)
            u = t.get("usage") or {}
            tasks.append([session, arm, t["index"], t["instance_id"], int(bool(t["grade"].get("resolved"))), int(bool(t["grade"].get("empty"))), round(t["seconds"], 1), t.get("turns"),
                          u.get("requests"), u.get("input"), u.get("output"), u.get("cacheRead"), t.get("aborted_for") or "", int(bool(t.get("ended_in_error")) and not t.get("aborted_for")), int(t["tag_followed"]),
                          int(t["result_line"])])
    for k, c in enumerate(session_cuts(folder), 1):
        cuts.append([session, arm, k, "hook" if c["from_hook"] else "native", round(c["seconds"], 3), c["before"], c["after_est"], c["after_reported"]])
write("live_tasks.csv", ["session", "arm", "index", "instance", "resolved", "empty_patch", "seconds", "turns", "requests", "input", "output", "cache_read", "aborted_for", "ended_in_error", "tag_followed", "result_line"], tasks)
write("live_cuts.csv", ["session", "arm", "cut", "kind", "seconds_upper_bound", "tokens_before", "carried_after_est", "after_reported"], cuts)

scores, rcuts = [], []
for folder in sorted(p for p in replay.iterdir() if p.is_dir()):
    for f in sorted(folder.glob("scores-*.jsonl")):
        for line in f.read_text().splitlines():
            s = json.loads(line)
            scores.append([folder.name, s["variant"], s["cut"], s["agent"], s["probe"], s["type"], s["age"], s.get("task"), s["correct"], int(s["answered"]), int(s["failed"])])
    for f in sorted(folder.glob("cuts-*.json")):
        d = json.loads(f.read_text())
        for r in d["log"]:
            rcuts.append([folder.name, d["variant"], r["cut"], r["position"], r.get("preCutTokens"), r.get("ms"), r.get("carriedTokens"), r.get("summaryChars"), r.get("firstKeptIndex"), r.get("refused", "")])
write("replay_scores.csv", ["recording", "variant", "cut", "agent", "probe", "type", "age", "task", "correct", "answered", "run_failed"], scores)
write("replay_cuts.csv", ["recording", "variant", "cut", "position", "pre_cut_tokens", "ms", "carried_tokens", "summary_chars", "first_kept_index", "refused"], rcuts)
print(f"{len(tasks)} tasks, {len(cuts)} live cuts, {len(scores)} replay scores, {len(rcuts)} replay cuts")
