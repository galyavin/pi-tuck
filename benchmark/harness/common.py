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
# OpenRouter's deepseek flash with its context forced to 32,768 and its replies capped at 8,192, so every arm's reserve is 8,192 and the room
# 24,576 (Pi takes the larger of reserveTokens and the model's output cap). A 16,384 reserve was tried first and pi-tuck refused ("mandatory
# context cannot fit": its tool schemas and the task prompt leave too little of a 16k room); see PREREG-32K.md. keepRecentTokens keeps the main
# run's share of the room: 20,000 of 98,304 -> 5,000 of 24,576. The key comes from OPENROUTER_API_KEY; nothing is written to disk.
W32 = {"model": "openrouter/~deepseek/deepseek-flash-latest", "thinking": "high", "window": 32768, "max_tokens": 8192,
       "compaction": {"enabled": True, "reserveTokens": 8192, "keepRecentTokens": 5000}}
# Diagnostic only, never a result: the same suite with the 16,384 reserve first tried, to see which pi-tuck builds refuse in a 16k room.
W32R16 = {**W32, "max_tokens": 16384, "compaction": {"enabled": True, "reserveTokens": 16384, "keepRecentTokens": 3333}}
SUITES = {"main": {"root": "live", "model": MODEL, "thinking": THINKING, "health": None},
          "w32": {"root": "live32", "model": W32["model"], "thinking": W32["thinking"], "health": "https://openrouter.ai/api/v1/models"},
          "w32r16": {"root": "live32-r16", "model": W32["model"], "thinking": W32["thinking"], "health": "https://openrouter.ai/api/v1/models"}}


def dataset():
    return {r["instance_id"]: r for r in json.loads(DATASET.read_text())}


def sh(args, input=None, check=True, timeout=None):
    return subprocess.run(args, input=input, capture_output=True, text=True, check=check, timeout=timeout)


def agent_dir(arm: str, suite: str = "main") -> Path:
    """An isolated PI_CODING_AGENT_DIR per arm: the mac-studio model entry and the shared compaction settings, no packages, no
    extensions and no credentials (the model's key comes from STUDIO_API_KEY). The user's global settings never load."""
    if suite in ("w32", "w32r16"):
        return agent_dir_w32(arm, W32R16 if suite == "w32r16" else W32, suite)
    path = RUNS / "agent" / arm
    path.mkdir(parents=True, exist_ok=True)
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
        cfg["model"].split("/", 1)[1]: {"contextWindow": cfg["window"], "maxTokens": cfg["max_tokens"]}}}}}, indent=1))
    (path / "settings.json").write_text(json.dumps({
        "compaction": cfg["compaction"], "retry": RETRY, "defaultProvider": "openrouter", "defaultModel": cfg["model"].split("/", 1)[1],
        "defaultThinkingLevel": cfg["thinking"], "quietStartup": True, "packages": [], "extensions": [],
    }, indent=1))
    runtime = path / "pi-tuck"
    if arm in ("B", "T") and not runtime.exists():
        runtime.mkdir()
        for part in ("python", "runtime"):  # the encoder and its environment; the per-session index and sockets start empty
            subprocess.run(["cp", "-c", "-R", str(RUNS / "agent" / "B" / "pi-tuck" / part), str(runtime / part)], check=True)
        (runtime / "index").mkdir()
    return path
