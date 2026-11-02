# Changelog

All notable changes to pi-tuck. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [1.0.9] - 2026-11-01

### Changed

- pi-tuck needs Pi 1.2.0 or later, the oldest Pi that has every hook it uses and that its tests pass on. On an older Pi, pi-tuck stays off,
  Pi's own compaction runs, and pi-tuck says so once.

### Fixed

- Semantic recall is Metal only, and now checks it. pi-tuck's own embedding server serves on the CPU, with only a log line, when it finds no
  Metal device; before starting it, pi-tuck asks it for its devices and turns semantic recall off with "Semantic recall needs Metal; word
  recall still works" when none is Metal. An embedding server a host configures is its owner's choice and is not checked.
- `tuck_search` takes a result back as returned: each entry of `priorResults` is a source's `sourceSha` and `read`, unchanged. It asked for
  `start` and `end`, which no result carried.

### Known issue

- Affects 1.0.8 and 1.0.9. At a small window, Pi's default `compaction.keepRecentTokens` (20,000) can exceed pi-tuck's input room (the window
  less the larger of `compaction.reserveTokens` and the model's maximum output; 16,384 at a 32k window with the default reserve). After a
  run that is stopped (Esc, or a time limit) with the context above the room, every later prompt can be refused with "The request needs a cut
  and Pi has none to make (Nothing to compact (session too small))", and the session stays stuck. Workaround until 1.0.10: set
  `"compaction": {"keepRecentTokens": N}` in Pi's `settings.json` (or `compaction.modelOverrides["provider/model"].keepRecentTokens` for one
  model), with N well below the room. Windows of 128k and up are not affected at the defaults. 1.0.10 is planned to fix this: pi-tuck will
  make prompt-time cuts itself. Evidence: in one check at these defaults (1.0.8, 32k window, one session of 30 tasks, one model), 28 tasks
  were lost ([`benchmark/RESULTS-DEFAULTS.md`](benchmark/RESULTS-DEFAULTS.md)); it shows that the failure occurs, not how often.

## [1.0.8] - 2026-11-01

### Fixed

- A fresh tool result too large for the room no longer refuses the run. The request carries the result's head and tail instead, with a
  `tuck_recall` locator to the rest; a round of parallel results shares one clip budget. The clip ends with its run.
- A prompt right after a cut is no longer refused when Pi has nothing to compact for it. When a run ends at or above the cut band, pi-tuck
  cuts there itself, so the next prompt starts below the band. A run-end cut that cannot be planned is no fault.
- Gates: on 29 replayed recordings, no task lost and no request refused, where 1.0.6 refused 8; live at a 32k window (60 tasks), no dead task
  and no mid-run refusal, and 46 resolved, as 1.0.7 ([`benchmark/RESULTS-V108.md`](benchmark/RESULTS-V108.md)).

## [1.0.7] - 2026-11-01

### Changed

- Semantic recall runs on Metal only, so only on Apple silicon. The CPU fallback is gone. Where the embedding server cannot start on Metal (a
  VM, a Mac without a GPU), semantic recall goes off with "Semantic recall needs Metal; word recall still works", and word recall keeps
  answering.
- Off Apple silicon (Linux, Intel Macs), pi-tuck compacts and offers word recall only: `tuck_search` is no longer registered, `tuck_recall`'s
  description no longer points to it, and nothing is downloaded. On Apple silicon both tools are as before.

## [1.0.6] - 2026-11-01

### Changed

