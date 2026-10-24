import json
import os
import sys
import time

request = json.loads(sys.stdin.buffer.readline())
if request.get("op") != "ready":
    raise RuntimeError("expected ready request")
if not sys.dont_write_bytecode or os.path.realpath(os.environ['TMPDIR']) != os.getcwd():
    raise RuntimeError("worker must disable bytecode and own temp storage")
runtime = os.path.realpath(os.environ['PI_SEMANTIC_RUNTIME_ROOT'])
if os.path.commonpath([os.getcwd(), runtime]) == runtime:
    raise RuntimeError("scratch cannot be inside immutable assets")

# Close the read end before replying so the host's next RPC reliably gets EPIPE.
os.close(0)
print(json.dumps({
    "id": request["id"],
    "ok": True,
    "result": {"identity": "stdin-closed-fixture", "dimensions": 768, "maxTokens": 8192, "offline": True},
}), flush=True)

# Stay alive until the controller terminates the owned process group.
while True:
    time.sleep(1)
