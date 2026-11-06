"""Scheduler for the re-measure of retention on pi-tuck 1.0.11 (PREREG-REMEASURE.md): 95 answer sets for each of `tuck` and `tuck-lexical`, with Pi's compaction on.
Usage: remeasure_scheduler.py            (from anywhere; resumable: a set with an output file is skipped; safe to stop at any moment, only the sets in flight are lost)
The number of mac-studio lanes is read from runs/remeasure-1011/LANES (default 8) every 20 s and counts every abortcheck.ts job on this machine, so another run of mine shares the total.
At most 2 `tuck` sets (meaning search; the encoder runs on this machine) run at once. Order: cuts 5 to 8 first, then 4 to 1. The server load is sampled every 60 s into load.log."""
import json
import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path

BENCH = Path(__file__).resolve().parent.parent
os.chdir(BENCH)
OUT = Path("runs/remeasure-1011")
(OUT / "logs").mkdir(parents=True, exist_ok=True)
for v in ("tuck", "tuck-lexical"):
    (OUT / v).mkdir(exist_ok=True)
JITI = str(BENCH.parent / "node_modules" / ".bin" / "jiti")
PROC = re.compile(r"abortcheck\.ts runs/recordings/s\d+-[AB]\.jsonl")
host = os.environ.get("MAC_STUDIO_HOST") or __import__("urllib.parse", fromlist=["urlparse"]).urlparse(
    json.load(open("runs/agent/B/models.json"))["providers"]["mac-studio"]["baseUrl"]).hostname


def running_total() -> int:
    ps = subprocess.run(["ps", "-axo", "command"], capture_output=True, text=True).stdout
    return sum(1 for line in ps.splitlines() if PROC.search(line) and "pgrep" not in line and "grep" not in line)


def lanes() -> int:
    try:
        return int((OUT / "LANES").read_text().strip())
    except Exception:
        return 8


def connections() -> int:
    r = subprocess.run(["lsof", "-nP", f"-iTCP@{host}", "-sTCP:ESTABLISHED"], capture_output=True, text=True)
    return max(0, len(r.stdout.splitlines()) - 1)


jobs = []
for cut in [5, 6, 7, 8, 4, 3, 2, 1]:
    for rec_dir in sorted(Path("runs/replay-1011").glob("s*")):
        cuts = json.load(open(rec_dir / "cuts-tuck.json"))["cuts"]
        if cut <= len(cuts):
            for variant in ("tuck", "tuck-lexical"):
                if not (OUT / variant / f"{rec_dir.name}-cut{cut}.jsonl").exists():
                    jobs.append((variant, rec_dir.name, cut))
children = []  # (popen, variant)


def stop(*_):
    for p, _v in children:
        p.terminate()
    sys.exit(1)


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
last_sample = 0.0
print(f"{time.strftime('%H:%M:%S')} {len(jobs)} sets to do, lanes {lanes()}", flush=True)
while jobs or any(p.poll() is None for p, _ in children):
    children[:] = [(p, v) for p, v in children if p.poll() is None]
    if time.time() - last_sample >= 60:
        with open(OUT / "load.log", "a") as f:
            f.write(f"{time.strftime('%H:%M:%S')} lanes_allowed={lanes()} abortcheck_runs={running_total()} server_connections={connections()}\n")
        last_sample = time.time()
    semantic = sum(1 for _, v in children if v == "tuck")
    while jobs and running_total() < lanes():
        pick = next((j for j in jobs if not (j[0] == "tuck" and semantic >= 2)), None)
        if pick is None:
            break
        jobs.remove(pick)
        variant, rec, cut = pick
        out = OUT / variant / f"{rec}-cut{cut}.jsonl"
        log = open(OUT / "logs" / f"{variant}-{rec}-cut{cut}.log", "w")
        log.write(f"{time.strftime('%H:%M:%S')} start {variant} {rec} cut {cut}\n"); log.flush()
        cmd = [JITI, "replay/abortcheck.ts", f"runs/recordings/{rec}.jsonl", f"runs/replay-1011/{rec}", f"runs/replay/{rec}/probes.json", str(out),
               "--agent", "mac-studio/main:xhigh", "--variant", variant, "--cuts", str(cut), "--tuck-dir", "runs/tuck-1.0.11", "--compaction", "on", "--wall-minutes", "60"]
        children.append((subprocess.Popen(cmd, stdout=log, stderr=subprocess.STDOUT), variant))
        semantic += variant == "tuck"
        time.sleep(3)
    time.sleep(20)
print(f"{time.strftime('%H:%M:%S')} runner done", flush=True)
