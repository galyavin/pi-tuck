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
# The Pi-defaults arm (PREREG-DEFAULTS.md): the main run's model with the window forced to 32,768 and Pi's own default compaction settings
# (settings-defaults.js: reserveTokens 16,384, keepRecentTokens 20,000), so that keepRecentTokens is larger than the 16,384-token room.
W32M = {"window": 32768, "max_tokens": 16384, "compaction": {"enabled": True, "reserveTokens": 16384, "keepRecentTokens": 20000}}
# The mac-studio gates and the thinking-level pilot (suite w32g): the same model entry and window, with the 32k suite's own compaction settings (keepRecentTokens 3,333).
W32G = {**W32M, "compaction": {"enabled": True, "reserveTokens": 16384, "keepRecentTokens": 3333}}
# The gate of the adaptive candidate (PREREG-ADAPTIVE.md), on the new model setup: the same model entry with the window forced to its 81,920 tokens, Pi's default compaction settings
# (reserveTokens 16,384, keepRecentTokens 20,000) and the 16,384-token output cap.
W81 = {"window": 81920, "max_tokens": 16384, "compaction": {"enabled": True, "reserveTokens": 16384, "keepRecentTokens": 20000}}
SUITES = {"main": {"root": "live", "model": MODEL, "thinking": THINKING, "health": None},
          "w32": {"root": "live32", "model": W32["model"], "thinking": W32["thinking"], "health": "https://openrouter.ai/api/v1/models"},
          "w32m": {"root": "live32m", "model": MODEL, "thinking": THINKING, "health": None},
          "w32g": {"root": "live32g", "model": MODEL, "thinking": THINKING, "health": None},
          "w81": {"root": "live81", "model": MODEL, "thinking": THINKING, "health": None}}


def refuse_openrouter(what: str):
    """OpenRouter is not used (mac-studio only). Every path that would start a run on OpenRouter ends here, at start.
    Recorded OpenRouter results stay readable: only the run paths call this."""
    raise SystemExit(f"OpenRouter is not used: mac-studio only: {what}")


def assert_mac_studio_only(model: str, agent_dir_path: "Path | None" = None):
    """Refuse a model spec, a suite or an agent dir that would reach OpenRouter (the provider name in the spec, the default provider or any provider entry)."""
    if "openrouter" in model.lower():
        refuse_openrouter(f"model {model}")
    if agent_dir_path is not None:
        for name in ("settings.json", "models.json"):
            f = agent_dir_path / name
            if f.exists() and "openrouter" in f.read_text().lower():
                refuse_openrouter(f"{f} names OpenRouter")


def dataset():
    return {r["instance_id"]: r for r in json.loads(DATASET.read_text())}


def sh(args, input=None, check=True, timeout=None):
    return subprocess.run(args, input=input, capture_output=True, text=True, check=check, timeout=timeout)


def write_config(path: Path, text: str):
    """Write a shared agent-folder file without a window in which a reader sees it empty: arms that start together write the same files, and `write_text` truncates first (a second arm read an empty models.json and died at start on 2026-11-06). An unchanged file is left alone; a changed one is replaced in one step."""
    if path.exists() and path.read_text() == text:
        return
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(text)
    os.replace(tmp, path)


TUCK_ARMS = ("B", "C", "D", "E", "F", "G", "H", "J", "K", "N", "P", "Q", "T", "V", "W", "X", "Y", "Z", "S", "U", "L", "O")  # arms that load a pi-tuck build (D, E: clip gate, not run; F, G: PREREG-V108.md; H, J: PREREG-CUTLATER.md; K: PREREG-DEFAULTS.md; N: its rerun on the fix build; P, Q: PREREG-V110.md; V, W: PREREG-CUTLATER2.md; X: the Pi-defaults check on 1.0.11; Y, Z: PREREG-V111.md; S, U: PREREG-PILOT.md)


def agent_dir(arm: str, suite: str = "main") -> Path:
    """An isolated PI_CODING_AGENT_DIR per arm: the mac-studio model entry and the shared compaction settings, no packages, no
    extensions and no credentials (the model's key comes from STUDIO_API_KEY). The user's global settings never load."""
    if suite == "w32":
        return agent_dir_w32(arm)
    if suite == "w32m":
        return agent_dir_w32m(arm)
    if suite == "w32g":
        return agent_dir_w32m(arm, W32G, "w32g")
    if suite == "w81":
        return agent_dir_w32m(arm, W81, "w81")
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
    write_config(path / "models.json", json.dumps({"providers": {"mac-studio": provider}}, indent=1))
    write_config(path / "settings.json", json.dumps({
        "compaction": COMPACTION, "retry": RETRY, "defaultProvider": "mac-studio", "defaultModel": "main", "defaultThinkingLevel": THINKING,
        "quietStartup": True, "packages": [], "extensions": [],
    }, indent=1))
    return path


def agent_dir_w32(arm: str, cfg: dict = W32, suite: str = "w32") -> Path:
    """Same shape as the main run's agent dirs, with the forced 32k model entry. The pi-tuck arms (TUCK_ARMS) get the semantic runtime the main run's
    arm B already provisioned, cloned (copy-on-write) so the two suites never share files that change."""
    refuse_openrouter("agent_dir_w32 builds the DeepSeek-on-OpenRouter agent dir")


def agent_dir_w32m(arm: str, cfg: dict = W32M, suite: str = "w32m") -> Path:
    """The main run's mac-studio model entry with the window forced to 32,768 and Pi's default compaction settings; pi-tuck arms get the cloned semantic runtime."""
    path = RUNS / "agent" / f"{arm}-{suite}"
    path.mkdir(parents=True, exist_ok=True)
    provider = json.loads((PI_AGENT / "models.json").read_text())["providers"]["mac-studio"]
    assert provider["apiKey"].startswith("${"), "the mac-studio key must be an environment reference, never a literal"
    provider["models"] = [{**m, "contextWindow": cfg["window"], "maxTokens": cfg["max_tokens"]} if m["id"] == "main" else m for m in provider["models"]]
    write_config(path / "models.json", json.dumps({"providers": {"mac-studio": provider}}, indent=1))
    write_config(path / "settings.json", json.dumps({
        "compaction": cfg["compaction"], "retry": RETRY, "defaultProvider": "mac-studio", "defaultModel": "main", "defaultThinkingLevel": THINKING,
        "quietStartup": True, "packages": [], "extensions": [],
    }, indent=1))
    runtime = path / "pi-tuck"
    if arm in TUCK_ARMS and not runtime.exists():
        runtime.mkdir()
        for part in ("python", "runtime"):
            subprocess.run(["cp", "-c", "-R", str(RUNS / "agent" / "B" / "pi-tuck" / part), str(runtime / part)], check=True)
        (runtime / "index").mkdir()
    return path


def agent_dir_recall() -> Path:
    """Agent dir for the recall and LongMemEval benchmarks (PREREG-RECALL.md, PREREG-LME.md): the same pinned DeepSeek snapshot and upstream, the
    window left at the model's own, and the semantic runtime cloned from arm B's."""
    refuse_openrouter("agent_dir_recall builds the DeepSeek-on-OpenRouter agent dir")
