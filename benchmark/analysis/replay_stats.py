"""Paired-replay statistics: PREREG claim 1 (retention) plus the latency and carried-size tables for claim 3.

Usage: replay_stats.py SCORES_DIR [--margin 3] [--boot 10000] [--seed 1]
SCORES_DIR holds one folder per recording, each with scores-<agent>.jsonl and cuts.json (the harness's layout)."""
import argparse
import json
import random
import statistics
from collections import defaultdict
from pathlib import Path

SUT = "tuck"
LLMS = ["native-terra", "native-local"]
PARTIAL = False
Z_ALPHA, Z_BETA = 1.645, 0.842


def load(root: Path):
    """rows: every scored probe; cuts[rec][variant]: that variant's cuts file; evidence[rec][probe]: the probe's evidence index."""
    rows, cuts, evidence = [], defaultdict(dict), defaultdict(dict)
    for folder in sorted(p for p in root.iterdir() if p.is_dir()):
        for f in folder.glob("cuts-*.json"):
            data = json.loads(f.read_text())
            cuts[folder.name][data["variant"]] = data
        if (folder / "probes.json").exists():
            for p in json.loads((folder / "probes.json").read_text()):
                evidence[folder.name][p["id"]] = p["evidenceIndex"]
        for scores in folder.glob("scores-*.jsonl"):
            for line in scores.read_text().splitlines():
                if line.strip():
                    rows.append({**json.loads(line), "rec": folder.name})
    return rows, cuts, evidence


def usable(row, cuts, evidence, *variants):
    """A probe counts for a variant only if that variant did not keep its evidence in the tail it left after the cut."""
    for v in variants:
        source = "tuck" if v in ("tuck-lexical", "tuck-norecall") else v
        log = cuts[row["rec"]].get(source, {}).get("log", [])
        if row["cut"] > len(log) or "firstKeptIndex" not in log[row["cut"] - 1]:
            return False
        if evidence[row["rec"]].get(row["probe"], 10**9) >= log[row["cut"] - 1]["firstKeptIndex"]:
            return False
    return True


def paired(rows, agent, a, b, cuts, evidence):
    """Per recording, the probe outcomes both variants were asked: {rec: [(a_correct, b_correct, row)]}."""
    index = defaultdict(dict)
    for r in rows:
        if r["agent"] == agent and not r["failed"]:
            index[(r["rec"], r["cut"], r["probe"])][r["variant"]] = r
    out = defaultdict(list)
    for (rec, _cut, _probe), by in index.items():
        if a in by and b in by and usable(by[a], cuts, evidence, a, b):
            out[rec].append((by[a]["correct"], by[b]["correct"], by[a]))
    return out


def diff(by_rec, recs):
    num = den = 0
    for rec in recs:
        for x, y, _ in by_rec[rec]:
            num += x - y
            den += 1
    return 100 * num / den if den else float("nan")


def bootstrap(by_rec, boot, rng):
    recs = list(by_rec)
    draws = sorted(diff(by_rec, [rng.choice(recs) for _ in recs]) for _ in range(boot))
    return draws


def chain_bootstrap(by_rec, boot, rng):
    """PREREG-CLUSTER.md: the robustness bootstrap. The A and B recordings of one chain hold the same tasks, so the chain is resampled with its recordings together."""
    chains = defaultdict(list)
    for rec in by_rec:
        chains[rec.split("-")[0]].append(rec)
    keys = list(chains)
    draws = sorted(diff(by_rec, [r for c in (rng.choice(keys) for _ in keys) for r in chains[c]]) for _ in range(boot))
    return draws


