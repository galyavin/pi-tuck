"""Which OpenRouter upstream served a run's requests (PREREG-32K.md pins one; this checks it, read-only).

Usage: upstreams.py FOLDER... [--sample 40 | --all]
Samples assistant responseIds from each folder's events.jsonl and asks OpenRouter's generation endpoint for the provider. Needs OPENROUTER_API_KEY.
With --all every request is looked up and the per-request log is written to FOLDER/upstreams.jsonl (one line per request: responseId, provider)."""
import argparse
import json
import os
import sys
import random
import time
import urllib.request
from collections import Counter
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("folders", nargs="+")
parser.add_argument("--sample", type=int, default=40)
parser.add_argument("--all", action="store_true")
args = parser.parse_args()
sys.exit("OpenRouter is not used: mac-studio only: upstreams.py calls OpenRouter's generation endpoint; recorded upstreams.jsonl files stay as evidence")
rng = random.Random(1)
for folder in args.folders:
    ids = []
    for line in (Path(folder) / "events.jsonl").read_text().splitlines():
        if '"message_end"' not in line:
            continue
        m = json.loads(line).get("message") or {}
        if m.get("role") == "assistant" and str(m.get("responseId", "")).startswith("gen-"):
            ids.append(m["responseId"])
    pick = ids if args.all else rng.sample(ids, min(args.sample, len(ids)))
    seen = Counter()
    log = []
    for i in pick:
        for attempt in range(3):
            try:
                req = urllib.request.Request(f"https://openrouter.ai/api/v1/generation?id={i}", headers={"Authorization": "Bearer " + os.environ["OPENROUTER_API_KEY"]})
                data = json.load(urllib.request.urlopen(req, timeout=30))["data"]
                seen[data.get("provider_name")] += 1
                log.append({"responseId": i, "provider": data.get("provider_name")})
                break
            except Exception:
                time.sleep(2)
        else:
            seen["(lookup failed)"] += 1
            log.append({"responseId": i, "provider": None})
    if args.all:
        (Path(folder) / "upstreams.jsonl").write_text("".join(json.dumps(r) + "\n" for r in log))
    print(f"{folder}: {len(ids)} requests, sampled {len(pick)}: {dict(seen)}")
