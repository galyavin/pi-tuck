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

from prompt_drops import dropped_prompt_tasks
from w32_stats import compare, load

parser = argparse.ArgumentParser()
parser.add_argument("root")
parser.add_argument("--base", default="F")
parser.add_argument("--cand", default="G")
parser.add_argument("--sessions", default="t01,t02")
parser.add_argument("--boot", type=int, default=10000)
parser.add_argument("--seed", type=int, default=1)
parser.add_argument("--tier", type=int, choices=(1, 2), help="PREREG tier: 1 = at least 60 paired tasks and lower bound above -10 points; 2 = at least 150 and above -5")
parser.add_argument("--exclude", action="append", default=[], metavar="CHAIN:INDEX", help="readout with no pass line: the paired resolved difference and its lower bound without these tasks, e.g. t03:24")
parser.add_argument("--count-dropped-prompts", action="store_true", help="2026-11-06: a task whose prompt was dropped at a cut (receipt, prompt_drops.py) counts as a dead task; off by default so that registered readouts reproduce unchanged")
parser.add_argument("--cutlater", action="store_true", help="PREREG-CUTLATER.md: add the turns and spend conditions and the four-condition verdict")
args = parser.parse_args()
chains, arms = args.sessions.split(","), [args.base, args.cand]
root = Path(args.root)
data = {(c, a): load(root / f"{c}-{a}") for c in chains for a in arms}
resolved = lambda d, k: int(bool(d["tasks"][k]["grade"].get("resolved")))
sent = lambda t: sum((t.get("usage") or {}).get(u, 0) for u in ("input", "output", "cacheRead")) > 0


def dead_and_mid(d, folder=None):
    dead = {k for k in d["refused"] if k in d["tasks"] and (not sent(d["tasks"][k]) or (k - 1) in d["refused"])} | {k for k, t in d["tasks"].items() if not sent(t) and t.get("aborted_for") != "wall"}  # a task that ended by itself with no tokens is lost whatever the notice (2026-11-01); one that sat on an unanswered request to the wall cap is a stall, reported apart (2026-11-05)
    if args.count_dropped_prompts and folder is not None:
        dead = dead | (dropped_prompt_tasks(folder) & set(d["tasks"]))
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


def recall_calls(folder: Path):
    """tuck_recall calls in the event log, and those with an offset (a read of the rest of a clipped result). The clip itself is applied to requests only
    and is not recorded, so these are a proxy, not a count of clips."""
    offset = total = 0
    for line in (folder / "events.jsonl").read_text().splitlines():
        if '"toolCall"' not in line or "tuck_recall" not in line:
            continue
        e = json.loads(line)
        m = e.get("message") if e.get("type") == "message_end" else None
        if not isinstance(m, dict) or m.get("role") != "assistant":
            continue
        for b in m.get("content") or []:
            if isinstance(b, dict) and b.get("type") == "toolCall" and b.get("name") == "tuck_recall":
                total += 1
                offset += isinstance(b.get("arguments"), dict) and "offset" in b["arguments"]
    return offset, total


print(f"GATE  chains {','.join(chains)}; base arm {args.base}, candidate arm {args.cand}")
summary = {}
for arm in arms:
    dead = {c: sorted(dead_and_mid(data[(c, arm)], root / f"{c}-{arm}")[0]) for c in chains}
    mid = {c: sorted(dead_and_mid(data[(c, arm)], root / f"{c}-{arm}")[1]) for c in chains}
    n = sum(len(data[(c, arm)]["tasks"]) for c in chains)
    res = sum(resolved(data[(c, arm)], k) for c in chains for k in data[(c, arm)]["tasks"])
    summary[arm] = {"dead": sum(map(len, dead.values())), "mid": sum(map(len, mid.values())), "n": n, "res": res}
    print(f"  arm {arm}: tasks {n}, resolved {res}, dead tasks {summary[arm]['dead']} {dead}, mid-run refusals {summary[arm]['mid']} {mid}")
b, g = summary[args.base], summary[args.cand]
complete = b["n"] == g["n"] == 30 * len(chains)
cost_of = lambda arm: sum((data[(c, arm)]["stats"] or {}).get("cost") or 0 for c in chains if data[(c, arm)]["stats"] and not isinstance(data[(c, arm)]["stats"].get("cost"), dict))
print(f"  paired tasks complete in both arms: {complete} ({b['n']} and {g['n']} of {30 * len(chains)})")
print(f"  candidate dead tasks = 0: {g['dead'] == 0}; candidate resolved {g['res']} >= base resolved {b['res']}: {g['res'] >= b['res']}; GATE: {'PASS' if complete and g['dead'] == 0 and g['res'] >= b['res'] else 'FAIL or incomplete'}")

