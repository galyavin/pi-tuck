import json
import os
import sys

if not sys.dont_write_bytecode or os.path.realpath(os.environ["TMPDIR"]) != os.getcwd():
    raise RuntimeError("worker must disable bytecode and own temp storage")
runtime = os.path.realpath(os.environ["PI_SEMANTIC_RUNTIME_ROOT"])
if os.path.commonpath([os.getcwd(), runtime]) == runtime:
    raise RuntimeError("scratch cannot be inside immutable assets")
if os.name == "nt" and not os.path.isdir(os.environ["SYSTEMROOT"]):
    raise RuntimeError("worker requires the preserved Windows system directory")

for line in sys.stdin:
    request = json.loads(line)
    if request["op"] != "ready":
        raise RuntimeError("unexpected readiness fixture RPC")
    print(json.dumps({
        "id": request["id"], "ok": True,
        "result": {"identity": "ready-fixture", "dimensions": 768, "maxTokens": 8192, "offline": True},
    }), flush=True)
