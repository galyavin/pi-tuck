"""Draw the task chains: SWE-bench Verified instances that have an Epoch AI arm64 image and an estimated difficulty under one hour,
shuffled with a fixed seed. Main sessions take chunks of 30 from the front; pilot sessions take chunks of 8 from the back, so the two
never share a task. Writes data/sessions.json."""
import json
import random
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import BENCH, IMAGE, dataset  # noqa: E402

SEED = 20261030
MAIN_SESSIONS, MAIN_LENGTH = 10, 30
PILOT_SESSIONS, PILOT_LENGTH = 2, 8


def has_image(instance: str) -> bool:
    return subprocess.run(["docker", "manifest", "inspect", IMAGE.format(instance)], capture_output=True).returncode == 0


rows = dataset()
easy = sorted(i for i, r in rows.items() if r["difficulty"] in ("<15 min fix", "15 min - 1 hour"))
with ThreadPoolExecutor(24) as pool:
    eligible = [i for i, ok in zip(easy, pool.map(has_image, easy)) if ok]
random.Random(SEED).shuffle(eligible)
sessions = {f"s{n + 1:02d}": eligible[n * MAIN_LENGTH:(n + 1) * MAIN_LENGTH] for n in range(MAIN_SESSIONS)}
for n in range(PILOT_SESSIONS):
    sessions[f"p{n + 1:02d}"] = eligible[len(eligible) - (n + 1) * PILOT_LENGTH:len(eligible) - n * PILOT_LENGTH]
(BENCH / "data").mkdir(exist_ok=True)
(BENCH / "data" / "sessions.json").write_text(json.dumps({"seed": SEED, "eligible": len(eligible), "sessions": sessions}, indent=1))
print(len(easy), len(eligible), {k: len(v) for k, v in sessions.items()})