- Semantic recall embeds on the GPU (Metal) on Apple silicon. The pinned llama.cpp build already includes Metal, but pi-tuck started it on the
  CPU only. On an Apple M5 under heavy load (load average 44-76), a batch of 8 passages took a median 38.6 s on the CPU and 0.69 s on Metal,
  56 times faster, with nearly the same vectors (97.9% top-10 overlap with the CPU's). Indexing therefore finishes, and `tuck_search` ranks
  by meaning instead of falling back to keywords. Where Metal cannot start (a VM, CI, no GPU), the same server starts on the CPU. The
  installed runtime is kept; each session's index is rebuilt once.

### Fixed

- Semantic recall no longer switches itself off on a busy machine. The worker's start (Python, the runtime check, the model load) now has
  its own deadline instead of the 60 s per-call limit, and an embed call's deadline grows with the number of texts it carries, so a slow
  machine slows indexing down instead of making it fail. A worker that still fails is retried in the same session and recovers once the
  machine is free.

## [1.0.5] - 2026-10-31

### Fixed

- One oversize tool result no longer leaves a session unusable. A fresh tool round larger than the input room is still refused, since it must
  reach the model whole; but after that run ended (its reply aborted, or hidden by Pi when it recovered from an overflow), the result was
  still treated as not yet seen and kept whole, so
  every later prompt was refused, and a manual `/compact` refused too. Once the session moves on (a new prompt, a manual `/compact`, or a
  run a custom message starts) it is now ordinary history, and the next cut summarizes it; `tuck_recall` still reads it in full.
- A cut that is needed when Pi has nothing to compact (no history older than its `keepRecentTokens` since the last cut) now refuses that
  request only. Before, Pi's "Nothing to compact" or "Already compacted" stayed as a fault, and every later prompt of the session failed on it.
- No failure outlives its attempt: after any refusal or fault, the next prompt, a manual cut or the end of the run plans afresh from the
  session as it is. Before, a fault other than a refusal stayed until the session restarted. The one exception is a cut pi-tuck supplied that
  Pi then failed to write: the session may hold a cut its file lacks, so that fault still stays until the session restarts.
- A refusal no longer turns semantic recall off. Background indexing read any compaction failure as the host revoking access, so it disabled
  semantic recall and deleted its index for the rest of the session.

## [1.0.4] - 2026-10-31

### Changed

- When pi-tuck refuses a request because it cannot fit, and the provider has counted far more input than pi-tuck estimates (1.5 times or
  more), the notice now says so and suggests that a different upstream may count less. Behind a router such as OpenRouter, one upstream can
  spend about twice the context of others on tool schemas, which is what made pi-tuck refuse at a 32k window with a 16k reserve.

### Fixed

- An omission notice lists each omitted message's locator once: when several text blocks of one message were shortened to nothing, repeats
  could crowd the list and drop its "Locator list incomplete" flag.
- A refusal no longer outlives the attempt it was for. When pi-tuck refused a request (a host view or a fresh tool round larger than the
  input room, or a cut it could not make), a later run that no prompt started, such as a custom message that triggers a turn, was aborted
  before its first request until the session restarted, even once there was room, and it reported the old refusal. A refusal that was not for
  want of room was held the same way and also aborted every later prompt. The next run, whatever starts it, now decides afresh.

## [1.0.3] - 2026-10-31

First npm release since 1.0.1: it also carries everything listed under 1.0.2, which was tagged but not published to npm. Releases are
now published from GitHub Actions by npm trusted publishing, with provenance.

### Added

- `"cutAt"` in `pi-tuck.json` (and the `cutAt` option of `installCompaction`) sets the fraction of the input room at which a cut is triggered and
  planned: a number above 0 and at most 1. The room still decides every refusal. A cut's receipt records `cutAt` when it is not 1.

### Changed

- Cuts happen once a request passes 60% of the input room (`cutAt` 0.6) instead of just under the whole room. Each cut leaves room to grow,
  so fewer tokens are carried per request: in paired replays against cutting at the full room, answers held and billed input fell about 17%
  at a 128k window and 10-14% at 32k, with prompt caching automatic or by explicit breakpoints. `{"cutAt": 1}` restores the earlier point.

## [1.0.2] - 2026-10-31

Tagged, not published to npm; 1.0.3 ships it.

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

- A long session whose dialogue no longer fit the summary stalled for tens of seconds at every cut, because the ranked view re-rendered
  the whole candidate summary for each block it considered. It now keeps the summary's size up to date as blocks join, so a cut takes
  well under a second and grows linearly with the session: 72 s before and 174 ms after at 3,888 entries, measured on one machine with the
  same synthetic session. Summaries are byte for byte the same.

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

[1.0.4]: https://github.com/galyavin/pi-tuck/releases/tag/v1.0.4
[1.0.3]: https://github.com/galyavin/pi-tuck/releases/tag/v1.0.3
[1.0.2]: https://github.com/galyavin/pi-tuck/tree/v1.0.2
[1.0.1]: https://github.com/galyavin/pi-tuck/releases/tag/v1.0.1
[1.0.0]: https://github.com/galyavin/pi-tuck/tree/v1.0.0
[0.2.1]: https://github.com/galyavin/pi-tuck/tree/e00fa99
