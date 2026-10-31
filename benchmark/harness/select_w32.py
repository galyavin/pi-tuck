"""Draw the 32k suite's chains (PREREG-32K.md): chains t01-t05 of 30 tasks, seed 20261031, from the eligible instances no running or future main chain
uses -- the 61 the main draw left over, the pilot's 16 and the 90 of main chains s01-s03, which are finished and whose images are gone. Disjoint
from s04-s10, so the two suites never fight over a task image. Adds t01-t03 to data/sessions.json (idempotent)."""
import json
import random
from pathlib import Path

import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, str(Path(__file__).parent))
from common import IMAGE, dataset  # noqa: E402

path = Path(__file__).resolve().parent.parent / "data" / "sessions.json"
data = json.loads(path.read_text())
rows = dataset()
easy = sorted(i for i, r in rows.items() if r["difficulty"] in ("<15 min fix", "15 min - 1 hour"))
with ThreadPoolExecutor(24) as pool_:
    eligible = [i for i, ok in zip(easy, pool_.map(lambda i: subprocess.run(["docker", "manifest", "inspect", IMAGE.format(i)], capture_output=True).returncode == 0, easy)) if ok]
assert len(eligible) == data["eligible"], (len(eligible), data["eligible"])
busy = {i for s, t in data["sessions"].items() if s[0] == "s" and s not in ("s01", "s02", "s03") for i in t}
pool = sorted(set(eligible) - busy)
random.Random(20261031).shuffle(pool)
for n in range(5):
    data["sessions"][f"t{n + 1:02d}"] = pool[n * 30:(n + 1) * 30]
data["w32"] = {"seed": 20261031, "pool": len(pool), "sessions": [f"t{n + 1:02d}" for n in range(5)]}
if "--second" in sys.argv:
    # Chains t06-t10, once the main run has finished and freed its images: the 17 pool tasks no chain took plus the tasks of s04-s10, same seed.
    later = sorted(set(pool[150:]) | {i for s, t in data["sessions"].items() if s in [f"s{n:02d}" for n in range(4, 11)] for i in t})
    random.Random(20261031).shuffle(later)
    for n in range(5):
        data["sessions"][f"t{n + 6:02d}"] = later[n * 30:(n + 1) * 30]
    data["w32"]["sessions"] += [f"t{n + 6:02d}" for n in range(5)]
path.write_text(json.dumps(data, indent=1))
print(len(pool), {k: len(v) for k, v in data["sessions"].items() if k[0] == "t"})
