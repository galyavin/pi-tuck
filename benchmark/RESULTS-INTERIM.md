# Interim numbers: cut latency and context carried

**Interim, 2026-10-31 about 10:00 CDT. Not final, not the benchmark's claims.** The full run is still going (see `PREREG.md` for what the final claims are and `DEVIATIONS.md` for what changed). This note states only the two measurements below, with the conditions they were taken under. Retention accuracy, task success and token totals are deliberately not given here: they are not final.

Everything here is pi-tuck **1.0.1** (commit `d71234a`, see `PINS.md`) against **Pi 1.4.0's built-in compaction**, on SWE-bench Verified task chains of 30 tasks, with a 131,072-token window (128,000 in replay) and a 32,768 reply reserve.

## 1. Live cut latency (main run)

Two Pi sessions per chain on the same 30 tasks: arm A with Pi's built-in compaction, arm B with pi-tuck. Model `mac-studio/main` (a local model on one machine, thinking `xhigh`), the same one that writes Pi's summaries. Chains `s01`-`s05` are finished in both arms (150 tasks per arm).

| | cuts | chains | median seconds per cut | 90th percentile | context carried after a cut (median) |
|---|---|---|---|---|---|
| Pi built-in (A) | 27 | 5 | 268.8 | 421.6 | 29,241 tokens |
| pi-tuck (B) | 27 | 5 | 0.087 | 0.205 | 27,751 tokens |

How the time is measured: from the session file, the time between the entry written just before the cut and the compaction entry (`analysis/sessionlog.py`). For arm A this equals Pi's own `compaction_start`/`compaction_end` duration on every cut checked. For arm B it is an **upper bound** on the cut time: pi-tuck's tool-loop cuts emit no compaction events, so it cannot be taken from events, and the gap includes anything between the last message and the cut. Context carried is the summary plus kept messages by Pi's own chars/4 estimate (`replay/live_after.ts`), the same measure in both arms.

Conditions that matter for the arm A figure: the summary is one call to the local model at `xhigh` thinking, on a server that was serving four live sessions and replay jobs at the same time, so the absolute seconds depend on that model and load. The arm B figure does not call a model.

## 2. Paired replay (the full run's method)

The same recorded sessions are cut at identical positions by each compactor (`PREREG.md`, "Paired replay"). Recordings are the live arms' own sessions. The local summarizer is `mac-studio/main` (`xhigh`), the frontier summarizer `openai/gpt-6-astra` (`high`, ChatGPT-plan access). The six recordings `s01`-`s03` (both arms) are the ones all three have finished; pi-tuck has also run on `s04`-`s05`.

| compactor | recordings | cuts | median seconds per cut | range (seconds) | context carried after a cut: median (range), tokens |
|---|---|---|---|---|---|
| pi-tuck | 6 | 29 | 0.065 | 0.008 to 0.48 | 27,514 (11,885 to 44,372) |
| pi-tuck | 10 | 52 | 0.062 | 0.005 to 0.48 | 28,006 (10,260 to 44,372) |
| local summarizer | 6 | 28 | 193.4 | 77.3 to 413.3 | 26,424 (21,925 to 42,740) |
| frontier summarizer | 6 | 29 | 96.1 | 39.1 to 267.8 | 25,555 (22,342 to 35,579) |

One local-summarizer cut was refused by Pi and is not counted. Before a cut the sessions carried a median of about 76,000 to 80,000 tokens in all three groups. The pi-tuck time is the harness timing of the deterministic draft; it excludes the embedding index, which starts on the first search and is not part of the cut.

**Pilot, for reference only** (3 recordings, 13 cuts per compactor, a denser schedule with a first cut at 45,000 raw tokens and one every 15,000, so smaller contexts): pi-tuck median 0.006 s (0.002 to 0.023), local summarizer 134.0 s (49.9 to 183.0), frontier summarizer 47.4 s (33.6 to 75.6); context carried after a cut 12,333, 23,310 and 23,025 tokens.

## Provenance

Computed from `runs/live/s01`-`s05` and `runs/replay/s01`-`s05` by `analysis/live_stats.py` and `analysis/replay_stats.py`, plus the per-recording `cuts-*.json` files; the raw data goes to a release asset when the run ends (see `README.md` once written). Numbers will move as the run completes.
