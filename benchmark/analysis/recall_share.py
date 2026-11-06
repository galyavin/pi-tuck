"""Share of the tokens of the abort-check style sets that were recall results (tuck_recall and tuck_search results).
Usage: recall_share.py DIR [DIR ...]   (each DIR holds *.jsonl, or tuck/ and tuck-lexical/ folders, of set records with a `trace`)
Per set: recall-result tokens (characters of the results / 4, Pi's own estimate; characters are those of the JSON content, a little above the text), the fresh input tokens the server counted
(sum of `input` over requests: the part of each prompt that was not read from the cache), the processed prompt tokens (input + cache read), output tokens; and the shares
recall / fresh input and recall / processed prompt. A recall result stays in the prompt until a cut drops it, so the second share counts it once per request that carried it."""
import glob
import json
import sys

rows = []
for d in sys.argv[1:]:
    for f in sorted(glob.glob(d + "/*.jsonl") + glob.glob(d + "/*/*.jsonl")):
        if "attempt1" in f:
            continue
        r = json.loads(open(f).readline())
        tr = r.get("trace", [])
        recall = sum(t["chars"] for t in tr if t["role"] == "toolResult" and t.get("tool") in ("tuck_recall", "tuck_search")) / 4
        other = sum(t["chars"] for t in tr if t["role"] == "toolResult" and t.get("tool") not in ("tuck_recall", "tuck_search")) / 4
        asst = [t for t in tr if t["role"] == "assistant"]
        fresh = sum((t["usage"] or {}).get("input", 0) for t in asst)
        cache = sum((t["usage"] or {}).get("cacheRead", 0) for t in asst)
        out = sum((t["usage"] or {}).get("output", 0) for t in asst)
        rows.append((f.replace("runs/", ""), recall, other, fresh, cache, out))
print("set | recall-result tokens | other tool-result tokens | fresh input | processed prompt (input + cache read) | output | recall / fresh input | recall / processed prompt")
tot = [0, 0, 0, 0, 0]
for name, recall, other, fresh, cache, out in rows:
    print(f"{name} | {recall:,.0f} | {other:,.0f} | {fresh:,} | {fresh + cache:,} | {out:,} | {100 * recall / fresh:.0f}% | {100 * recall / (fresh + cache):.1f}%")
    for i, v in enumerate((recall, other, fresh, cache, out)):
        tot[i] += v
print(f"all {len(rows)} sets | {tot[0]:,.0f} | {tot[1]:,.0f} | {tot[2]:,} | {tot[2] + tot[3]:,} | {tot[4]:,} | {100 * tot[0] / tot[2]:.0f}% | {100 * tot[0] / (tot[2] + tot[3]):.1f}%")
