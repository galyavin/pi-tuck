"""Shared paths and helpers for the live runs."""
import json
import os
import subprocess
from pathlib import Path

BENCH = Path(__file__).resolve().parent.parent
RUNS = BENCH / "runs"
DATASET = RUNS / "swebench_verified.json"
IMAGE = "ghcr.io/epoch-research/swe-bench.eval.arm64.{}:latest"
PI_AGENT = Path.home() / ".pi" / "agent"

# Every arm gets the same model entry, reserve and compaction settings (PREREG "Live runs").
MODEL = "mac-studio/main"
THINKING = "xhigh"
COMPACTION = {"enabled": True, "reserveTokens": 32768, "keepRecentTokens": 20000}
# mac-studio answers 429 "capacity is full" when too many streams run at once; every arm waits and retries instead of failing the turn.
RETRY = {"enabled": True, "maxRetries": 40, "baseDelayMs": 5000, "maxAgentDelayMs": 60000}


# The 32k suite (PREREG-32K.md): the same chains, harness and grader at a window small enough that a cut must summarise work in progress.
# DeepSeek V4.1 Flash, the dated snapshot (not the moving "-latest" alias), pinned to ONE OpenRouter upstream with no fallback: upstreams count tokens
# differently (with pi-tuck's tool schemas Wafer reported 5,715 prompt tokens where the others said about 2,160), and pi-tuck calibrates on the reported
# usage. DigitalOcean counts like the majority and answered about four times faster than the other candidate tested (Morph).
# The window is forced to 32,768 and replies capped at 16,384, so every arm's reserve is 16,384 and the room 16,384 (Pi takes the larger of reserveTokens
# and the model's output cap). keepRecentTokens keeps the main run's share of the room: 20,000 of 98,304 -> 3,333 of 16,384. The key comes from
# OPENROUTER_API_KEY; nothing is written to disk.
DEEPSEEK_ID = "deepseek/deepseek-v4.1-flash-1017"
UPSTREAM = "DigitalOcean"
ROUTING = {"only": [UPSTREAM], "allow_fallbacks": False}
W32 = {"model": f"openrouter/{DEEPSEEK_ID}", "thinking": "high", "window": 32768, "max_tokens": 16384,
       "compaction": {"enabled": True, "reserveTokens": 16384, "keepRecentTokens": 3333}}
SUITES = {"main": {"root": "live", "model": MODEL, "thinking": THINKING, "health": None},
          "w32": {"root": "live32", "model": W32["model"], "thinking": W32["thinking"], "health": "https://openrouter.ai/api/v1/models"}}


def dataset():
    return {r["instance_id"]: r for r in json.loads(DATASET.read_text())}


def sh(args, input=None, check=True, timeout=None):
    return subprocess.run(args, input=input, capture_output=True, text=True, check=check, timeout=timeout)


def agent_dir(arm: str, suite: str = "main") -> Path:
    """An isolated PI_CODING_AGENT_DIR per arm: the mac-studio model entry and the shared compaction settings, no packages, no
    extensions and no credentials (the model's key comes from STUDIO_API_KEY). The user's global settings never load."""
    if suite == "w32":
        return agent_dir_w32(arm)
    path = RUNS / "agent" / arm
    path.mkdir(parents=True, exist_ok=True)
    if arm == "C" and not (path / "pi-tuck").exists():  # arm C is pi-tuck 1.0.3 with the semantic runtime arm B provisioned, cloned
        (path / "pi-tuck").mkdir()
        for part in ("python", "runtime"):
            subprocess.run(["cp", "-c", "-R", str(RUNS / "agent" / "B" / "pi-tuck" / part), str(path / "pi-tuck" / part)], check=True)
        (path / "pi-tuck" / "index").mkdir()
    models = json.loads((PI_AGENT / "models.json").read_text())["providers"]
    provider = models["mac-studio"]
    assert provider["apiKey"].startswith("${"), "the mac-studio key must be an environment reference, never a literal"
    (path / "models.json").write_text(json.dumps({"providers": {"mac-studio": provider}}, indent=1))
    (path / "settings.json").write_text(json.dumps({
        "compaction": COMPACTION, "retry": RETRY, "defaultProvider": "mac-studio", "defaultModel": "main", "defaultThinkingLevel": THINKING,
        "quietStartup": True, "packages": [], "extensions": [],
    }, indent=1))
    return path


def agent_dir_w32(arm: str, cfg: dict = W32, suite: str = "w32") -> Path:
    """Same shape as the main run's agent dirs, with the forced 32k model entry. Arms B and T (pi-tuck) get the semantic runtime the main run's
    arm B already provisioned, cloned (copy-on-write) so the two suites never share files that change."""
    path = RUNS / "agent" / f"{arm}-{suite}"
    path.mkdir(parents=True, exist_ok=True)
    (path / "models.json").write_text(json.dumps({"providers": {"openrouter": {"modelOverrides": {
        cfg["model"].split("/", 1)[1]: {"contextWindow": cfg["window"], "maxTokens": cfg["max_tokens"], "compat": {"openRouterRouting": ROUTING}}}}}}, indent=1))
    (path / "settings.json").write_text(json.dumps({
        "compaction": cfg["compaction"], "retry": RETRY, "defaultProvider": "openrouter", "defaultModel": cfg["model"].split("/", 1)[1],
        "defaultThinkingLevel": cfg["thinking"], "quietStartup": True, "packages": [], "extensions": [],
    }, indent=1))
    runtime = path / "pi-tuck"
    if arm in ("B", "C", "T") and not runtime.exists():
        runtime.mkdir()
        for part in ("python", "runtime"):  # the encoder and its environment; the per-session index and sockets start empty
            subprocess.run(["cp", "-c", "-R", str(RUNS / "agent" / "B" / "pi-tuck" / part), str(runtime / part)], check=True)
        (runtime / "index").mkdir()
    return path


def agent_dir_recall() -> Path:
    """Agent dir for the recall and LongMemEval benchmarks (PREREG-RECALL.md, PREREG-LME.md): the same pinned DeepSeek snapshot and upstream, the
    window left at the model's own, and the semantic runtime cloned from arm B's."""
    path = RUNS / "agent" / "R"
    (path / "pi-tuck" / "index").mkdir(parents=True, exist_ok=True)
    (path / "models.json").write_text(json.dumps({"providers": {"openrouter": {"modelOverrides": {DEEPSEEK_ID: {"compat": {"openRouterRouting": ROUTING}}}}}}, indent=1))
    (path / "settings.json").write_text((RUNS / "agent" / "B" / "settings.json").read_text())
    for part in ("python", "runtime"):
        if not (path / "pi-tuck" / part).exists():
            subprocess.run(["cp", "-c", "-R", str(RUNS / "agent" / "B" / "pi-tuck" / part), str(path / "pi-tuck" / part)], check=True)
    return path
