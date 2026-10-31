"""Grade one SWE-bench Verified patch with the official harness's eval script and log parser, in a fresh container of the instance's
Epoch AI arm64 image. Usage: swe_eval.py INSTANCE_ID PATCH_FILE OUT_JSON  (PATCH_FILE "gold" grades the reference patch)."""
import json
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

from swebench.harness.grading import get_eval_report
from swebench.harness.test_spec.test_spec import make_test_spec

sys.path.insert(0, str(Path(__file__).parent))
from common import IMAGE, dataset  # noqa: E402

EVAL_TIMEOUT = 1800


def grade(instance_id: str, patch: str) -> dict:
    row = dataset()[instance_id]
    spec = make_test_spec(row)
    name = f"tuck-eval-{uuid.uuid4().hex[:8]}"
    started = time.time()
    subprocess.run(["docker", "run", "-d", "--name", name, IMAGE.format(instance_id), "sleep", "infinity"], check=True, capture_output=True)
    try:
        applied = False
        if patch.strip():
            for command in (["git", "apply", "-v", "-"], ["patch", "--batch", "--fuzz=5", "-p1", "-i", "/dev/stdin"]):
                result = subprocess.run(["docker", "exec", "-i", "-w", "/testbed", name, *command], input=patch, capture_output=True, text=True)
                if result.returncode == 0:
                    applied = True
                    break
        if not applied:
            return {"instance_id": instance_id, "resolved": False, "applied": False, "empty": not patch.strip(), "seconds": time.time() - started}
        try:
            run = subprocess.run(["docker", "exec", "-i", name, "bash", "-s"], input=spec.eval_script, capture_output=True, text=True, timeout=EVAL_TIMEOUT)
            log = run.stdout + run.stderr
        except subprocess.TimeoutExpired as error:
            log = (error.stdout or "") + "\nTESTS_TIMEOUT"
        with tempfile.NamedTemporaryFile("w", suffix=".log", delete=False) as handle:
            handle.write(log)
        report = get_eval_report(spec, {"instance_id": instance_id, "model_name_or_path": "pi", "model_patch": patch}, handle.name, True)[instance_id]
        return {"instance_id": instance_id, "resolved": report["resolved"], "applied": True, "empty": False,
                "tests": report.get("tests_status"), "seconds": time.time() - started, "log_tail": log[-4000:]}
    finally:
        subprocess.run(["docker", "rm", "-f", name], capture_output=True)


if __name__ == "__main__":
    instance, patch_file, out = sys.argv[1:4]
    patch = dataset()[instance]["patch"] if patch_file == "gold" else Path(patch_file).read_text()
    Path(out).write_text(json.dumps(grade(instance, patch), indent=1))
