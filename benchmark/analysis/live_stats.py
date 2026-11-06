"""Live-run statistics: PREREG claims 2 (end to end) and 3 (tokens per session, wall time, cut latency).

Usage: live_stats.py LIVE_DIR [--sessions s01,s02,...] [--boot 10000] [--seed 1]
LIVE_DIR holds <session>-<arm>/ folders written by harness/live.py. The arms are paired by session: both ran the same task chain."""
import argparse
import json
import random
import statistics
from collections import defaultdict
from pathlib import Path

from sessionlog import session_cuts


def load(folder: Path):
    tasks = [json.loads(l) for l in (folder / "tasks.jsonl").read_text().splitlines() if l.strip()] if (folder / "tasks.jsonl").exists() else []
    stats = json.loads((folder / "stats.json").read_text()) if (folder / "stats.json").exists() else None
    cuts = session_cuts(folder)  # the session file lists every cut; the events miss pi-tuck's tool-loop cuts (see sessionlog.py)
    return tasks, stats, cuts


def boot_ci(values, boot, rng, one_sided=True):
    draws = sorted(statistics.fmean(rng.choices(values, k=len(values))) for _ in range(boot))
    return draws[int(0.05 * boot)] if one_sided else (draws[int(0.025 * boot)], draws[int(0.975 * boot)])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("root")
    parser.add_argument("--sessions")
    parser.add_argument("--boot", type=int, default=10000)
    parser.add_argument("--seed", type=int, default=1)
    args = parser.parse_args()
    rng = random.Random(args.seed)
    root = Path(args.root)
    data = {}
    for folder in sorted(root.iterdir()):
        if folder.is_dir() and "-" in folder.name:
            session, arm = folder.name.rsplit("-", 1)
            if args.sessions and session not in args.sessions.split(","):
                continue
            data[(session, arm)] = load(folder)
    arms = sorted({arm for _, arm in data})
    sessions = sorted({s for s, _ in data})
    print("=== per arm ===")
    for arm in arms:
        done = [(s, d) for (s, a), d in data.items() if a == arm]
        tasks = [t for _, (tk, _, _) in done for t in tk]
        resolved = sum(1 for t in tasks if t["grade"].get("resolved"))
        cuts = [c for _, (_, _, cu) in done for c in cu]
        tokens = [st["tokens"]["total"] for _, (_, st, _) in done if st]
        print(f"  arm {arm}: {len(done)} sessions, {len(tasks)} tasks, resolved {resolved} ({100 * resolved / max(1, len(tasks)):.1f}%), "
              f"tag followed {sum(t['tag_followed'] for t in tasks)}, empty patches {sum(1 for t in tasks if t['grade'].get('empty'))}, "
              f"median task time {statistics.median(t['seconds'] for t in tasks) if tasks else 0:.0f}s")
        if tokens:
            print(f"     tokens/session: mean {statistics.fmean(tokens):,.0f} (provider-reported input+output+cache incl. summarization calls)")
        if cuts:
            sec = sorted(c["seconds"] for c in cuts)
            print(f"     cuts: {len(cuts)} ({sum(1 for c in cuts if not c['ok'])} failed), latency median {statistics.median(sec):.3f}s p90 {sec[int(0.9 * (len(sec) - 1))]:.3f}s; "
                  f"context carried after a cut, median {statistics.median([c['after_est'] or c['after_reported'] for c in cuts if c['after_est'] or c['after_reported']] or [0]):,.0f}; per session {len(cuts) / len(done):.1f}")
    if len(arms) >= 2 and "A" in arms:
        for arm in [a for a in arms if a != "A"]:
            print(f"\n=== arm {arm} vs A, paired by task ===")
            pairs = defaultdict(dict)
            for (s, a), (tk, _, _) in data.items():
                if a in ("A", arm):
                    for t in tk:
                        pairs[(s, t["instance_id"])][a] = 1 if t["grade"].get("resolved") else 0
            both = [(v["A"], v[arm]) for v in pairs.values() if "A" in v and arm in v]
            if both:
                diffs = [100 * (y - x) for x, y in both]
                by_session = defaultdict(list)
                for (s, _), v in pairs.items():
                    if "A" in v and arm in v:
                        by_session[s].append(100 * (v[arm] - v["A"]))
                clusters = [statistics.fmean(v) for v in by_session.values()]
                lower = boot_ci(clusters, args.boot, rng) if len(clusters) > 1 else float("nan")
                b_only = sum(1 for x, y in both if y and not x)
                a_only = sum(1 for x, y in both if x and not y)
                print(f"  {len(both)} paired tasks: {arm}-only resolved {b_only}, A-only resolved {a_only}; difference {statistics.fmean(diffs):+.1f} pts; "
                      f"one-sided 95% lower bound (bootstrap over {len(clusters)} session chains) {lower:+.1f} pts")
            for label, get in (("tokens/session", lambda st: st["tokens"]["total"]), ("uncached input+output", lambda st: st["tokens"]["input"] + st["tokens"]["cacheWrite"] + st["tokens"]["output"])):
                per = []
                for s in sessions:
                    a, b = data.get((s, "A")), data.get((s, arm))
                    if a and b and a[1] and b[1]:
                        per.append(get(b[1]) - get(a[1]))
                if per:
                    brng = random.Random(args.seed)
                    draws = sorted(statistics.fmean(brng.choices(per, k=len(per))) for _ in range(args.boot))
                    upper = draws[int(0.95 * args.boot)]  # PREREG claim 3(b): supported if the mean and this one-sided 95% upper bound are below zero (bootstrap over sessions, paired by chain)
                    print(f"  {label}: {arm} - A per session mean {statistics.fmean(per):+,.0f} over {len(per)} sessions "
                          f"({sum(1 for p in per if p < 0)} sessions lower); one-sided 95% upper bound {upper:+,.0f}: {'below zero' if upper < 0 and statistics.fmean(per) < 0 else 'NOT below zero'}")
            wall = []
            for s in sessions:
                a, b = data.get((s, "A")), data.get((s, arm))
                if a and b and a[0] and b[0]:
                    wall.append(sum(t["seconds"] for t in b[0]) - sum(t["seconds"] for t in a[0]))
            if wall:
                print(f"  agent wall time per session: {arm} - A mean {statistics.fmean(wall):+,.0f}s over {len(wall)} sessions")


if __name__ == "__main__":
    main()
