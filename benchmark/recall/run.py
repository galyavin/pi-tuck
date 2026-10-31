"""Run the recall benchmark (PREREG-RECALL.md) as one resumable pipeline per recording; recordings run in parallel. A step whose output file exists is skipped.

Usage: run.py [--workers 2] [--recordings s01-A,s01-B,...]
Steps per recording: questions, pi-tuck 1.0.3 cuts at the same positions, then for each (build, variant, wording) the answers and their scores."""
import argparse
import shlex
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

BENCH = Path(__file__).resolve().parent.parent
JITI = str(BENCH.parent / "node_modules" / ".bin" / "jiti")
RUNS = BENCH / "runs"
OUT = RUNS / "recall"
BUILDS = {"101": RUNS / "tuck-1.0.1", "103": RUNS / "tuck-1.0.3"}
WORDINGS = ("close", "paraphrase")


def run(cmd: str, done: Path, log):
    if done.exists():
        return True
    started = time.time()
    ok = subprocess.run(["sh", "-c", cmd], stdout=log, stderr=log, cwd=BENCH).returncode == 0 and done.exists()
    print(f"{time.strftime('%H:%M:%S')} {'ok  ' if ok else 'FAIL'} {done.relative_to(RUNS)} {time.time() - started:.0f}s", flush=True)
    return ok


def pipeline(rec: str, log):
    recording, replay = RUNS / "recordings" / f"{rec}.jsonl", RUNS / "replay" / rec
    out = OUT / "out" / rec
    out.mkdir(parents=True, exist_ok=True)
    q = out / "questions.json"
    cuts103 = OUT / "cuts103" / rec
    cuts103.mkdir(parents=True, exist_ok=True)
    steps = [(f"{JITI} recall/questions.ts {shlex.quote(str(recording))} {shlex.quote(str(replay / 'cuts-tuck.json'))} {shlex.quote(str(q))}", q),
             (f"{JITI} replay/cuts.ts {shlex.quote(str(recording))} {shlex.quote(str(cuts103))} --variants tuck --tuck-dir {BUILDS['103']}", cuts103 / "cuts-tuck.json")]
    for cmd, done in steps:
        if not run(cmd, done, log):
            return rec, "failed before answers"
    jobs = [("native-local", None, replay / "cuts-native-local.json")]
    for build in BUILDS:
        for variant in ("tuck", "tuck-lexical", "tuck-norecall"):
            jobs.append((variant, build, (replay if build == "101" else cuts103) / "cuts-tuck.json"))
    failed = 0
    for variant, build, cuts in jobs:
        for wording in WORDINGS:
            name = f"{variant}-{build}-{wording}" if build else f"{variant}-{wording}"
            answers, scores = out / f"{name}.answers.jsonl", out / f"{name}.scores.jsonl"
            tuck = f"--tuck-dir {BUILDS[build]}" if build else ""
            cmd = (f"rm -f {answers}; {JITI} recall/answer.ts {shlex.quote(str(recording))} {shlex.quote(str(cuts))} {q} {answers} --wording {wording} --variant {variant} {tuck}"
                   f" && {JITI} recall/score.ts {q} {answers} {scores}")
            failed += not run(cmd, scores, log)
    return rec, f"{failed} failed steps"


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--recordings", default="s01-A,s01-B,s02-A,s02-B,s03-A,s03-B")
    args = parser.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    log = open(OUT / "run.log", "a")
    with ThreadPoolExecutor(args.workers) as pool:
        for rec, status in pool.map(lambda r: pipeline(r, log), args.recordings.split(",")):
            print(rec, status, flush=True)
