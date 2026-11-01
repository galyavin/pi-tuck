"""A worker for the recovery test: it speaks the controller's protocol and embeds only while the test-owned encoder process is alive."""
import json
import os
import sqlite3
import sys
import time

root = os.environ["PI_SEMANTIC_RUNTIME_ROOT"]
broken = False  # like the real worker, whose dead native server is never restarted inside the same process


def encoder_alive():
    try:
        with open(os.path.join(root, "encoder.pid")) as handle:
            os.kill(int(handle.read()), 0)
        return True
    except Exception:
        return False


class Refusal(Exception):
    pass


def vector():
    return [1.0] + [0.0] * 767


def run(request):
    op = request["op"]
    if op == "ready":
        # A slow start, as on a busy machine: the test sets the delay in the runtime root and removes it when the load is gone.
        try:
            with open(os.path.join(root, "ready-delay-ms")) as handle:
                time.sleep(int(handle.read()) / 1000)
        except FileNotFoundError:
            pass
        return {"identity": "heal-process-fixture", "dimensions": 768, "maxTokens": 8192, "offline": True}
    if op == "tokenize":
        return {"ranges": [[{"start": 0, "end": len(text.encode("utf-16-le")) // 2, "tokens": 3}] for text in request["texts"]], "offsetUnit": "utf16"}
    if op == "embed" and os.path.exists(os.path.join(root, "no-metal")):
        # A Mac whose GPU cannot start the server: the real worker refuses with this code.
        raise Refusal("metal_unavailable")
    if op == "embed":
        # A starved CPU: each embed call takes this long (set by the test in the runtime root).
        try:
            with open(os.path.join(root, "embed-delay-ms")) as handle:
                time.sleep(int(handle.read()) / 1000)
        except FileNotFoundError:
            pass
        global broken
        if broken or not encoder_alive():
            broken = True
            raise RuntimeError("encoder gone")
        return {"vectors": [vector() for _ in request["texts"]]}
    if op == "index":
        action = request["action"]
        keys = request.get("keys", [])
        os.makedirs(os.path.dirname(request["path"]), exist_ok=True)
        connection = sqlite3.connect(request["path"])  # a real SQLite file, like the real worker's index: it outlives the process
        connection.execute("CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, row TEXT NOT NULL)")
        try:
            known = {key: row for key, row in connection.execute("SELECT key, row FROM records")}
            if action == "reconcile":
                for key in [key for key in known if key not in keys]:
                    connection.execute("DELETE FROM records WHERE key=?", (key,))
                return {}
            if action == "status":
                return {"coveredKeys": [key for key in keys if key in known]}
            if action == "upsert":
                for row in request["rows"]:
                    connection.execute("INSERT OR REPLACE INTO records VALUES (?, ?)", (row["key"], json.dumps(row)))
                return {}
            if action == "score":
                found = [key for key in keys if key in known]
                return {"ranked": [{"key": key, "score": 1.0} for key in found[:24]], "observed": len(found)}
        finally:
            connection.commit()
            connection.close()
    return {}


for line in sys.stdin:
    request = json.loads(line)
    try:
        reply = {"id": request["id"], "ok": True, "result": run(request)}
    except Refusal as refusal:
        reply = {"id": request["id"], "ok": False, "error": {"code": str(refusal)}}
    except Exception:
        reply = {"id": request["id"], "ok": False, "error": {"code": "local_runtime_failure"}}
    print(json.dumps(reply), flush=True)
