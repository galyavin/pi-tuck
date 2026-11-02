"""The 32k suite's readouts (PREREG-32K.md).

Usage: w32_stats.py LIVE32_DIR [--boot 10000] [--seed 1]
LIVE32_DIR holds <session>-<arm>/ folders (arms A, B, T) written by harness/live.py --suite w32."""
import argparse
import json
import random
import re
import statistics
from collections import defaultdict
from pathlib import Path

from sessionlog import session_cuts

TASK = re.compile(r"Task (\d+) of \d+")
# pi-tuck refuses a run with one of two notices: the request cannot fit, or it needs a cut that Pi cannot make (keepRecentTokens covers the whole session).
# Corrected on 2026-11-01: the second text was missing, so a task refused at its prompt with it was not counted (arm C t03 task 24).
REFUSAL = re.compile(r"mandatory context cannot fit|needs a cut and Pi has none to make")
ROOM = 16384  # window 32,768 less the 16,384 reply reserve: the most a request may carry without the window being nominal


def text_of(content) -> str:
    return content if isinstance(content, str) else " ".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")


def summarising_tasks(folder: Path) -> set[int]:
    """Tasks in which a cut summarised part of the task at hand: the entry the cut keeps from comes after the task's prompt entry."""
    path = folder / "session.jsonl"
    if not path.exists():
        return set()
    entries = [json.loads(l) for l in path.read_text().splitlines() if l.strip()]
    task, starts = 0, {}
    index = {e.get("id"): n for n, e in enumerate(entries)}
    for n, e in enumerate(entries):
        if e.get("type") == "message" and e["message"]["role"] == "user":
            m = TASK.search(text_of(e["message"]["content"]))
            task = int(m.group(1)) if m else task + 1
            starts[task] = n
    found = set()
    for n, e in enumerate(entries):
        if e.get("type") == "compaction":
            current = max((t for t, s in starts.items() if s <= n), default=None)
            if current is not None and index.get(e.get("firstKeptEntryId"), 0) > starts[current]:
                found.add(current)
    return found


def scan_events(folder: Path):
    """Per task from the RPC events: tasks where pi-tuck's refusal notice fired, and the largest prompt (input plus cache reads) of any request.
    A refused run ends in an instant 'aborted' error, so a refusal is read from the notice, not from the stop reason."""
    path = folder / "events.jsonl"
    refused, largest, task, idle, carry = set(), {}, 0, False, False
    if not path.exists():
        return refused, largest
    for line in path.read_text().splitlines():
        if not REFUSAL.search(line) and '"usage"' not in line and "Task " not in line and "agent_" not in line:
            continue
        try:
            e = json.loads(line)
        except ValueError:
            continue
        m = e.get("message") or {}
        if e.get("type") == "agent_settled":
            idle = True
        elif e.get("type") == "agent_start":
            idle = False
        if e.get("type") == "message_start" and m.get("role") == "user":
            found = TASK.search(text_of(m.get("content") or ""))
            task = int(found.group(1)) if found else task
            if carry:  # the refusal came on the input, before the task's prompt was logged
                refused.add(task)
                carry = False
        elif e.get("type") == "message_end" and m.get("role") == "assistant" and m.get("usage"):
            u = m["usage"]
            largest[task] = max(largest.get(task, 0), u["input"] + u.get("cacheRead", 0))
        elif e.get("type") == "extension_ui_request" and e.get("notifyType") == "error" and REFUSAL.search(e.get("message", "")):
            if idle:
                carry = True
            else:
                refused.add(task)
    return refused, largest


def load(folder: Path):
    tasks = {}
    if (folder / "tasks.jsonl").exists():
        for line in (folder / "tasks.jsonl").read_text().splitlines():
            if line.strip():
                t = json.loads(line)
                tasks[t["index"]] = t
    stats = json.loads((folder / "stats.json").read_text()) if (folder / "stats.json").exists() else None
    refused, largest = scan_events(folder)
    sent = lambda t: sum((t.get("usage") or {}).get(k, 0) for k in ("input", "output", "cacheRead")) > 0  # a request that carried tokens went out
    dead = {k for k in refused if k in tasks and not sent(tasks[k])}  # PREREG-32K addendum: refused before any request was sent
    return {"tasks": tasks, "stats": stats, "summarising": summarising_tasks(folder), "cuts": session_cuts(folder), "refused": refused, "dead": dead,
            "over_room": {t for t, n in largest.items() if n > ROOM}, "largest": max(largest.values(), default=0)}


def bootstrap(values, boot, rng):
    draws = sorted(statistics.fmean(rng.choices(values, k=len(values))) for _ in range(boot))
    return draws[int(0.05 * boot)], draws[int(0.95 * boot)]


