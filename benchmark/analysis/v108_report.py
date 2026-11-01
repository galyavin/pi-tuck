"""The 1.0.8 candidate gate's readout, as PREREG-V108.md fixes it.
Usage: v108_report.py LIVE32_DIR [--base F] [--cand G] [--sessions t01,t02] [--boot 10000] [--seed 1]
Gate: 0 dead tasks in the candidate arm (dead = refused before any request, or right after a refused task; mid-run refusals are counted apart and
audited by hand with refusal_audit.py) and resolved tasks in the candidate no lower than in the base arm, over the same tasks.
Then the readouts with no pass line: the paired difference, mid-run refusals, wall-ended tasks, turns, cuts per task (at run end or in the loop),
tokens and spend."""
import argparse
import json
import random
import statistics
from pathlib import Path

from w32_stats import compare, load

parser = argparse.ArgumentParser()
parser.add_argument("root")
parser.add_argument("--base", default="F")
parser.add_argument("--cand", default="G")
parser.add_argument("--sessions", default="t01,t02")
parser.add_argument("--boot", type=int, default=10000)
parser.add_argument("--seed", type=int, default=1)
parser.add_argument("--cutlater", action="store_true", help="PREREG-CUTLATER.md: add the turns and spend conditions and the four-condition verdict")
args = parser.parse_args()
chains, arms = args.sessions.split(","), [args.base, args.cand]
root = Path(args.root)
data = {(c, a): load(root / f"{c}-{a}") for c in chains for a in arms}
resolved = lambda d, k: int(bool(d["tasks"][k]["grade"].get("resolved")))
sent = lambda t: sum((t.get("usage") or {}).get(u, 0) for u in ("input", "output", "cacheRead")) > 0


def dead_and_mid(d):
    dead = {k for k in d["refused"] if k in d["tasks"] and (not sent(d["tasks"][k]) or (k - 1) in d["refused"])}
    return dead, d["refused"] - dead


def cut_classes(folder: Path):
    """Cuts as compaction entries of session.jsonl: at run end when the entry just before is an assistant message with no tool call, else in the loop."""
    at_end = in_loop = 0
    previous = None
    for line in (folder / "session.jsonl").read_text().splitlines():
        if not line.strip():
            continue
        e = json.loads(line)
        if e.get("type") == "compaction":
            m = (previous or {}).get("message") or {}
            ends_run = (previous or {}).get("type") == "message" and m.get("role") == "assistant" and not any(b.get("type") == "toolCall" for b in m.get("content") or [] if isinstance(b, dict))
            at_end, in_loop = at_end + ends_run, in_loop + (not ends_run)
        previous = e
    return at_end, in_loop


print(f"GATE  chains {','.join(chains)}; base arm {args.base}, candidate arm {args.cand}")
summary = {}
for arm in arms:
    dead = {c: sorted(dead_and_mid(data[(c, arm)])[0]) for c in chains}
    mid = {c: sorted(dead_and_mid(data[(c, arm)])[1]) for c in chains}
    n = sum(len(data[(c, arm)]["tasks"]) for c in chains)
    res = sum(resolved(data[(c, arm)], k) for c in chains for k in data[(c, arm)]["tasks"])
    summary[arm] = {"dead": sum(map(len, dead.values())), "mid": sum(map(len, mid.values())), "n": n, "res": res}
    print(f"  arm {arm}: tasks {n}, resolved {res}, dead tasks {summary[arm]['dead']} {dead}, mid-run refusals {summary[arm]['mid']} {mid}")
b, g = summary[args.base], summary[args.cand]
complete = b["n"] == g["n"] == 30 * len(chains)
cost_of = lambda arm: sum((data[(c, arm)]["stats"] or {}).get("cost") or 0 for c in chains if data[(c, arm)]["stats"] and not isinstance(data[(c, arm)]["stats"].get("cost"), dict))
print(f"  paired tasks complete in both arms: {complete} ({b['n']} and {g['n']} of {30 * len(chains)})")
print(f"  candidate dead tasks = 0: {g['dead'] == 0}; candidate resolved {g['res']} >= base resolved {b['res']}: {g['res'] >= b['res']}; GATE: {'PASS' if complete and g['dead'] == 0 and g['res'] >= b['res'] else 'FAIL or incomplete'}")

if args.cutlater:
    both = [(c, k) for c in chains for k in sorted(set(data[(c, args.base)]["tasks"]) & set(data[(c, args.cand)]["tasks"])) if resolved(data[(c, args.base)], k) and resolved(data[(c, args.cand)], k)]
    tb = statistics.fmean(data[(c, args.base)]["tasks"][k]["turns"] for c, k in both)
    tc = statistics.fmean(data[(c, args.cand)]["tasks"][k]["turns"] for c, k in both)
    drop = (tb - tc) / tb
    spend = {arm: cost_of(arm) / summary[arm]["n"] for arm in arms}
    ok = [drop >= 0.15, g["dead"] == 0, g["res"] >= b["res"], spend[args.cand] <= spend[args.base]]
    print(f"CUT-LATER BAR  1 turns on the {len(both)} tasks both arms resolved: base {tb:.2f}, candidate {tc:.2f}, fall {100 * drop:.1f}% (>= 15%): {ok[0]}")
    print(f"               2 dead tasks in the candidate = 0: {ok[1]}; 3 resolved candidate {g['res']} >= base {b['res']}: {ok[2]}")
    print(f"               4 Pi usage spend per task: base ${spend[args.base]:.4f}, candidate ${spend[args.cand]:.4f} (candidate <= base): {ok[3]}")
    print(f"               VERDICT: {'PASS' if complete and all(ok) else 'FAIL or incomplete'}")

print("\nREADOUTS WITH NO PASS LINE")
compare(data, chains, args.base, args.cand, args.boot, random.Random(args.seed))
for arm in arms:
    mine = [data[(c, arm)] for c in chains]
    tasks = [t for d in mine for t in d["tasks"].values()]
    ends = [cut_classes(root / f"{c}-{arm}") for c in chains]
    at_end, in_loop = sum(x for x, _ in ends), sum(y for _, y in ends)
    wall = sum(1 for t in tasks if t.get("aborted_for") == "wall")
    tok = {k: sum((d["stats"] or {}).get("tokens", {}).get(k, 0) for d in mine) for k in ("input", "output", "cacheRead", "cacheWrite", "total")}
    per_session = [d["stats"]["tokens"]["total"] for d in mine if d["stats"]]
    cost = sum((d["stats"] or {}).get("cost") or 0 for d in mine if d["stats"] and not isinstance(d["stats"].get("cost"), dict))
    print(f"arm {arm}: tasks {len(tasks)}, turns/task {statistics.fmean(t['turns'] for t in tasks):.2f}, cuts {at_end + in_loop} ({(at_end + in_loop) / len(tasks):.2f} per task: "
          f"at run end {at_end} = {at_end / len(tasks):.2f}, in the loop {in_loop} = {in_loop / len(tasks):.2f}), wall-ended tasks {wall}, "
          f"tokens input {tok['input']:,} output {tok['output']:,} cacheRead {tok['cacheRead']:,} total {tok['total']:,} (per session {per_session}), cost ${cost:.2f}")
