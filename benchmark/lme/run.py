"""Run LongMemEval (PREREG-LME.md) as resumable stages; every step skips what its output file already holds.

Usage: run.py [--questions N]   (N limits to the first N subset questions, for a smoke run)
Stage 0: the pi-tuck cuts for each (window, build), model-free. Then two streams in parallel (nice'd; the machine is shared with the main run):
  T (embedding, the slow one): `tuck` answers, in the order 1.0.3@32k, 1.0.3@64k, 1.0.1@32k, 1.0.1@64k.
  C (cheap): native cuts and answers, the full-history ceiling, `tuck-lexical` and `tuck-norecall`, and the judging of every answers file."""
import argparse
import json
import shlex
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

BENCH = Path(__file__).resolve().parent.parent
JITI = str(BENCH.parent / "node_modules" / ".bin" / "jiti")
RUNS = BENCH / "runs"
OUT = RUNS / "lme"
REC = OUT / "rec"
BUILDS = {"103": RUNS / "tuck-1.0.3", "101": RUNS / "tuck-1.0.1"}
WINDOWS = {"w32": dict(window=32768, reserve=16384, keep=3333), "w64": dict(window=65536, reserve=16384, keep=10000)}
ORDER = [("w32", "103"), ("w64", "103"), ("w32", "101"), ("w64", "101")]
LOG = OUT / "run.log"
LOCK = threading.Lock()


def sh(cmd: str, stage: str):
    started = time.time()
    r = subprocess.run(["sh", "-c", f"nice -n 19 {cmd}"], cwd=BENCH, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    with LOCK, open(LOG, "a") as f:
        f.write(f"{time.strftime('%H:%M:%S')} {'ok  ' if r.returncode == 0 else 'FAIL'} {stage} {time.time() - started:.0f}s\n")
        if r.returncode:
            f.write(r.stderr[-1500:] + "\n")
    return r.returncode == 0


def cuts(qids, w, build, workers=1):
    """Native cuts call the model and run `workers` questions at a time; pi-tuck's cuts are model-free and run one at a time."""
    cfg = WINDOWS[w]

    def one(q):
        if build == "native":
            done, extra = OUT / "cuts" / w / "native" / q / "cuts-native.json", "--variants native"
        else:
            done, extra = OUT / "cuts" / w / f"tuck-{build}" / q / "cuts-tuck.json", f"--variants tuck --tuck-dir {BUILDS[build]}"
        if not done.exists():
            sh(f"{JITI} lme/cuts.ts {REC / (q + '.jsonl')} {done.parent} --window {cfg['window']} --reserve {cfg['reserve']} --keep-recent {cfg['keep']} {extra}", f"cuts {w} {build} {q}")

    with ThreadPoolExecutor(workers) as pool:
        list(pool.map(one, qids))


def answer_and_score(qids, name, variant, root, tuck=None):
    answers, scores = OUT / "out" / f"{name}.answers.jsonl", OUT / "out" / f"{name}.scores.jsonl"
    answers.parent.mkdir(parents=True, exist_ok=True)
    flag = f"--tuck-dir {tuck}" if tuck else ""
    sh(f"{JITI} lme/answer.ts {REC} {REC / 'questions.json'} {root} {answers} --variant {variant} {flag} --qids {','.join(qids)}", f"answers {name}")
    if answers.exists():
        sh(f"{JITI} lme/score.ts {REC / 'questions.json'} {answers} {scores}", f"scores {name}")


def stream_t(qids):
    for w, b in ORDER:
        answer_and_score(qids, f"{w}/tuck-{b}/tuck", "tuck", OUT / "cuts" / w / f"tuck-{b}", BUILDS[b])


def stream_c(qids):
    answer_and_score(qids, "full", "full", OUT / "cuts" / "w32" / "native")
    for w in WINDOWS:
        cuts(qids, w, "native", workers=6)
        answer_and_score(qids, f"{w}/native", "native", OUT / "cuts" / w / "native")
    for w, b in ORDER:
        for v in ("tuck-lexical", "tuck-norecall"):
            answer_and_score(qids, f"{w}/tuck-{b}/{v}", v, OUT / "cuts" / w / f"tuck-{b}", BUILDS[b])


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--questions", type=int, default=100)
    args = parser.parse_args()
    qids = json.loads((BENCH / "lme" / "subset.json").read_text())["ids"][: args.questions]
    LOG.parent.mkdir(parents=True, exist_ok=True)
    for w, b in ORDER:
        cuts(qids, w, b)
    threads = [threading.Thread(target=stream_t, args=(qids,)), threading.Thread(target=stream_c, args=(qids,))]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    print("done", flush=True)
