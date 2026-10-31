"""Paired replay of every recording, as a resumable job queue. A job whose output file exists is skipped, so the script resumes after an
interruption; plan-billed (frontier) jobs wait out a usage cap inside their own process (replay/lib.ts untilNotCapped).

Usage: run_replay.py RECORDINGS_DIR OUT_DIR --tuck PATH [--collect LIVE_DIR --expected 20] [--agents A,B] [--pilot] [--slots-file F]
RECORDINGS_DIR holds <name>.jsonl session files. With --collect, finished live sessions are copied there as they appear and the queue keeps
running until --expected recordings are done. Slots (parallel jobs) come from --slots-file (JSON {"local": n, "plan": n, "cpu": n}), re-read
every cycle, so the load on mac-studio can follow the live runs.

Priorities: frontier summaries (cuts:native-frontier) come first, in recording-name order, because the claim is about the best summarizer; frontier
*agent* sessions (resource "plan-agent") start only once every expected frontier summary exists, spending whatever quota is left."""
import argparse
import json
import shlex
import shutil
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

BENCH = Path(__file__).resolve().parent.parent
JITI = str(BENCH.parent / "node_modules" / ".bin" / "jiti")
REPLAY = str(BENCH / "replay")
VARIANTS = ["tuck", "tuck-lexical", "native-local", "native-frontier"]
LOCAL_AGENT, PLAN_AGENT = "mac-studio/main:xhigh", "openai/gpt-6-astra:medium"


def tag(agent: str) -> str:
    return agent.replace("/", "_").replace(":", "_")


def jobs_for(rec: Path, out: Path, tuck: str, agents: list[str], extra: str):
    """(name, resource, command, done_file, needs) for one recording."""
    d = out / rec.stem
    jit = f"{shlex.quote(JITI)} {shlex.quote(REPLAY)}"
    r, o, t = shlex.quote(str(rec)), shlex.quote(str(d)), shlex.quote(tuck)
    jobs = [(f"{rec.stem}:probes", "cpu", f"{jit}/probes.ts {r} {o}/probes.json {extra}", d / "probes.json", []),
            (f"{rec.stem}:cuts:tuck", "cpu", f"{jit}/cuts.ts {r} {o} --variants tuck --tuck-dir {t} {extra}", d / "cuts-tuck.json", []),
            (f"{rec.stem}:cuts:native-local", "local", f"{jit}/cuts.ts {r} {o} --variants native-local --tuck-dir {t} {extra}", d / "cuts-native-local.json", []),
            (f"{rec.stem}:cuts:native-frontier", "plan", f"{jit}/cuts.ts {r} {o} --variants native-frontier --tuck-dir {t} {extra}", d / "cuts-native-frontier.json", [])]
    for agent in agents:
        for variant in VARIANTS:
            source = "tuck" if variant == "tuck-lexical" else variant
            ans, sc = shlex.quote(str(d / f"answers-{tag(agent)}-{variant}.jsonl")), d / f"scores-{tag(agent)}-{variant}.jsonl"
            cmd = (f"rm -f {ans}; {jit}/answer.ts {r} {o} {o}/probes.json {ans} --agent {shlex.quote(agent)} --variant {variant} --tuck-dir {t} {extra}"
                   f" && {jit}/score.ts {o}/probes.json {ans} {shlex.quote(str(sc))}")
            jobs.append((f"{rec.stem}:ans:{tag(agent)}:{variant}", "plan-agent" if agent == PLAN_AGENT else "local", cmd, sc,
                         [f"{rec.stem}:probes", f"{rec.stem}:cuts:{source}"]))
    return jobs


def collect(live: Path, recordings: Path):
    recordings.mkdir(parents=True, exist_ok=True)
    for folder in sorted(live.glob("s[0-9]*-[AB]")):
        target = recordings / f"{folder.name}.jsonl"
        if not target.exists() and (folder / "stats.json").exists() and (folder / "session.jsonl").exists():
            shutil.copy(folder / "session.jsonl", target)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("recordings")
    parser.add_argument("out")
    parser.add_argument("--tuck", required=True)
    parser.add_argument("--collect")
    parser.add_argument("--expected", type=int, default=0)
    parser.add_argument("--agents", default=f"{LOCAL_AGENT},{PLAN_AGENT}")
    parser.add_argument("--pilot", action="store_true")
    parser.add_argument("--slots-file")
    parser.add_argument("--local", type=int, default=1)
    parser.add_argument("--plan", type=int, default=1)
    args = parser.parse_args()
    out, recordings = Path(args.out), Path(args.recordings)
    out.mkdir(parents=True, exist_ok=True)
    extra = "--first-cut 45000 --delta 15000" if args.pilot else ""
    tuck = str(Path(args.tuck).resolve())
    agents = args.agents.split(",")
    jobs: dict[str, tuple] = {}
    running: dict[str, tuple] = {}
    done: set[str] = set()
    failed: set[str] = set()
    pool = ThreadPoolExecutor(16)
    log = open(out / "run_replay.log", "a")

    def run(job):
        name, _, cmd, done_file, _ = job
        started = time.time()
        proc = subprocess.run(["sh", "-c", cmd], stdout=log, stderr=log)
        ok = proc.returncode == 0 and done_file.exists()
        print(f"{time.strftime('%H:%M:%S')} {'ok  ' if ok else 'FAIL'} {name} {time.time() - started:.0f}s", flush=True)
        return ok

    while True:
        if args.collect:
            collect(Path(args.collect), recordings)
        for rec in sorted(recordings.glob("*.jsonl")):
            if f"{rec.stem}:probes" not in jobs:
                (out / rec.stem).mkdir(exist_ok=True)
                for job in jobs_for(rec, out, tuck, agents, extra):
                    jobs[job[0]] = job
                    if job[3].exists():
                        done.add(job[0])
        slots = {"cpu": 2, "local": args.local, "plan": args.plan, "plan-agent": args.plan}
        if args.slots_file and Path(args.slots_file).exists():
            slots.update(json.loads(Path(args.slots_file).read_text()))
        for name, (future, _) in list(running.items()):
            if future.done():
                (done if future.result() else failed).add(name)
                del running[name]
        frontier = [n for n in jobs if n.endswith(":cuts:native-frontier")]
        frontier_all_done = len(frontier) >= args.expected and all(n in done for n in frontier)
        busy: dict[str, int] = {}
        for _, (_, res) in running.items():
            busy[res] = busy.get(res, 0) + 1
        pending = [j for n, j in sorted(jobs.items()) if n not in done and n not in failed and n not in running]
        for name, resource, _, _, needs in pending:
            if resource == "plan-agent" and not frontier_all_done:
                continue
            if busy.get(resource, 0) < slots.get(resource, 1) and all(n in done for n in needs):
                running[name] = (pool.submit(run, jobs[name]), resource)
                busy[resource] = busy.get(resource, 0) + 1
        everything = len(sorted(recordings.glob("*.jsonl"))) >= args.expected
        if not pending and not running and everything and (not args.collect or len(jobs) > 0):
            break
        if not running and not pending and not args.collect:
            break
        time.sleep(15)
    print(f"finished; {len(failed)} failed jobs", sorted(failed))


if __name__ == "__main__":
    main()
