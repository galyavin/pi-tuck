"""Run one live session: one arm, a chain of SWE-bench Verified tasks in one Pi session driven over RPC.

Usage: live.py --arm A|B --session s01 --tasks ID,ID,... [--tuck PATH] [--out DIR]
Writes DIR/tasks.jsonl (one record per task), DIR/events.jsonl (Pi's RPC events, streaming deltas left out), DIR/session.jsonl (the
Pi session file, every entry kept across cuts) and DIR/patches/."""
import argparse
import json
import os
import queue
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from common import BENCH, IMAGE, RUNS, SUITES, agent_dir, dataset, sh  # noqa: E402
from prompts import tag, task_prompt  # noqa: E402
import swe_eval  # noqa: E402

TASK_WALL_SECONDS = 30 * 60
TASK_MAX_TURNS = 120


def wait_for_provider(suite: str = "main"):
    """Hold a task back while the model server does not answer (an outage on 2026-10-30 ruined the tasks that ran into it)."""
    if SUITES[suite]["health"]:
        request = urllib.request.Request(SUITES[suite]["health"])
    else:
        provider = json.loads((agent_dir("A") / "models.json").read_text())["providers"]["mac-studio"]
        request = urllib.request.Request(provider["baseUrl"].rstrip("/") + "/models", headers={"Authorization": "Bearer " + os.environ["STUDIO_API_KEY"]})
    while True:
        try:
            if urllib.request.urlopen(request, timeout=20).status == 200:
                return
        except Exception:
            pass
        time.sleep(60)


class Rpc:
    def __init__(self, args, cwd, env, log: Path):
        self.proc = subprocess.Popen(args, cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=open(log.with_suffix(".stderr"), "ab"))
        self.events: "queue.Queue[dict]" = queue.Queue()
        self.responses: dict[str, dict] = {}
        self.cond = threading.Condition()
        self.log = open(log, "a")
        self.next = 0
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.proc.stdout:  # binary stream: splits on LF only
            record = json.loads(line.rstrip(b"\r\n"))
            if record.get("type") == "response":
                with self.cond:
                    self.responses[record.get("id", "")] = record
                    self.cond.notify_all()
                continue
            if record.get("type") != "message_update":
                record["_t"] = time.time()
                self.log.write(json.dumps(record) + "\n")
                self.log.flush()
            self.events.put(record)
        self.events.put({"type": "_exit"})

    def call(self, command: dict, timeout=120) -> dict:
        with self.cond:
            self.next += 1
            ident = f"r{self.next}"
        self.proc.stdin.write((json.dumps({**command, "id": ident}) + "\n").encode())
        self.proc.stdin.flush()
        deadline = time.time() + timeout
        with self.cond:
            while ident not in self.responses:
                if not self.cond.wait(max(0.1, deadline - time.time())) and time.time() > deadline:
                    raise TimeoutError(command["type"])
            return self.responses.pop(ident)

    def close(self):
        self.proc.stdin.close()
        self.proc.wait(timeout=120)


def start_container(name: str, instance: str, cwd: Path):
    sh(["docker", "rm", "-f", name], check=False)
    sh(["docker", "run", "-d", "--name", name, IMAGE.format(instance), "sleep", "infinity"])
    sh(["docker", "exec", name, "bash", "-c", f'mkdir -p "$(dirname "$1")" && ln -sfn /testbed "$1" && git config --global --add safe.directory /testbed', "_", str(cwd)])


def patch_of(name: str, base: str) -> str:
    return sh(["docker", "exec", name, "bash", "-c", f"cd /testbed && git add -A >/dev/null && git diff --cached --binary {base}"]).stdout


