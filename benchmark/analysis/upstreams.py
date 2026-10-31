"""Which OpenRouter upstream served a run's requests (PREREG-32K.md pins one; this checks it, read-only).

Usage: upstreams.py FOLDER... [--sample 40]
Samples assistant responseIds from each folder's events.jsonl and asks OpenRouter's generation endpoint for the provider. Needs OPENROUTER_API_KEY."""
import argparse
import json
import os
import random
import time
import urllib.request
from collections import Counter
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("folders", nargs="+")
parser.add_argument("--sample", type=int, default=40)
args = parser.parse_args()
rng = random.Random(1)
for folder in args.folders:
    ids = []
    for line in (Path(folder) / "events.jsonl").read_text().splitlines():
        if '"message_end"' not in line:
            continue
        m = json.loads(line).get("message") or {}
        if m.get("role") == "assistant" and str(m.get("responseId", "")).startswith("gen-"):
            ids.append(m["responseId"])
    pick = rng.sample(ids, min(args.sample, len(ids)))
    seen = Counter()
    for i in pick:
        for attempt in range(3):
            try:
                req = urllib.request.Request(f"https://openrouter.ai/api/v1/generation?id={i}", headers={"Authorization": "Bearer " + os.environ["OPENROUTER_API_KEY"]})
                data = json.load(urllib.request.urlopen(req, timeout=30))["data"]
                seen[data.get("provider_name")] += 1
                break
            except Exception:
                time.sleep(2)
        else:
            seen["(lookup failed)"] += 1
    print(f"{folder}: {len(ids)} requests, sampled {len(pick)}: {dict(seen)}")
