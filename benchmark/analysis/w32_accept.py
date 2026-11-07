"""The acceptance readout for arm C (B') on t01-t05, exactly as PREREG-32K.md fixes it (13:25 addendum and 14:55 definition).
Usage: w32_accept.py LIVE32_DIR [--boot 10000] [--seed 1]
Part 1: zero dead tasks (dead = refused before any request, or right after a refused task; mid-run refusals are counted apart and audited by hand,
analysis/refusal_audit.py). Part 2: d_C >= d_B - 3 points, d_B = mean paired B-minus-A on the tasks before each chain's first refusal in arm B
(a chain with no refusal contributes all 30), pooled over t01-t05; d_C = mean paired C-minus-A on all 150 tasks.
Then the readouts with no pass line: C minus A and C minus M (all tasks and S), turns, requests over the room, cuts, tokens, spend, tasks recovered."""
import argparse
import random
import statistics
from pathlib import Path

from w32_stats import compare, load

parser = argparse.ArgumentParser()
parser.add_argument("root")
parser.add_argument("--boot", type=int, default=10000)
parser.add_argument("--seed", type=int, default=1)
args = parser.parse_args()
chains = [f"t0{n}" for n in range(1, 6)]
data = {(c, a): load(Path(args.root) / f"{c}-{a}") for c in chains for a in "ABCM"}
resolved = lambda d, k: int(bool(d["tasks"][k]["grade"].get("resolved")))

dead = {c: sorted({k for k in data[(c, "C")]["refused"] if k in data[(c, "C")]["tasks"] and (not sum((data[(c, "C")]["tasks"][k].get("usage") or {}).get(u, 0) for u in ("input", "output", "cacheRead")) or (k - 1) in data[(c, "C")]["refused"])} | {k for k, t in data[(c, "C")]["tasks"].items() if not sum((t.get("usage") or {}).get(u, 0) for u in ("input", "output", "cacheRead")) and t.get("aborted_for") != "wall"}) for c in chains}
mid = {c: sorted(data[(c, "C")]["refused"] - set(dead[c])) for c in chains}
print("PART 1  dead tasks in arm C:", sum(len(v) for v in dead.values()), dead, "| mid-run refusals:", sum(len(v) for v in mid.values()), mid)

b_rows, c_rows = [], []
for c in chains:
    a, b, cc = data[(c, "A")], data[(c, "B")], data[(c, "C")]
    first = min(b["refused"], default=10**9)
    for k in sorted(set(a["tasks"]) & set(b["tasks"])):
        if k < first:
            b_rows.append(100 * (resolved(b, k) - resolved(a, k)))
    for k in sorted(set(a["tasks"]) & set(cc["tasks"])):
        c_rows.append(100 * (resolved(cc, k) - resolved(a, k)))
    print(f"  {c}: first refusal in B at task {first if first < 10**9 else 'none'}")
d_b, d_c = statistics.fmean(b_rows), statistics.fmean(c_rows)
print(f"PART 2  d_B = {d_b:+.2f} pts over {len(b_rows)} tasks before B's first refusal; d_C = {d_c:+.2f} pts over {len(c_rows)} tasks; bar: d_C >= d_B - 3 = {d_b - 3:+.2f}: {'PASS' if d_c >= d_b - 3 else 'FAIL'}")

print("\nREADOUTS WITH NO PASS LINE")
rng = random.Random(args.seed)
compare(data, chains, "A", "C", args.boot, rng)
compare(data, chains, "M", "C", args.boot, rng)
for arm in "ABCM":
    mine = [data[(c, arm)] for c in chains]
    tasks = [t for d in mine for t in d["tasks"].values()]
    tokens = [d["stats"]["tokens"]["total"] for d in mine if d["stats"]]
    cost = sum((d["stats"] or {}).get("cost") or 0 for d in mine if d["stats"] and not isinstance(d["stats"].get("cost"), dict))
    print(f"arm {arm}: tasks {len(tasks)}, resolved {sum(1 for t in tasks if t['grade'].get('resolved'))}, turns/task {statistics.fmean(t['turns'] for t in tasks):.1f}, cuts {sum(len(d['cuts']) for d in mine)}, "
          f"tasks with a request over the room {sum(len(d['over_room']) for d in mine)}, tokens/session {statistics.fmean(tokens):,.0f}, cost ${cost:.2f}")
recovered = [(c, k) for c in chains for k in sorted(data[(c, "B")]["refused"]) if k in data[(c, "C")]["tasks"] and k not in data[(c, "C")]["refused"]]
print(f"tasks refused in B and not refused in C (same chain and task): {len(recovered)}; of them resolved in C: {sum(resolved(data[(c, 'C')], k) for c, k in recovered)}, resolved in A: {sum(resolved(data[(c, 'A')], k) for c, k in recovered)}")
