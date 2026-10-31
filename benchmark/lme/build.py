"""Turns each subset question's haystack into a Pi session recording (PREREG-LME.md): the sessions in date order, plain user and assistant messages,
the first user message of each session opening with its date. The question is not in the recording; it is asked after the last cut.
Usage: python -I lme/build.py DATA.json OUT_DIR   (writes OUT_DIR/<question_id>.jsonl and OUT_DIR/questions.json)"""
import json
import secrets
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

data = {q["question_id"]: q for q in json.loads(Path(sys.argv[1]).read_text())}
out = Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
ids = json.loads(Path(__file__).with_name("subset.json").read_text())["ids"]


def when(text: str) -> datetime:
    return datetime.strptime(text, "%Y/%m/%d (%a) %H:%M").replace(tzinfo=timezone.utc)


def stamp(t: datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%S.000Z")


ZERO = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0, "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}}
meta = {}
for qid in ids:
    q = data[qid]
    sessions = sorted(zip(q["haystack_dates"], q["haystack_session_ids"], q["haystack_sessions"]), key=lambda s: when(s[0]))
    entries, parent = [], None
    for date, _sid, turns in sessions:
        t0 = when(date)
        for n, turn in enumerate(turns):
            text = turn["content"]
            if n == 0:
                text = f"[Conversation on {date}]\n{text}"
            t = t0 + timedelta(seconds=30 * n)
            msg = {"role": turn["role"], "content": [{"type": "text", "text": text}], "timestamp": int(t.timestamp() * 1000)}
            if turn["role"] == "assistant":
                msg.update({"api": "openai-completions", "provider": "openrouter", "model": "deepseek/deepseek-v4.1-flash-1017", "usage": ZERO, "stopReason": "stop"})
            e = {"type": "message", "id": secrets.token_hex(4), "parentId": parent, "timestamp": stamp(t), "message": msg}
            entries.append(e)
            parent = e["id"]
    header = {"type": "session", "version": 3, "id": str(uuid.uuid4()), "timestamp": stamp(when(sessions[0][0])), "cwd": "/work/lme"}
    (out / f"{qid}.jsonl").write_text("\n".join(json.dumps(x) for x in [header, *entries]) + "\n")
    meta[qid] = {k: q[k] for k in ("question_id", "question_type", "question", "question_date", "answer")} | {"messages": len(entries), "sessions": len(sessions)}
(out / "questions.json").write_text(json.dumps(meta, indent=1))
print(len(meta), "recordings;", sum(m["messages"] for m in meta.values()), "messages")
