"""Did the model have the prompt after a cut at the prompt? Reads the model's own first four messages after each such cut.
Usage: prompt_evidence.py CHAIN_DIR [CHAIN_DIR ...]      (chain folders such as runs/live81/t06-O; reads pi-sessions/*.jsonl and tasks.jsonl)
For every task whose session has a compaction entry with reason `prompt` (whatever it kept), it checks the first four assistant messages of the task (thinking and text) for signs that the
prompt is missing: confusion or missing-task wording, another task number named as the current one, the previous task's tag or issue named instead of this one's. A task with a sign is
listed for hand audit. Tasks with no prompt cut are the controls: the same signs are counted on them. The signs are rules, not proof: the receipt count (prompt_drops.py) is the mechanical
check; this one catches a prompt lost in any other way. Written 2026-11-06 from the reading of the 1.0.10 and 1.0.11 sessions (see the dropped-prompt sections of the result notes)."""
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

from prompt_drops import TASK, text_of

SWE = Path(__file__).resolve().parent.parent / "runs" / "swebench_verified.json"
PROBLEMS = {x["instance_id"]: x["problem_statement"] for x in json.loads(SWE.read_text())} if SWE.exists() else {}
CONFUSED = re.compile(r"summary is confusing|is confusing|confusing|omitted|not provided|no (new )?(\w+ )?(message|task|instruction|prompt)|\w+ (message|statement|prompt) (is|was|has been) (omitted|missing|dropped)|what the issue is|figure out (the )?(current|what)|reconstruct|where I am|which task|what task|don't know what|do not know what|not sure (what|which)|current task (is|appears|might|seems)|task (message|prompt)", re.I)
FIRST = 4


def blob(entry, calls=True) -> str:
    out = []
    for b in entry["message"].get("content", []):
        if not isinstance(b, dict):
            continue
        if b.get("type") == "text":
            out.append(b.get("text", ""))
        elif b.get("type") in ("thinking", "reasoning"):
            out.append(b.get("thinking") or b.get("text") or "")
        elif b.get("type") == "toolCall" and calls:
            out.append(json.dumps(b.get("arguments", {})))
    return "\n".join(out)


def idents(text: str) -> set:
    found = set(re.findall(r"[A-Za-z_][A-Za-z0-9_]{4,}(?:\.[A-Za-z_][A-Za-z0-9_]*)*", text))
    return {t for t in found if "_" in t or "." in t or re.search(r"[a-z][A-Z]", t)}


def read(folder: Path):
    """Per task: assistant entries, tags, prompt-cut flag, instance ids from run.json."""
    tasks = json.loads((folder / "run.json").read_text())["tasks"]
    msgs, tag, cut = defaultdict(list), {}, set()
    for session in sorted((folder / "pi-sessions").glob("*.jsonl")):
        n, first = 0, True
        for line in session.read_text().splitlines():
            if not line.strip():
                continue
            e = json.loads(line)
            m = e.get("message") or {}
            if e.get("type") == "message" and m.get("role") == "user":
                text = text_of(m.get("content"))
                found = TASK.search(text)
                n = int(found.group(1)) if found else (1 if first else n)
                first = False
                t = re.search(r"include the tag `([^`]+)`", text)
                if t:
                    tag[n] = t.group(1)
            elif e.get("type") == "compaction" and ((e.get("details") or {}).get("diagnosticReceipt") or {}).get("reason") == "prompt":
                cut.add(n)
            elif e.get("type") == "message" and m.get("role") == "assistant":
                msgs[n].append(e)
    return tasks, msgs, tag, cut


def signs(n, tasks, msgs, tag) -> list:
    early = msgs.get(n, [])[:FIRST]
    text, text_all = "\n".join(blob(e, False) for e in early), "\n".join(blob(e) for e in early)
    this, prev = tasks[n - 1], tasks[n - 2]
    found = []
    if CONFUSED.search(text):
        found.append("confusion or missing-task wording")
    if any(int(k) != n and 1 <= int(k) <= 30 for k in re.findall(r"\b[Tt]ask (\d+)\b", text)) and not re.search(rf"\b[Tt]ask {n}\b", text):
        found.append("names another task as the current one")
    own = idents(PROBLEMS.get(prev, "")) - idents(PROBLEMS.get(this, ""))
    prev_named = (tag.get(n - 1) and tag[n - 1] in text_all) or prev in text_all or sum(1 for t in own if t in text_all) >= 2
    if prev_named and not (tag.get(n) and tag[n] in text_all):
        found.append("the previous task's tag or issue, not this one's")
    return found


if __name__ == "__main__":
    cut_tasks = with_signs = control = control_signs = 0
    for arg in sys.argv[1:]:
        folder = Path(arg)
        tasks, msgs, tag, cut = read(folder)
        listed, c_all, c_signs = [], 0, 0
        for n in sorted(msgs):
            if n < 2 or n > len(tasks):
                continue  # task 1 shares its message with the session's opening text
            s = signs(n, tasks, msgs, tag)
            if n in cut:
                cut_tasks += 1
                if s:
                    with_signs += 1
                    listed.append((n, s))
            else:
                control += 1
                control_signs += bool(s)
        print(f"{folder.name}: tasks with a prompt cut and signs of a missing prompt (hand audit): {[n for n, _ in listed]}")
        for n, s in listed:
            print(f"    task {n}: {'; '.join(s)}")
    print(f"TOTAL tasks with a prompt cut {cut_tasks}, with signs {with_signs}; control tasks {control}, with signs {control_signs}")
