"""The LongMemEval-S subset of PREREG-LME.md: 100 questions, stratified by type in proportion (largest remainder, ties to the larger type), drawn
inside each type with seed 20261031. Writes lme/subset.json (ids only; the data stays outside git).
Usage: python -I lme/select.py DATA.json"""
import json
import random
import sys
from collections import Counter
from pathlib import Path

SEED, TOTAL = 20261031, 100
data = json.loads(Path(sys.argv[1]).read_text())
by_type = {}
for q in data:
    by_type.setdefault(q["question_type"], []).append(q["question_id"])
sizes = {t: len(ids) for t, ids in by_type.items()}
exact = {t: TOTAL * n / len(data) for t, n in sizes.items()}
alloc = {t: int(x) for t, x in exact.items()}
for t in sorted(sizes, key=lambda t: (-(exact[t] - alloc[t]), -sizes[t], t))[: TOTAL - sum(alloc.values())]:
    alloc[t] += 1
rng = random.Random(SEED)
chosen = []
for t in sorted(by_type):
    chosen += rng.sample(sorted(by_type[t]), alloc[t])
Path(__file__).with_name("subset.json").write_text(json.dumps({"seed": SEED, "allocation": alloc, "abstention": sum(i.endswith("_abs") for i in chosen), "ids": chosen}, indent=1) + "\n")
print(alloc, "abstention", sum(i.endswith("_abs") for i in chosen), Counter(t for t in alloc.values()))
