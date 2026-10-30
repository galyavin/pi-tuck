# Changelog

All notable changes to pi-tuck. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-10-30

First release on npm and the Pi package gallery.

### Added

- Semantic search is on by default. Its local runtime (EmbeddingGemma-2, llama.cpp, a standalone CPython) is downloaded once, in the
  background, from pinned public sources, each file checked against its SHA-256. Turn it off with `{"semanticRecall": false}` in
  `~/.pi/agent/pi-tuck.json`.
- Runs started by a custom message (Pi 1.4) are budgeted by that message.
- Sessions written by pi-vcc-based compactors (`VCC-TRANSCRIPT/1` summaries, `vcc_recall` and `vcc_search` calls) are read as this
  format, with tool names updated for the model.

### Changed

- Summaries keep the whole dialogue, a list of the files read, written or edited, and the session's first prompt word for word, and end
  with an instruction to re-read files before editing them. They stay small as a session grows, where 0.2.1's re-rendered the whole tool
  history at every compaction. The ranked view remains as the fallback when the dialogue does not fit.
- Tools are renamed `tuck_recall` and `tuck_search` (from `pi_tuck_recall` and `pi_tuck_search`), and commands `/tuck-semantic` and
  `/tuck-incident`. Summaries are headed `TUCK-TRANSCRIPT/1`.
- Tested against Pi 1.1.0's and 1.4.0's libraries.

### Fixed

- On Pi 1.4, a prompt that needed a cut hung the session: Pi now counts a run as started before `before_agent_start`, and a
  compaction asked for there waited on that run. The cut is made when the prompt arrives, while Pi is still idle.
- A revoked source that stops semantic recall records why, instead of reading as recall that was never switched on.

### Removed

- The bounded, masked and full summary views; the dialogue view replaces them.
- The external `~/.config/pi/semantic-recall.json` configuration and `PI_SEMANTIC_RECALL_CONFIG`.

## [0.2.1] - 2026-10-24

Source preview on GitHub, not published to npm. Deterministic compaction with `pi_tuck_recall` and `pi_tuck_search`; semantic search
opt-in, with a runtime the user had to supply.

[1.0.0]: https://github.com/galyavin/pi-tuck/releases/tag/v1.0.0
[0.2.1]: https://github.com/galyavin/pi-tuck/tree/e00fa99
