"""Run the main live sessions: for each chain, arms A and B side by side (they share the task images), then remove that chain's images.

Usage: run_live_all.py --tuck PATH [--sessions s01,s02,...] [--pairs 2] [--suite w32 --arms ABT --tuck-tail PATH]
--pairs is how many chains run at once (each is two Pi sessions against mac-studio). A chain with a finished stats.json is skipped, so the
script resumes after an interruption; a half-finished chain is redone from its start."""
import argparse
import json
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from common import RUNS, SUITES  # noqa: E402


def finished(session: str, arm: str, root: str = "live") -> int:
    """How many tasks of the chain this arm has finished, grading included (live.py writes a record only then)."""
    path = RUNS / root / f"{session}-{arm}" / "tasks.jsonl"
    return sum(1 for line in path.read_text().splitlines() if line.strip()) if path.exists() else 0


def prune(session: str, tasks: list[str], removed: int, root: str = "live", arms: str = "AB") -> int:
    """Remove the images of tasks every arm has finished: a chain's images would otherwise take 90 GB."""
    both = min(finished(session, arm, root) for arm in arms)
    if both > removed:
        subprocess.run([str(HERE / "cleanup_images.sh"), *tasks[removed:both]])
    return max(both, removed)


def chain(session: str, tasks: list[str], tucks: dict[str, str], suite: str = "main", arms: str = "AB"):
    root = SUITES[suite]["root"]
    out = {arm: RUNS / root / f"{session}-{arm}" for arm in arms}
    if all((o / "stats.json").exists() for o in out.values()):
        return session, "skipped"
    for o in out.values():
        shutil.rmtree(o, ignore_errors=True)
    procs = []
    for arm in arms:
        cmd = [sys.executable, str(HERE / "live.py"), "--arm", arm, "--session", session, "--tasks", ",".join(tasks), "--suite", suite]
        if arm in tucks:
            cmd += ["--tuck", tucks[arm]]
        out[arm].parent.mkdir(parents=True, exist_ok=True)
        procs.append(subprocess.Popen(cmd, stdout=open(RUNS / root / f"{session}-{arm}.out", "w"), stderr=subprocess.STDOUT))
    removed = 0
    while any(p.poll() is None for p in procs):
        time.sleep(60)
        removed = prune(session, tasks, removed, root, arms)
    codes = [p.returncode for p in procs]
    subprocess.run([str(HERE / "cleanup_images.sh"), *tasks])
    errors = {arm: sum(1 for l in (out[arm] / "tasks.jsonl").read_text().splitlines() if l.strip() and json.loads(l).get("ended_in_error")) if (out[arm] / "tasks.jsonl").exists() else -1 for arm in arms}
    return session, f"exit {codes}, tasks ended in a provider error {errors}"


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--tuck", required=True)
    parser.add_argument("--sessions")
    parser.add_argument("--pairs", type=int, default=2)
    parser.add_argument("--suite", default="main", choices=sorted(SUITES))
    parser.add_argument("--arms", default="AB")
    parser.add_argument("--tuck-tail", help="arm T: pi-tuck with the small-window tail fix (PREREG-32K)")
    args = parser.parse_args()
    plan = json.loads((HERE.parent / "data" / "sessions.json").read_text())["sessions"]
    prefix = "s" if args.suite == "main" else "t"
    wanted = args.sessions.split(",") if args.sessions else [s for s in plan if s.startswith(prefix)]
    tucks = {"B": args.tuck, **({"T": args.tuck_tail} if args.tuck_tail else {})}
    with ThreadPoolExecutor(args.pairs) as pool:
        for session, status in pool.map(lambda s: chain(s, plan[s], tucks, args.suite, args.arms), wanted):
            print(session, status, flush=True)
