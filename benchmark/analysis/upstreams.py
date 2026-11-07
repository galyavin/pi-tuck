"""Which OpenRouter upstream served a run's requests (PREREG-32K.md pins one; this checks it, read-only).

Usage: upstreams.py FOLDER... [--sample 40 | --all]
Samples assistant responseIds from each folder's events.jsonl and asks OpenRouter's generation endpoint for the provider. Needs OPENROUTER_API_KEY.
With --all every request is looked up and the per-request log is written to FOLDER/upstreams.jsonl (one line per request: responseId, provider)."""
import argparse
import sys

parser = argparse.ArgumentParser()
parser.add_argument("folders", nargs="+")
parser.add_argument("--sample", type=int, default=40)
parser.add_argument("--all", action="store_true")
args = parser.parse_args()
sys.exit("OpenRouter is not used: mac-studio only: upstreams.py calls OpenRouter's generation endpoint; recorded upstreams.jsonl files stay as evidence")