tier_met = None
if args.tier:
    from w32_stats import bootstrap
    need, floor = {1: (60, -10.0), 2: (150, -5.0)}[args.tier]
    diffs = [100 * (resolved(data[(c, args.cand)], k) - resolved(data[(c, args.base)], k)) for c in chains for k in sorted(set(data[(c, args.base)]["tasks"]) & set(data[(c, args.cand)]["tasks"]))]
    low = bootstrap(diffs, args.boot, random.Random(args.seed))[0] if len(diffs) > 1 else float("nan")
    ok_n, ok_low = len(diffs) >= need, low > floor
    print(f"TIER {args.tier} RESOLVED RULE  paired tasks {len(diffs)} (need {need}): {ok_n}; mean difference {statistics.fmean(diffs):+.1f} points, one-sided 95% lower bound {low:+.1f} (paired bootstrap, {args.boot} draws, seed {args.seed}) above {floor:+.0f}: {ok_low}; RESOLVED RULE: {'MET' if ok_n and ok_low else 'NOT MET'}")
    tier_met = ok_n and ok_low

if args.cutlater:
    both = [(c, k) for c in chains for k in sorted(set(data[(c, args.base)]["tasks"]) & set(data[(c, args.cand)]["tasks"])) if resolved(data[(c, args.base)], k) and resolved(data[(c, args.cand)], k)]
    tb = statistics.fmean(data[(c, args.base)]["tasks"][k]["turns"] for c, k in both)
    tc = statistics.fmean(data[(c, args.cand)]["tasks"][k]["turns"] for c, k in both)
    drop = (tb - tc) / tb
    spend = {arm: cost_of(arm) / summary[arm]["n"] for arm in arms}
    resolved_ok = tier_met if args.tier else g["res"] >= b["res"]  # a PREREG that names a tier uses its margin rule; the first cut-later test registered the exact count
    resolved_note = "by the tier rule" if args.tier else "candidate %d >= base %d" % (g["res"], b["res"])
    ok = [drop >= 0.15, g["dead"] == 0, resolved_ok, spend[args.cand] <= spend[args.base]]
    print(f"CUT-LATER BAR  1 turns on the {len(both)} tasks both arms resolved: base {tb:.2f}, candidate {tc:.2f}, fall {100 * drop:.1f}% (>= 15%): {ok[0]}")
    print(f"               2 dead tasks in the candidate = 0: {ok[1]}; 3 resolved {resolved_note}: {ok[2]}")
    print(f"               4 Pi usage spend per task: base ${spend[args.base]:.4f}, candidate ${spend[args.cand]:.4f} (candidate <= base): {ok[3]}")
    print(f"               VERDICT: {'PASS' if complete and all(ok) else 'FAIL or incomplete'}")

print("\nREADOUTS WITH NO PASS LINE")
if args.exclude:
    from w32_stats import bootstrap
    skip = {(x.split(":")[0], int(x.split(":")[1])) for x in args.exclude}
    kept = [100 * (resolved(data[(c, args.cand)], k) - resolved(data[(c, args.base)], k)) for c in chains for k in sorted(set(data[(c, args.base)]["tasks"]) & set(data[(c, args.cand)]["tasks"])) if (c, k) not in skip]
    low_x = bootstrap(kept, args.boot, random.Random(args.seed))[0] if len(kept) > 1 else float("nan")
    print(f"WITHOUT {sorted(skip)} (readout, no pass line): paired tasks {len(kept)}; mean difference {statistics.fmean(kept):+.1f} points, one-sided 95% lower bound {low_x:+.1f} (paired bootstrap, {args.boot} draws, seed {args.seed})")

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
    if args.cutlater:
        rc = [recall_calls(root / f"{c}-{arm}") for c in chains]
        print(f"arm {arm}: tuck_recall calls {sum(t for _, t in rc)}, of which with an offset (proxy for reads of clipped results) {sum(o for o, _ in rc)}")
    print(f"arm {arm}: tasks {len(tasks)}, turns/task {statistics.fmean(t['turns'] for t in tasks):.2f}, cuts {at_end + in_loop} ({(at_end + in_loop) / len(tasks):.2f} per task: "
          f"at run end {at_end} = {at_end / len(tasks):.2f}, in the loop {in_loop} = {in_loop / len(tasks):.2f}), wall-ended tasks {wall}, "
          f"tokens input {tok['input']:,} output {tok['output']:,} cacheRead {tok['cacheRead']:,} total {tok['total']:,} (per session {per_session}), cost ${cost:.2f}")
