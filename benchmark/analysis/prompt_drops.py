"""Tasks whose prompt was dropped at a cut: the compaction entry's receipt has reason `prompt`, keptUserTurns 0 and an empty firstKeptEntryId.
Usage: prompt_drops.py CHAIN_DIR [CHAIN_DIR ...]      (a chain folder such as runs/live81/t06-O; reads its pi-sessions/*.jsonl)
`dead_tasks.py` counts refusals and cannot see this failure: no refusal is raised, the request goes out without the prompt and the model works from a summary alone.
The task is the one whose prompt opened just before the entry ("Task N of 30"; the first prompt of a session carries the session's opening text and counts as task 1).
This is the receipt only: it says the cut kept no turn, not what the model did next. The model's own early reasoning is the evidence of what it saw (see the result notes)."""
import json
import re
import sys
from pathlib import Path

TASK = re.compile(r"Task (\d+) of \d+")


def text_of(content) -> str:
    return content if isinstance(content, str) else " ".join(b.get("text", "") for b in content or [] if isinstance(b, dict))


def dropped_prompt_tasks(folder: Path) -> set[int]:
    dropped: set[int] = set()
    for session in sorted((folder / "pi-sessions").glob("*.jsonl")):
        task, first = 0, True
        for line in session.read_text().splitlines():
            if not line.strip():
                continue
            try:
                e = json.loads(line)
            except ValueError:
                continue
            m = e.get("message") or {}
            if e.get("type") == "message" and m.get("role") == "user":
                found = TASK.search(text_of(m.get("content")))
                task = int(found.group(1)) if found else (1 if first else task)
                first = False
            elif e.get("type") == "compaction":
                details = e.get("details") or {}
                receipt = details.get("diagnosticReceipt") or {}
                if receipt.get("reason") == "prompt" and details.get("keptUserTurns") == 0 and not e.get("firstKeptEntryId"):
                    dropped.add(task)
    return dropped


if __name__ == "__main__":
    total = 0
    for arg in sys.argv[1:]:
        d = dropped_prompt_tasks(Path(arg))
        total += len(d)
        print(f"{Path(arg).name}: prompt dropped at a cut in tasks {sorted(d)}")
    print(f"TOTAL prompt-dropped tasks: {total}")
