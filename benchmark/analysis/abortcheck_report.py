"""Readout of the abort check (PREREG-ABORTCHECK.md): one block per run in runs/abortcheck/{A,B}/*.jsonl.
Usage: abortcheck_report.py ABORTCHECK_DIR
Per run: setup, set, seconds, how it ended (answered / refused for capacity / aborted without a refusal / wall-bound at 900 s), every refusal the extension raised (class, text,
messages and characters of the session then), the requests (seconds each, input + cache-read tokens), the largest fresh tool result before the end, and Pi's compaction events."""
import json
import sys
from pathlib import Path

WALL_S = 900
root = Path(sys.argv[1])
for setup in "AB":
    for f in sorted((root / setup).glob("*.jsonl")):
        for line in f.read_text().splitlines():
            if not line.strip():
                continue
            r = json.loads(line)
            seconds = r["ms"] / 1000
            trace = r.get("trace", [])
            assistants = [t for t in trace if t["role"] == "assistant"]
            done = [t for t in assistants if t["stopReason"] != "aborted"]
            ends = [t["atMs"] for t in assistants]
            per_request = [round((b - a) / 1000) for a, b in zip([0] + ends, ends)]
            tokens = [(t["usage"] or {}).get("input", 0) + (t["usage"] or {}).get("cacheRead", 0) for t in done]
            refusals = r.get("refusals", [])
            capacity = [x for x in refusals if "cannot fit" in x["message"] or "exceed" in x["message"] or "did not reduce" in x["message"]]
            if not r.get("error") and (r.get("answer") or "").strip():
                end = "answered"
            elif seconds >= WALL_S - 1:
                end = "wall-bound (900 s)"
            elif capacity:
                end = "refused for capacity"
            elif refusals:
                end = "aborted after a refusal (not capacity)"
            else:
                end = "aborted without a refusal"
            print(f"== setup {setup} {f.stem}: {seconds:.0f} s, {end}; requests {r['usage']['requests']}, tools {r['tools']}, error {r.get('error')}")
            print(f"   seconds per request {per_request}; input+cache-read tokens per completed request {tokens}")
            for x in refusals:
                print(f"   REFUSAL at {x['atMs'] / 1000:.0f} s: {x['name']}: {x['message']} (session then: {x.get('messagesAtFailure')} messages, {x.get('charsAtFailure')} chars)")
            results = [t for t in trace if t["role"] == "toolResult"]
            if results:
                last_calls = []
                for t in reversed(trace):
                    if t["role"] == "toolResult":
                        last_calls.append(t["chars"])
                    elif last_calls:
                        break
                print(f"   tool results: {len(results)}, largest {max(t['chars'] for t in results)} chars, last batch before the end {list(reversed(last_calls))} chars")
            if r.get("compactionEvents"):
                print(f"   compaction events: {r['compactionEvents']}")
            print(f"   semantic {r.get('semantic')}, compaction setting {r.get('compactionSetting')}, build {r.get('tuckDir')}")