def report(rows, cuts, evidence, margin, boot, seed):
    rows = [r for r in rows if not r["failed"] and usable(r, cuts, evidence, r["variant"])]
    rng = random.Random(seed)
    agents = sorted({r["agent"] for r in rows})
    verdicts, robust = {}, {}
    for agent in agents:
        print(f"\n=== agent {agent} ===")
        for variant in [SUT, "tuck-lexical", *LLMS]:
            sel = [r for r in rows if r["agent"] == agent and r["variant"] == variant]
            if sel:
                print(f"  accuracy {variant:16s} {100 * sum(r['correct'] for r in sel) / len(sel):5.1f}%  (n={len(sel)} probes, {len({r['rec'] for r in sel})} recordings)")
        # The comparator is the LLM summary with the higher accuracy on the probes it shares with the system under test.
        best, best_acc = None, -1
        for llm in LLMS:
            pairs = paired(rows, agent, SUT, llm, cuts, evidence)
            if not pairs:
                continue
            n = sum(len(v) for v in pairs.values())
            acc = sum(y for v in pairs.values() for _, y, _ in v) / n
            if acc > best_acc:
                best, best_acc = llm, acc
        if not best:
            continue
        for llm in LLMS:
            by_rec = paired(rows, agent, SUT, llm, cuts, evidence)
            if not by_rec:
                continue
            n = sum(len(v) for v in by_rec.values())
            d = diff(by_rec, list(by_rec))
            draws = bootstrap(by_rec, boot, rng)
            lower, upper = draws[int(0.05 * boot)], draws[int(0.95 * boot)]
            lower_c = chain_bootstrap(by_rec, boot, rng)[int(0.05 * boot)]
            discord = sum(1 for v in by_rec.values() for x, y, _ in v if x != y) / n
            se = statistics.pstdev(draws) / 100
            target = margin / 100 / (Z_ALPHA + Z_BETA)
            need = n * (se / target) ** 2
            mark = "  <- comparator" if llm == best else ""
            print(f"  {SUT} - {llm}: {d:+.1f} pts, one-sided 95% lower bound {lower:+.1f} (chain-clustered robustness bound {lower_c:+.1f}); paired disagreement {100 * discord:.0f}% of {n} probes; "
                  f"probes needed for a {margin}-pt bound at 80% power (cluster-aware): {need:,.0f}{mark}")
            if llm == best:
                verdicts[agent] = lower > -margin
                robust[agent] = lower_c > -margin
        mech = [r for r in rows if r["agent"] == agent and r["type"] != "next_step"]
        for llm in [best]:
            by_rec = defaultdict(list)
            idx = defaultdict(dict)
            for r in mech:
                idx[(r["rec"], r["cut"], r["probe"])][r["variant"]] = r
            for (rec, _, _), by in idx.items():
                if SUT in by and llm in by:
                    by_rec[rec].append((by[SUT]["correct"], by[llm]["correct"], by[SUT]))
            if by_rec:
                draws = bootstrap(by_rec, boot, rng)
                print(f"  mechanical probes only, {SUT} - {llm}: {diff(by_rec, list(by_rec)):+.1f} pts, lower bound {draws[int(0.05 * boot)]:+.1f}")
        print("  by probe type (accuracy %, tuck / " + "/".join(LLMS) + "):")
        for t in sorted({r["type"] for r in rows}):
            cells = []
            for variant in [SUT, *LLMS]:
                sel = [r for r in rows if r["agent"] == agent and r["variant"] == variant and r["type"] == t]
                cells.append(f"{100 * sum(r['correct'] for r in sel) / len(sel):5.1f}" if sel else "  n/a")
            print(f"    {t:14s} {' / '.join(cells)}")
        print("  drift, by cut number (accuracy %, tuck / " + "/".join(LLMS) + "):")
        for k in sorted({r["cut"] for r in rows}):
            cells = []
            for variant in [SUT, *LLMS]:
                sel = [r for r in rows if r["agent"] == agent and r["variant"] == variant and r["cut"] == k]
                cells.append(f"{100 * sum(r['correct'] for r in sel) / len(sel):5.1f} (n={len(sel)})" if sel else "  n/a")
            print(f"    cut {k}: {' / '.join(cells)}")
    if verdicts and not PARTIAL:
        passed = all(verdicts.values())
        print(f"\nCLAIM 1 ({SUT} no more than {margin} pts below the best LLM summary, one-sided 95%): "
              + ("SUPPORTED" if passed else "NOT SUPPORTED") + "  " + json.dumps(verdicts))
        same = all(verdicts[a] == robust[a] for a in verdicts)
        print("  chain-clustered robustness bound (PREREG-CLUSTER.md): " + ("agrees with the registered bound on clearing the margin  " if same else "DISAGREES with the registered bound on clearing the margin  ") + json.dumps(robust))


def cut_tables(cuts):
    print("\n=== per-cut latency and context carried after the cut (replay) ===")
    by = defaultdict(list)
    for rec, variants in cuts.items():
        for variant, data in variants.items():
            for row in data["log"]:
                if "ms" in row:
                    by[variant].append(row)
    for variant, rows in by.items():
        ms = sorted(r["ms"] for r in rows)
        print(f"  {variant:16s} cuts={len(rows):3d}  latency median {statistics.median(ms) / 1000:8.3f}s  p90 {ms[int(0.9 * (len(ms) - 1))] / 1000:8.3f}s  "
              f"carried median {statistics.median(r['carriedTokens'] for r in rows):8.0f} tokens  summary median {statistics.median(r['summaryChars'] for r in rows):8.0f} chars")
    refused = sum(1 for v in cuts.values() for d in v.values() for r in d["log"] if "refused" in r)
    print(f"  refused or failed cuts: {refused}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("root")
    parser.add_argument("--margin", type=float, default=3.0)
    parser.add_argument("--boot", type=int, default=10000)
    parser.add_argument("--seed", type=int, default=1)
    parser.add_argument("--sut", default="tuck", help="the pi-tuck variant under test, e.g. tuck-lean")
    parser.add_argument("--llms", help="comma-separated LLM compactor variants, default native-terra,native-local")
    parser.add_argument("--partial", action="store_true", help="print a labelled partial view and no claim line (e.g. the withdrawn astra recordings)")
    args = parser.parse_args()
    SUT = args.sut
    if args.llms:
        LLMS[:] = args.llms.split(",")
    PARTIAL = args.partial
    if PARTIAL:
        print("PARTIAL VIEW, NOT A TEST: " + ", ".join(LLMS))
    rows, cuts, evidence = load(Path(args.root))
    report(rows, cuts, evidence, args.margin, args.boot, args.seed)
    cut_tables(cuts)
