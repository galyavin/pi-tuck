"""Hand-audit aid for the 32k acceptance run (PREREG-32K.md, definition of 14:55): for each refusal in a chain, the events around it.
Usage: refusal_audit.py CHAIN_DIR
A mid-run refusal is confirmed when it comes right after the task's own fresh tool result and the prompt before that round plus the result
(chars / 4, Pi's estimate) exceeds the room; the next task then runs. Prints no outcome (resolved or not)."""
import json
import sys
from pathlib import Path

from w32_stats import REFUSAL, ROOM, TASK, text_of

folder = Path(sys.argv[1])
events = []
for line in (folder / "events.jsonl").read_text().splitlines():
    if REFUSAL.search(line) or '"message_end"' in line or '"message_start"' in line or "agent_" in line:
        try:
            events.append(json.loads(line))
        except ValueError:
            pass
task, owner = 0, []
for e in events:
    m = e.get("message") or {}
    if e.get("type") == "message_start" and m.get("role") == "user":
        found = TASK.search(text_of(m.get("content") or ""))
        task = int(found.group(1)) if found else task
    owner.append(task)
for i, e in enumerate(events):
    if e.get("type") == "extension_ui_request" and REFUSAL.search(e.get("message", "")):
        last_request = last_result = 0
        for x in reversed(events[:i]):
            m = x.get("message") or {}
            if x.get("type") != "message_end":
                continue
            if m.get("role") == "toolResult" and not last_result:
                last_result = sum(len(b.get("text", "")) for b in m.get("content", []) if isinstance(b, dict))
            elif m.get("role") == "assistant" and m.get("usage"):
                last_request = m["usage"]["input"] + m["usage"].get("cacheRead", 0)
                break
        role = lambda x: (x["message"].get("role") if isinstance(x.get("message"), dict) else None) or x["type"]
        roles = [role(events[j]) + ("*" if j == i else "") for j in range(max(0, i - 3), min(len(events), i + 3)) if events[j].get("type") in ("message_end", "extension_ui_request", "agent_end")]
        total = last_request + last_result // 4
        print(f"{folder.name} task {owner[i]}: prompt before the round {last_request} tokens + result {last_result} chars (~{last_result // 4} tokens) = ~{total} vs room {ROOM}: {'does not fit' if total > ROOM else 'FITS - not the task own round'}; events {' > '.join(roles)}")
