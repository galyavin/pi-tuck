"""Descriptive checks for PREREG-SUMMARYONLY.md (registered in DEVIATIONS.md before they were computed); they do not change the registered D.

Usage: summaryonly_extras.py SCORES_DIR --llms native-local|native-terra [--boot 10000] [--seed 1]
(a) D with the probes of every failed answer set (the 15-minute wall) kept and scored as wrong, in every arm;
(b) D by probe age, on the registered pairing (failed sets dropped). Pairing, usable-probe rule, bootstrap and seed are replay_stats.py's own (one generator per line: the probe bootstrap, then the chain bootstrap, as in `replay_stats.py --llms X`)."""
import argparse
import random
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import replay_stats as rs  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("root")
parser.add_argument("--llms", required=True)
parser.add_argument("--boot", type=int, default=10000)
parser.add_argument("--seed", type=int, default=1)
args = parser.parse_args()
SUT, AGENT = "tuck-norecall", "mac-studio/main:xhigh"
rows, cuts, evidence = rs.load(Path(args.root))
rows = [r for r in rows if r["agent"] == AGENT]


def pairs(include_failed):
    index = defaultdict(dict)
    for r in rows:
        if include_failed or not r["failed"]:
            index[(r["rec"], r["cut"], r["probe"])][r["variant"]] = r
    out = defaultdict(list)
    for by in index.values():
        if SUT in by and args.llms in by and rs.usable(by[SUT], cuts, evidence, SUT, args.llms):
            out[by[SUT]["rec"]].append((by[SUT]["correct"], by[args.llms]["correct"], by[SUT]))
    return out


def line(label, by_rec):
    n = sum(len(v) for v in by_rec.values())
    rng = random.Random(args.seed)
    draws = rs.bootstrap(by_rec, args.boot, rng)
    chain = rs.chain_bootstrap(by_rec, args.boot, rng)
    print(f"  {label}: D {rs.diff(by_rec, list(by_rec)):+.1f} pts over {n} shared probes, one-sided 95% lower bound {draws[int(0.05 * args.boot)]:+.1f} (chain-clustered {chain[int(0.05 * args.boot)]:+.1f})")


print(f"=== {SUT} vs {args.llms} ===")
registered = pairs(False)
line("registered pairing (failed sets dropped)", registered)
line("(a) failed sets kept, scored wrong", pairs(True))
failed = sum(1 for r in rows if r["failed"] and r["variant"] == SUT)
print(f"  probes in failed {SUT} answer sets: {failed}")
print("(b) by probe age, registered pairing (accuracy %, tuck-norecall / comparator, probes):")
by_age = defaultdict(list)
for v in registered.values():
    for x, y, row in v:
        by_age[int(row["age"])].append((x, y))
for age in sorted(by_age):
    xs = by_age[age]
    print(f"    age {age}: {100 * sum(x for x, _ in xs) / len(xs):.1f} / {100 * sum(y for _, y in xs) / len(xs):.1f} (n={len(xs)})")
