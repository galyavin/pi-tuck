"""Replay one more pi-tuck build as a variant over every recording (PREREG-V103.md): its cuts at the main replay's raw positions, then the probes answered and scored,
resumable like run_replay.py (a job whose output exists is skipped). The local server is shared, so answers run `--slots` at a time (default 1).

Usage: run_variant.py --variant tuck-103 --tuck runs/tuck-1.0.3 [--agents mac-studio/main:xhigh] [--slots 1] [--expected 20]"""
import argparse
import shlex
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

BENCH = Path(__file__).resolve().parent.parent
JITI = str(BENCH.parent / "node_modules" / ".bin" / "jiti")
RUNS = BENCH / "runs"


def tag(agent: str) -> str:
    return agent.replace("/", "_").replace(":", "_")


def job(cmd: str, done: Path, log) -> bool:
    if done.exists():
        return True
    started = time.time()
    ok = subprocess.run(["sh", "-c", cmd], stdout=log, stderr=log, cwd=BENCH).returncode == 0 and done.exists()
    print(f"{time.strftime('%H:%M:%S')} {'ok  ' if ok else 'FAIL'} {done.relative_to(RUNS)} {time.time() - started:.0f}s", flush=True)
    return ok


def one(rec: Path, args, log):
    d = RUNS / "replay" / rec.stem
    q = shlex.quote
    if not job(f"{JITI} replay/cuts.ts {q(str(rec))} {q(str(d))} --variants {args.variant} --tuck-dir {q(str(Path(args.tuck).resolve()))}", d / f"cuts-{args.variant}.json", log):
        return rec.stem, False
    ok = True
    for agent in args.agents.split(","):
        answers, scores = d / f"answers-{tag(agent)}-{args.variant}.jsonl", d / f"scores-{tag(agent)}-{args.variant}.jsonl"
        cmd = (f"rm -f {q(str(answers))}; {JITI} replay/answer.ts {q(str(rec))} {q(str(d))} {q(str(d / 'probes.json'))} {q(str(answers))} --agent {q(agent)} --variant {args.variant}"
               f" --tuck-dir {q(str(Path(args.tuck).resolve()))} && {JITI} replay/score.ts {q(str(d / 'probes.json'))} {q(str(answers))} {q(str(scores))}")
        ok &= job(cmd, scores, log)
    return rec.stem, ok


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--variant", required=True)
    parser.add_argument("--tuck", required=True)
    parser.add_argument("--agents", default="mac-studio/main:xhigh")
    parser.add_argument("--slots", type=int, default=1)
    parser.add_argument("--expected", type=int, default=20)
    args = parser.parse_args()
    log = open(RUNS / "replay" / f"run_variant_{args.variant}.log", "a")
    done: set[str] = set()
    failed: set[str] = set()
    with ThreadPoolExecutor(args.slots) as pool:
        pending = {}
        while len(done) + len(failed) < args.expected:
            for rec in sorted((RUNS / "recordings").glob("*.jsonl")):
                if rec.stem not in done and rec.stem not in failed and rec.stem not in pending and (RUNS / "replay" / rec.stem / "probes.json").exists():
                    pending[rec.stem] = pool.submit(one, rec, args, log)
            for name, future in list(pending.items()):
                if future.done():
                    (done if future.result()[1] else failed).add(name)
                    del pending[name]
            time.sleep(30)
    print("finished", len(done), "done,", sorted(failed), "failed", flush=True)