def compare(data, sessions, base, other, boot, rng):
    rows = []
    for s in sessions:
        a, b = data.get((s, base)), data.get((s, other))
        if not a or not b:
            continue
        first = min(a["refused"] | b["refused"], default=10**9)  # first task of the chain in which pi-tuck refused, in either arm
        for k in sorted(set(a["tasks"]) & set(b["tasks"])):
            x, y = a["tasks"][k], b["tasks"][k]
            rows.append({"session": s, "k": k, "pre": k < first, "lost": k >= first and first < 10**9, "ra": int(bool(x["grade"].get("resolved"))), "rb": int(bool(y["grade"].get("resolved"))), "ta": x["turns"], "tb": y["turns"],
                         "in_a": k in a["summarising"], "in_b": k in b["summarising"]})
    print(f"\n=== {other} vs {base}: {len(rows)} paired tasks ===")
    subsets = {"all paired tasks": rows, "S: a cut summarised the task in either arm": [r for r in rows if r["in_a"] or r["in_b"]],
               f"in {base} only": [r for r in rows if r["in_a"] and not r["in_b"]], f"in {other} only": [r for r in rows if r["in_b"] and not r["in_a"]],
               "in both": [r for r in rows if r["in_a"] and r["in_b"]],
               "secondary, added after t01 and t02 were read: tasks before the chain's first pi-tuck refusal": [r for r in rows if r["pre"]],
               "secondary: tasks from the chain's first pi-tuck refusal on": [r for r in rows if r["lost"]]}
    for label, sub in subsets.items():
        if not sub:
            print(f"  {label}: none")
            continue
        diffs = [100 * (r["rb"] - r["ra"]) for r in sub]
        lo = bootstrap(diffs, boot, rng)[0] if len(sub) > 1 else float("nan")
        both = [r for r in sub if r["ra"] and r["rb"]]
        td = [r["tb"] - r["ta"] for r in sub]
        thi = bootstrap(td, boot, rng)[1] if len(sub) > 1 else float("nan")
        print(f"  {label}: n={len(sub)}; resolved {base} {sum(r['ra'] for r in sub)}, {other} {sum(r['rb'] for r in sub)}; {other}-only {sum(1 for r in sub if r['rb'] and not r['ra'])}, "
              f"{base}-only {sum(1 for r in sub if r['ra'] and not r['rb'])}; difference {statistics.fmean(diffs):+.1f} pts, one-sided 95% lower bound {lo:+.1f}; "
              f"turns {statistics.fmean(td):+.2f} per task (95% upper bound {thi:+.2f})"
              + (f"; both resolved n={len(both)}, turns {statistics.fmean(r['tb'] - r['ta'] for r in both):+.2f}" if both else ""))
    by_chain = defaultdict(list)
    for r in rows:
        by_chain[r["session"]].append(100 * (r["rb"] - r["ra"]))
    print("  per chain difference (pts):", {s: round(statistics.fmean(v), 1) for s, v in sorted(by_chain.items())})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("root")
    parser.add_argument("--boot", type=int, default=10000)
    parser.add_argument("--seed", type=int, default=1)
    args = parser.parse_args()
    rng = random.Random(args.seed)
    data = {}
    for folder in sorted(Path(args.root).iterdir()):
        if folder.is_dir() and "-" in folder.name and (folder / "tasks.jsonl").exists():
            session, arm = folder.name.rsplit("-", 1)
            data[(session, arm)] = load(folder)
    sessions = sorted({s for s, _ in data})
    arms = sorted({a for _, a in data})
    print("=== per arm ===")
    for arm in arms:
        mine = [d for (s, a), d in data.items() if a == arm]
        tasks = [t for d in mine for t in d["tasks"].values()]
        capped = sum(1 for t in tasks if t.get("aborted_for") or (t.get("ended_in_error") and not t.get("aborted_for")))
        cuts = [c for d in mine for c in d["cuts"]]
        cost = sum((d["stats"] or {}).get("cost") or 0 for d in mine if d["stats"] and not isinstance(d["stats"].get("cost"), dict))
        tokens = [d["stats"]["tokens"]["total"] for d in mine if d["stats"]]
        print(f"  arm {arm}: {len(mine)} sessions, {len(tasks)} tasks, resolved {sum(1 for t in tasks if t['grade'].get('resolved'))}, stopped by cap or ended in an error stop (provider error or pi-tuck refusal) {capped}, "
              f"turns/task mean {statistics.fmean(t['turns'] for t in tasks) if tasks else 0:.1f}, cuts {len(cuts)} ({len(cuts) / max(1, len(mine)):.1f}/session), "
              f"tasks with a cut summarising part of them {sum(len(d['summarising']) for d in mine)}, tasks refused by pi-tuck {sum(len(d['refused']) for d in mine)} (dead, refused before any request: {sum(len(d['dead']) for d in mine)}; refused mid-run: {sum(len(d['refused'] - d['dead']) for d in mine)}), "
              f"tasks with a request over the {ROOM:,}-token room {sum(len(d['over_room']) for d in mine)}, largest prompt {max((d['largest'] for d in mine), default=0):,}, "
              f"tokens/session {statistics.fmean(tokens) if tokens else 0:,.0f}, cost ${cost:.2f}")
    if "A" in arms:
        for other in [a for a in arms if a != "A"]:
            compare(data, sessions, "A", other, args.boot, rng)
        if "B" in arms and "M" in arms:
            compare(data, sessions, "M", "B", args.boot, rng)
        if "B" in arms and "T" in arms:
            compare(data, sessions, "B", "T", args.boot, rng)


if __name__ == "__main__":
    main()
