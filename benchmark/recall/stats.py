"""Readouts of the recall benchmark (PREREG-RECALL.md).

Usage: stats.py [OUT_DIR] [--boot 10000] [--seed 1]
Arms: native-local, and for each pi-tuck build (101 = 1.0.1, 103 = 1.0.3): tuck, tuck-lexical, tuck-norecall. A question counts for an arm only if the
arm did not keep its evidence in the tail after the cut; a contrast uses the questions usable in both arms. Intervals are one-sided 95% lower bounds from
a bootstrap clustered by recording and, second, by cut; a statement is made only if both clear its threshold."""
import argparse
import json
import random
import statistics
from collections import defaultdict
from pathlib import Path

BENCH = Path(__file__).resolve().parent.parent
RUNS = BENCH / "runs"


def kept_index(rec: str, arm: str, cut: int):
    if arm == "native-local":
        path = RUNS / "replay" / rec / "cuts-native-local.json"
    else:
        build = arm.rsplit("-", 1)[1]
        path = (RUNS / "replay" / rec if build == "101" else RUNS / "recall" / "cuts103" / rec) / "cuts-tuck.json"
    if not path.exists():
        return None
    for row in json.loads(path.read_text())["log"]:
        if row["cut"] == cut:
            return row.get("firstKeptIndex")
    return None


def load(out: Path):
    rows = {}
    for folder in sorted(p for p in out.iterdir() if p.is_dir()):
        for f in folder.glob("*.scores.jsonl"):
            stem = f.name[: -len(".scores.jsonl")]
            wording = stem.rsplit("-", 1)[1]
            arm = stem[: -len(wording) - 1]
            for line in f.read_text().splitlines():
                r = json.loads(line)
                if r["failed"]:
                    continue
                kept = kept_index(folder.name, arm, r["cut"])
                if kept is not None and r["evidenceIndex"] >= kept:
                    continue  # the arm kept the evidence word for word
                rows[(folder.name, arm, wording, r["question"])] = (r["correct"], r["cut"], r["kind"])
    return rows


def interval(items, boot, rng, key):
    """items: [(cluster, value)]; returns mean and the one-sided 95% lower bound, clusters resampled."""
    groups = defaultdict(list)
    for c, v in items:
        groups[key(c)].append(v)
    keys = list(groups)
    draws = []
    for _ in range(boot):
        picked = [v for k in rng.choices(keys, k=len(keys)) for v in groups[k]]
        draws.append(statistics.fmean(picked))
    draws.sort()
    return statistics.fmean(v for _, v in items), draws[int(0.05 * boot)]


def contrast(rows, a, b, wording, boot, rng, label):
    """a minus b on one wording, in points, over questions usable in both."""
    items = []
    for (rec, arm, w, q), (ok, cut, _) in rows.items():
        if arm == a and w == wording and (rec, b, w, q) in rows:
            items.append(((rec, cut), 100 * (ok - rows[(rec, b, w, q)][0])))
    if len(items) < 5:
        print(f"  {label}: n={len(items)} (too few)")
        return None
    m1, lo1 = interval(items, boot, rng, lambda c: c[0])
    m2, lo2 = interval(items, boot, rng, lambda c: c)
    print(f"  {label}: n={len(items)}, {m1:+.1f} pts, lower bound {lo1:+.1f} (by recording) / {lo2:+.1f} (by cut)")
    return items


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("out", nargs="?", default=str(RUNS / "recall" / "out"))
    parser.add_argument("--boot", type=int, default=10000)
    parser.add_argument("--seed", type=int, default=1)
    args = parser.parse_args()
    rng = random.Random(args.seed)
    rows = load(Path(args.out))
    arms = sorted({a for _, a, _, _ in rows})
    print("=== accuracy (% correct, n questions usable for the arm) ===")
    for arm in arms:
        cells = []
        for w in ("close", "paraphrase"):
            v = [ok for (_, a, ww, _), (ok, _, _) in rows.items() if a == arm and ww == w]
            cells.append(f"{w} {100 * statistics.fmean(v):5.1f}% (n={len(v)})" if v else f"{w} n/a")
        print(f"  {arm:22s} " + "   ".join(cells))
    for build in ("101", "103"):
        t, lex, nor = f"tuck-{build}", f"tuck-lexical-{build}", f"tuck-norecall-{build}"
        if t not in arms:
            continue
        print(f"\n=== pi-tuck build {build} ===")
        did = []
        for w in ("close", "paraphrase"):
            contrast(rows, t, lex, w, args.boot, rng, f"1. search by meaning, tuck - tuck-lexical, {w}")
        # difference of differences, per question usable in all four cells
        for (rec, arm, w, q), (ok, cut, _) in list(rows.items()):
            if arm == t and w == "paraphrase":
                cells = [(rec, t, "close", q), (rec, lex, "close", q), (rec, lex, "paraphrase", q)]
                if all(c in rows for c in cells):
                    did.append(((rec, cut), 100 * ((ok - rows[(rec, lex, "paraphrase", q)][0]) - (rows[cells[0]][0] - rows[cells[1]][0]))))
        if len(did) >= 5:
            m1, lo1 = interval(did, args.boot, rng, lambda c: c[0])
            m2, lo2 = interval(did, args.boot, rng, lambda c: c)
            print(f"  1b. paraphrase gain minus close gain: n={len(did)}, {m1:+.1f} pts, lower bound {lo1:+.1f} / {lo2:+.1f}")
        for w in ("close", "paraphrase"):
            contrast(rows, lex, nor, w, args.boot, rng, f"2. keyword recall, tuck-lexical - tuck-norecall, {w}")
        for w in ("close", "paraphrase"):
            contrast(rows, t, "native-local", w, args.boot, rng, f"3. against Pi's built-in summary, tuck - native-local, {w} (threshold -3)")
    print("\n=== by question kind (tuck 1.0.3 where present, else 1.0.1), % correct ===")
    pick = "tuck-103" if "tuck-103" in arms else "tuck-101"
    kinds = defaultdict(lambda: defaultdict(list))
    for (rec, arm, w, q), (ok, cut, kind) in rows.items():
        if arm in (pick, "native-local"):
            kinds[kind][(arm, w)].append(ok)
    for kind, cells in sorted(kinds.items(), key=lambda kv: -sum(len(v) for v in kv[1].values())):
        print(f"  {kind[:24]:24s} " + "  ".join(f"{a.replace('-local','')[:12]}/{w[:4]} {100 * statistics.fmean(v):4.0f}% ({len(v)})" for (a, w), v in sorted(cells.items())))


if __name__ == "__main__":
    main()
