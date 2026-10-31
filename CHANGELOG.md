# Changelog

All notable changes to pi-tuck. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [1.0.2] - 2026-10-31

Measured before release with paired replays against 1.0.1 (same sessions, same model as agent and judge): no loss of answer accuracy at
a 128k or a 32k window, and time questions answered as before.

### Changed

- A dialogue that does not fit the summary is now shortened, oldest assistant text first, instead of replaced by a ranked selection of
  records. The newest assistant text that fits a third of the allowance is kept until user prompts have given way; a clip that would keep
  no text is counted in one omission notice instead.
- Records name the time of user turns only; assistant, tool and notice records no longer carry one. Recall still returns every
  source's time.
- Summaries are headed `TUCK-TRANSCRIPT/2` and hold one line of plain text per record (`#12 user @2026-10-30T14:00:00Z: text`) instead
  of one JSON object, which makes them about 30 percent shorter on sessions where the assistant writes little and about 14 percent on
  prose-heavy ones. A passage a clip leaves out names the call that reads it back (`tuck_recall {"index":12,"offset":523}`). Summaries
  saved by 1.0.x (`TUCK-TRANSCRIPT/1`, and `VCC-TRANSCRIPT/1` before them) are read as before and keep their format when a native
  omission filters them.

### Fixed

- In small windows a session that writes little prose cut again almost every tool round (174 cuts in 300 rounds at 32k), because the
  recent turns kept native could fill the whole input room. They now take at most half of it.

## [1.0.1] - 2026-10-30

First release on npm. 1.0.0 was tagged but never published; its notes below describe what 1.0.1 ships besides these changes.

### Added

- Linux support. Compaction and keyword recall work as on macOS; semantic search stays macOS on Apple silicon only.

### Changed

- The `tuck_recall` and `tuck_search` tool descriptions are shorter: about 1,050 tokens per request instead of 1,670. The parameters
  accept the same input.

### Fixed

- A long session whose dialogue no longer fit the summary stalled for tens of seconds at every cut (88 s at 3,900 entries), because
  the ranked view re-rendered the whole candidate summary for each block it considered. It now keeps the summary's size up to date
  as blocks join, so a cut takes well under a second and grows linearly with the session. Summaries are byte for byte the same.

## [1.0.0] - 2026-10-30

Tagged, not published.

### Added

- Semantic search is on by default. Its local runtime (EmbeddingGemma-2, llama.cpp, a standalone CPython) is downloaded once, in the
  background, from pinned public sources, each file checked against its SHA-256. Turn it off with `{"semanticRecall": false}` in
  `~/.pi/agent/pi-tuck.json`.
- Summaries list the agent's other tool calls (shell commands and the like) before the cut, newest first and capped at 30, without
  their output but with a pointer to it, so an agent that writes little prose still sees what it already ran.
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

[1.0.2]: https://github.com/galyavin/pi-tuck/releases/tag/v1.0.2
[1.0.1]: https://github.com/galyavin/pi-tuck/releases/tag/v1.0.1
[1.0.0]: https://github.com/galyavin/pi-tuck/tree/v1.0.0
[0.2.1]: https://github.com/galyavin/pi-tuck/tree/e00fa99
