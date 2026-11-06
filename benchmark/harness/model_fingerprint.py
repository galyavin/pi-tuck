"""Identifies the model behind `mac-studio/main`: what the server reports plus a short fixed completion, saved as one JSON line per sample.
Usage: model_fingerprint.py [--every SECONDS] [--log runs/model-fingerprints.log]   (one sample, or a loop; stop with SIGTERM or a STOP file next to the log)
The sample holds the server's own model listing for `main` (name, context length, engine, concurrency, capabilities), the token count of a fixed prompt, a fixed temperature-0
completion of 24 tokens and the sha256 of all of it (`sha`). Two runs are on the same model only if their samples before, during and after agree on `sha`.
The key is read from the environment variable the model entry names, never written."""
import argparse
import hashlib
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

BENCH = Path(__file__).resolve().parent.parent
PROMPT = "Complete the sequence with the next five numbers, digits only: 3, 7, 12, 18, 25,"


def call(url, key, body=None):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body else None, headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)


def sample():
    entry = json.load(open(BENCH / "runs/agent/B/models.json"))["providers"]["mac-studio"]
    base, key = entry["baseUrl"], os.environ[entry["apiKey"].strip("${}")]
    out = {"time": time.strftime("%Y-%m-%d %H:%M:%S")}
    try:
        listing = next(m for m in call(base + "/models", key)["data"] if m["id"] == "main")
        out["listing"] = listing
        reply = call(base + "/chat/completions", key, {"model": "main", "messages": [{"role": "user", "content": PROMPT}], "temperature": 0, "max_tokens": 24, "seed": 1, "stream": False})
        msg = reply["choices"][0]["message"]
        out["prompt_tokens"] = reply.get("usage", {}).get("prompt_tokens")
        out["completion"] = ((msg.get("content") or "") + "|" + (msg.get("reasoning_content") or msg.get("reasoning") or ""))[:120]
        out["sha"] = hashlib.sha256(json.dumps([listing, out["prompt_tokens"], out["completion"]], sort_keys=True).encode()).hexdigest()[:16]
    except Exception as e:
        out["error"] = f"{type(e).__name__}: {e}"[:200]
    return out


parser = argparse.ArgumentParser()
parser.add_argument("--every", type=int, default=0)
parser.add_argument("--log", default=str(BENCH / "runs/model-fingerprints.log"))
args = parser.parse_args()
log = Path(args.log)
log.parent.mkdir(parents=True, exist_ok=True)
while True:
    line = json.dumps(sample())
    with open(log, "a") as f:
        f.write(line + "\n")
    print(line, flush=True)
    if not args.every or (log.parent / "STOP-FINGERPRINT").exists():
        sys.exit(0)
    time.sleep(args.every)