def run_task(rpc: Rpc, prompt: str) -> dict:
    """Prompt and wait for agent_settled, aborting past the wall or turn limit. Returns what the events say about the task."""
    while not rpc.events.empty():
        rpc.events.get_nowait()
    started = time.time()
    response = rpc.call({"type": "prompt", "message": prompt})
    if not response.get("success"):
        return {"error": response.get("error"), "seconds": 0}
    usage = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "requests": 0}
    cuts, turns, final_text, aborted_for, stop_reasons, provider_errors = [], 0, "", None, [], 0
    open_cut = None
    down, down_since = 0.0, None  # time the provider spent failing requests; it does not count against the wall limit

    def working() -> float:
        return time.time() - started - down - (time.time() - down_since if down_since else 0)

    while True:
        try:
            event = rpc.events.get(timeout=5)
        except queue.Empty:
            event = None
        if aborted_for is None and (working() > TASK_WALL_SECONDS or turns >= TASK_MAX_TURNS):
            aborted_for = "wall" if working() > TASK_WALL_SECONDS else "turns"
            rpc.call({"type": "abort"})
        if event is None:
            continue
        kind = event["type"]
        if kind == "_exit":
            return {"error": "pi exited", "seconds": time.time() - started}
        if kind == "message_end" and event["message"].get("role") == "assistant":
            message = event["message"]
            u = message.get("usage") or {}
            for key in ("input", "output", "cacheRead", "cacheWrite"):
                usage[key] += u.get(key, 0) or 0
            usage["requests"] += 1
            stop_reasons.append(message.get("stopReason"))
            if message.get("stopReason") == "error" and "aborted" not in str(message.get("errorMessage")):
                provider_errors += 1  # our own wall-limit abort also ends in stopReason "error"; only the others are the server's failures
            if message.get("stopReason") == "error":
                down_since = down_since or time.time()
            elif down_since:
                down, down_since = down + time.time() - down_since, None
            text = "".join(b.get("text", "") for b in message.get("content", []) if b.get("type") == "text")
            if text.strip():
                final_text = text
        elif kind == "turn_end":
            turns += 1
        elif kind == "compaction_start":
            open_cut = {"reason": event.get("reason"), "start": event["_t"]}
        elif kind == "compaction_end" and open_cut is not None:
            result = event.get("result") or {}
            cuts.append({**open_cut, "end": event["_t"], "seconds": event["_t"] - open_cut["start"], "aborted": event.get("aborted"),
                         "error": event.get("errorMessage"), "tokensBefore": result.get("tokensBefore"),
                         "estimatedTokensAfter": result.get("estimatedTokensAfter"), "fromExtension": bool(result.get("details", {}) and result["details"].get("compactor"))})
            open_cut = None
        elif kind == "agent_settled":
            return {"seconds": time.time() - started, "down_seconds": down + (time.time() - down_since if down_since else 0), "turns": turns, "usage": usage, "cuts": cuts, "final_text": final_text,
                    "aborted_for": aborted_for, "settled_aborted": event.get("aborted"), "stop_reasons": stop_reasons, "provider_errors": provider_errors}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--arm", required=True, choices=["A", "B", "C", "M", "T"])
    parser.add_argument("--suite", default="main", choices=sorted(SUITES))
    parser.add_argument("--session", required=True)
    parser.add_argument("--tasks", required=True)
    parser.add_argument("--tuck", help="pi-tuck checkout or package folder (arm B)")
    parser.add_argument("--out")
    args = parser.parse_args()
    rows = dataset()
    tasks = args.tasks.split(",")
    suite = SUITES[args.suite]
    out = Path(args.out or RUNS / suite["root"] / f"{args.session}-{args.arm}")
    (out / "patches").mkdir(parents=True, exist_ok=True)
    cwd = RUNS / "w" / f"{args.session}{args.arm}"
    cwd.mkdir(parents=True, exist_ok=True)
    container_file = out / "container"
    extensions = [str(BENCH / "harness" / "container-tools.ts")]
    if args.arm in ("B", "C", "T"):
        if not args.tuck:
            sys.exit("arms B, C and T need --tuck")
        extensions.append(str(Path(args.tuck).resolve() / "index.ts"))
    if args.arm == "M":  # observation masking over Pi's own compaction (PREREG-32K.md, arm M)
        extensions.append(str(BENCH / "harness" / "mask-extension.ts"))
    env = {**os.environ, "PI_CODING_AGENT_DIR": str(agent_dir(args.arm, args.suite)), "TUCK_EVAL_CONTAINER_FILE": str(container_file), "TUCK_EVAL_MASK_LOG": str(out / "mask.log")}
    command = ["pi", "--mode", "rpc", "--no-extensions", *sum((["-e", e] for e in extensions), []), "--no-skills", "--no-prompt-templates",
               "--no-context-files", "--no-mcp", "--no-themes", "--session-dir", str(out / "pi-sessions"), "--model", f"{suite['model']}:{suite['thinking']}"]
    (out / "run.json").write_text(json.dumps({"arm": args.arm, "suite": args.suite, "session": args.session, "tasks": tasks, "command": command, "tuck": args.tuck,
                                              "started": time.time()}, indent=1))
    rpc = Rpc(command, cwd, env, out / "events.jsonl")
    grader = ThreadPoolExecutor(max_workers=2)
    prefetch = ThreadPoolExecutor(max_workers=1)
    def pull(instance):
        """A registry hiccup must not kill a chain (s01-B died on one): retry with growing waits before giving up."""
        for attempt in range(6):
            try:
                return sh(["docker", "pull", "-q", IMAGE.format(instance)], timeout=3600)
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
                if attempt == 5:
                    raise
                time.sleep(60 * (attempt + 1))
    pulling = {tasks[0]: prefetch.submit(pull, tasks[0])}
    pending = []
    records = open(out / "tasks.jsonl", "a")
    try:
        for index, instance in enumerate(tasks, 1):
            row = rows[instance]
            name = f"tuck-{args.session}-{args.arm}-{index}"
            pulling.pop(instance).result()
            if index < len(tasks):
                pulling[tasks[index]] = prefetch.submit(pull, tasks[index])  # the next task's image downloads while this one runs
            start_container(name, instance, cwd)
            container_file.write_text(name)
            wait_for_provider(args.suite)
            outcome = run_task(rpc, task_prompt(args.session, index, len(tasks), row, str(cwd)))
            patch = patch_of(name, row["base_commit"])
            container_file.write_text("")
            sh(["docker", "rm", "-f", name], check=False)
            (out / "patches" / f"{index:02d}-{instance}.diff").write_text(patch)
            record = {"index": index, "instance_id": instance, "tag": tag(args.session, index), **outcome,
                      "tag_followed": tag(args.session, index) in outcome.get("final_text", ""),
                      "ended_in_error": bool(outcome.get("stop_reasons")) and outcome["stop_reasons"][-1] == "error" and not outcome.get("aborted_for"),
                      "result_line": any(line.startswith("RESULT:") for line in outcome.get("final_text", "").splitlines()),
                      "patch_files": [line[6:] for line in patch.splitlines() if line.startswith("+++ b/")]}
            pending.append((record, grader.submit(swe_eval.grade, instance, patch)))
            print(json.dumps({k: record.get(k) for k in ("index", "instance_id", "seconds", "turns", "aborted_for", "error")}), flush=True)
            while pending and pending[0][1].done():
                done, future = pending.pop(0)
                records.write(json.dumps({**done, "grade": {k: v for k, v in future.result().items() if k != "log_tail"}}) + "\n")
                records.flush()
            if outcome.get("error") == "pi exited":
                break
        stats = rpc.call({"type": "get_session_stats"})
        (out / "stats.json").write_text(json.dumps(stats.get("data"), indent=1))
        session_file = (stats.get("data") or {}).get("sessionFile")
        if session_file:
            shutil.copy(session_file, out / "session.jsonl")
    finally:
        for done, future in pending:
            records.write(json.dumps({**done, "grade": {k: v for k, v in future.result().items() if k != "log_tail"}}) + "\n")
        records.close()
        rpc.close()


if __name__ == "__main__":
    main()
