"""Power of the frontier comparison (PREREG Test 1b) at true parity, from the variance of Test 1a's probes. Prints no accuracy and no difference of
means: only counts and spreads. Method: take the probe-level paired differences (pi-tuck minus the local compactor, equal weight per probe) of the recordings
that have both, subtract their pooled mean (so the true difference is 0), then for each number of recordings n: draw n recordings with replacement,
compute the pooled D and the one-sided 95% bootstrap lower bound over those n recordings (the PREREG procedure), many times.
Usage: power_1b.py SCORES_DIR [--reps 2000] [--boot 1000] [--margin 3]"""
import argparse
import random
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from replay_stats import load, paired  # noqa: E402

parser = argparse.ArgumentParser()
parser.add_argument("root")
parser.add_argument("--reps", type=int, default=2000)
parser.add_argument("--boot", type=int, default=1000)
parser.add_argument("--margin", type=float, default=3.0)
parser.add_argument("--agent", default="mac-studio/main:xhigh")
parser.add_argument("--ns", default="6,8,10,12,16,20", help="numbers of recordings")
parser.add_argument("--deltas", default="0,2,4,6")
args = parser.parse_args()
rows, cuts, evidence = load(Path(args.root))
by_rec = paired(rows, args.agent, "tuck", "native-local", cuts, evidence)
by_rec = {r: [x - y for x, y, _ in v] for r, v in by_rec.items() if v}
allp = [d for v in by_rec.values() for d in v]
mean = statistics.fmean(allp)
centered = {r: [100 * (d - mean) for d in v] for r, v in by_rec.items()}  # points, true difference 0
recs = sorted(centered)
sizes = [len(centered[r]) for r in recs]
per_rec = [statistics.fmean(centered[r]) for r in recs]
print(f"recordings with both variants: {len(recs)}; probes per recording: min {min(sizes)}, median {statistics.median(sizes)}, max {max(sizes)}; "
      f"SD of the per-recording mean difference {statistics.stdev(per_rec):.1f} points; probe-level SD {statistics.stdev([d for v in centered.values() for d in v]):.1f} points")
rng = random.Random(1)


SUM = {r: sum(centered[r]) for r in recs}
CNT = {r: len(centered[r]) for r in recs}


def pooled(chosen):
    return sum(SUM[r] for r in chosen) / sum(CNT[r] for r in chosen)


deltas = [float(x) for x in args.deltas.split(',')]  # true difference in points (pi-tuck minus the comparator)
print(f"\nOne-sided 95% lower bound and P(LB > -{args.margin:g}) by number of recordings n and true difference D ({args.reps} simulated studies, bootstrap over recordings, {args.boot} draws each):")
print(f"{'n':>3} " + " ".join(f"{'D=%+g: medLB / P' % d:>20}" for d in deltas))
for n in [int(x) for x in args.ns.split(',')]:
    cells = []
    for delta in deltas:
        lbs = []
        for _ in range(args.reps):
            chosen = [rng.choice(recs) for _ in range(n)]
            draws = sorted(pooled([rng.choice(chosen) for _ in range(n)]) + delta for _ in range(args.boot))
            lbs.append(draws[int(0.05 * args.boot)])
        lbs.sort()
        cells.append(f"{lbs[len(lbs) // 2]:>8.1f} / {sum(1 for x in lbs if x > -args.margin) / len(lbs):.2f}")
    print(f"{n:>3} " + " ".join(f"{c:>20}" for c in cells))


# Same question with the chain as the cluster: the A and B recordings of one chain hold the same tasks in the same order, so they are not independent.
chains = sorted({r.split("-")[0] for r in recs})
pairs = {c: [r for r in recs if r.startswith(c + "-")] for c in chains}
both = [c for c in chains if len(pairs[c]) == 2]
if len(both) >= 3:
    a = [statistics.fmean(centered[pairs[c][0]]) for c in both]
    b = [statistics.fmean(centered[pairs[c][1]]) for c in both]
    ma, mb = statistics.fmean(a), statistics.fmean(b)
    corr = sum((x - ma) * (y - mb) for x, y in zip(a, b)) / (sum((x - ma) ** 2 for x in a) * sum((y - mb) ** 2 for y in b)) ** 0.5
    print(f"\nChains with both an A and a B recording: {len(both)}; correlation of the per-recording mean difference between the two arms of a chain: {corr:+.2f}")
CSUM = {c: sum(SUM[r] for r in pairs[c]) for c in chains}
CCNT = {c: sum(CNT[r] for r in pairs[c]) for c in chains}
print("\nChain-clustered (resample chains, each carrying its recordings); n recordings = 2 x chains:")
print(f"{'chains':>6} {'recs':>5} " + " ".join(f"{'D=%+g: medLB / P' % d:>20}" for d in deltas))
for nc in [int(x) // 2 for x in args.ns.split(',') if int(x) >= 10]:
    cells = []
    for delta in deltas:
        lbs = []
        for _ in range(args.reps):
            chosen = [rng.choice(chains) for _ in range(nc)]
            draws = []
            for _ in range(args.boot):
                pick = [rng.choice(chosen) for _ in range(nc)]
                draws.append(sum(CSUM[c] for c in pick) / sum(CCNT[c] for c in pick) + delta)
            draws.sort()
            lbs.append(draws[int(0.05 * args.boot)])
        lbs.sort()
        cells.append(f"{lbs[len(lbs) // 2]:>8.1f} / {sum(1 for x in lbs if x > -args.margin) / len(lbs):.2f}")
    print(f"{nc:>6} {2 * nc:>5} " + " ".join(f"{c:>20}" for c in cells))
