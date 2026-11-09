# Changelog

All notable changes to pi-tuck. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [1.0.19] - 2026-11-09

### Added

- **`/tuck` says in words what pi-tuck is doing in this session:** the version the session loaded (an open session keeps it until Pi restarts),
  how many cuts pi-tuck made and the last one's size before and after, whether the cut point adapts or is fixed by `cutAt`, and how search works
  here. It is a command for the operator; the model sees nothing new.
- **The first-time semantic setup says when it is done.** It announced its download and then said nothing; now it says once that semantic
  recall is set up.

### Changed

- **`/compact` with text after it now cuts.** pi-tuck builds its summary from the session itself, so the text cannot steer it. Before, the cut was
  cancelled, which Pi showed as an error; now pi-tuck makes the cut plain `/compact` makes and says the text was not used.

### Release gates

- **Shipped without a live gate, because its replay matches 1.0.18:** 13,946 requests on 29 recordings, 0 differ, 0 lost and 0 dead tasks, the same
  17 clips. It changes nothing the model sees: `/tuck`, the setup notice and the `/compact` notice are for the operator only. Tests (662), CI, and
  the settings stress test (287 cells, none worse than 1.0.18, no cut over its target).
- Sessions that are open keep the build they started with until they are restarted.

## [1.0.18] - 2026-11-08

### Fixed

- **A summary could drop the task a session was working on (1.0.13 to 1.0.17).** Separate rules decided what a summary quoted and what the kept tail
  held. In a session with many turns, the prompt that set the current task, or the first prompt, could lose its opening after a cut. The settings stress
  test found it 40 times in 32 of its cells on 1.0.16 and 1.0.17. A cut now fills its room by one ranked list, across the summary and the kept tail
  together:
  1. the current prompt, whole;
  2. the openings of the first prompt and the newest answered prompts, sized to the room;
  3. the newest part of the conversation, kept as it is;
  4. the file and action lists;
  5. the rest of the conversation.

  The stress test now finds no lost opening in 287 cells. Dropped turns and tool results are counted with index ranges you can read back with
  `tuck_recall`.

### Changed

- **One number sets how much a cut carries, and the decision to cut reads only amounts.** The quote budget and its fallback steps are gone, and so are
  the rules that compared two versions of a summary. The kept tail is at most half of the 25,000-token tail cap, the size the cut point already assumed.
- **pi-tuck's tools appear only after its first cut.** Before that, there is nothing out of view to recall. Until then a request is byte-identical to one
  without pi-tuck: 254 of 254 requests on replay. Every cut plans room for the tools the requests after it carry.
- **A prompt's late cut is planned when the prompt joins the session,** after other extensions have changed the system prompt and before Pi fixes the
  request's tools. It replaces 1.0.17's reduction in the final guard and keeps its effect: a host section added in any load order is cut, not refused.
- **Cuts compute faster:** about half the time of 1.0.17 on the regression sessions, and 76 ms against 159 ms at 3,888 entries.
- An answered prompt with an image keeps its text opening, and a current prompt of only spaces is kept.

### Correction to 1.0.16

- 1.0.16's notes said its cut rate and cost were unchanged. That held on replay of single-task sessions, but not in live 30-task chains at 81,920
  against 1.0.13. There it took 1.48 times the turns (95% interval 1.34 to 1.64), 74% more cuts and 1.66 times the tokens, with resolved 56 against 55
  ([benchmark/RESULTS-V1016.md](benchmark/RESULTS-V1016.md)). Most of the extra cuts follow from the extra turns. Replay cannot show this cost:
  replay puts 1.0.13 and 1.0.17 within 0.1% of each other.

### Known issues

- On replay of 17 recordings, estimated request time against 1.0.13 is 2.2% higher quiet and 4.2% loaded at 81,920, and 1.1% and 1.9% lower at
  131,072. Billed input moves the same way. At 81,920 each cut carries about 600 more tokens.
- Two stress findings from earlier versions remain: a cut that frees little with a 40,000-token setup at 65,536, and a fresh assistant reply larger than
  the free room.
- Sessions that are open keep the build they started with until they are restarted.

### Release gates

- **Shipped before its live gate, as a fix for lost work.** The gate runs right after release; if it fails, npm and this version are rolled back to
  1.0.17.
- Replay on 29 recordings: 0 lost tasks, 0 dead tasks, 0 faults, every clip read back.
- Tests, CI, the settings stress test (287 cells, no cut over its target), and the shape checks (21 cells at 32,768, 81,920 and 131,072).

## [1.0.17] - 2026-11-08

### Fixed

- **A host that patches a large section into the system prompt could get a refusal a cut would fit (1.0.0 to 1.0.16).** pi-tuck plans a prompt's cut when
  the prompt arrives, before other extensions change the system prompt. A host engine that adds a section of thousands of tokens for one turn, as an
  orchestrator does for its stand-off, could push that turn's first request over the room, and the final guard refused it. The guard now reduces first:
  when the run's first request is over the room and no cut is planned, it plans the prompt's cut there, against the system prompt as finally sent, and
  refuses only if that cut does not fit either. It works whatever order the extensions load in.

### Added

- Stress cells for a host that patches an 8k then 24k system section, at 65,536 and 81,920, registered before and after pi-tuck, with the section arriving
  on a stand-off or on the first step turn after one and removed at the next stand-off. 1.0.16 refuses in the four cells at 81,920; 1.0.17 in none.

### Changed

- When queued input alone exceeds the room, the refusal names it as incoming input that cannot fit, instead of complete context. It still fails closed
  with no cut.

### Release gates

- Replay matches 1.0.16: 0 of 13,946 requests differ on 29 recordings, 0 lost or dead tasks. Shipped without a live gate as a replay-matching patch.
  Tests; CI; the stress test, with no cell worse than 1.0.16.

## [1.0.16] - 2026-11-08

### Fixed

- **A long session could lose the task it was working on (1.0.0 to 1.0.15).** A summary quoted only the session's first user turn, up to 12,000 characters, and the
  newest one. Every other user turn competed in the shrunk dialogue, which in a long session clips user turns to a few words and drops the oldest. In a session
  that runs task after task, the current task is an older turn followed by short steps, so it was clipped or dropped while a finished first task stayed whole,
  and agents acted on a days-old task. Short sessions, and the SWE-bench chains behind our benchmarks, keep each task's prompt in the kept tail and never hit it.
  A summary now quotes user turns from both ends: first the opening of every recent answered turn, then the first prompt's opening (up to 2,000 characters),
  then more of the newest turns, then the rest of the first prompt. A turn that does not fit keeps its opening and a locator to the rest. The budget is 15% of
  the room and never less than 12,000 characters. When room is tight the quotes shrink step by step: the extensions first, then the openings, then the first
  prompt alone as before. A turn pi-tuck refused and that never got a reply is not quoted.

### Added

- The settings stress test checks that the first prompt and the newest 8 answered prompts keep their openings through every cut, with cells for a run of
  tasks at 32,768, tasks followed by long steps, and a long spec followed by 30 steering turns, at 32,768 and 81,920.

### Known issues

- At very small free room (a few thousand tokens or less), quotes give way and an older prompt can still lose its opening: 40 findings in 32 stress cells,
  against 447 in 168 cells on 1.0.15. One sampled cell, with about 1,000 tokens free, loses a short middle prompt that 1.0.15 kept.
- The known issues listed under 1.0.13 still apply.

### Cost

On replay of 17 real single-task sessions, cut rate and cost are unchanged: 7.0 cuts per 100 requests at 131,072 for both builds, and 9.3 at 81,920 (838 cuts
against 837); billed tokens and request time within 0.1%. Those sessions have a median of one prompt, so the new quotes rarely apply there; their cost in a
session of hundreds of turns is not measured.

### Release gates

- **Shipped without a live gate, as a fix for lost work.** Replay differs from 1.0.15, because summaries now quote more: 11,860 of 13,946 requests on 29
  recordings, with 0 dead tasks, 0 refused requests and every clip read back (7 clips, where 1.0.15 had 28: summaries changed where cuts land). Tests; CI;
  the stress test on Pi 1.2.0 and the newest Pi.
- The 32k regression bench makes 74 cuts in 480 rounds, up from 67: sessions with a short first prompt now quote their newest turns too.

## [1.0.15] - 2026-11-08

### Fixed

- `tuck_search` no longer fails a whole search over one bad `priorResults` entry. An entry that does not match the history, such as a made-up hash or an id that is not an entry's, is now ignored, and the notice says how many were. Before, the search returned "Invalid explicit prior source range", and the agent fell back to word search.

### Release gates

- **Shipped without a live gate, because its replay matches 1.0.14:** 13,946 requests on 29 recordings, 0 differ, 0 dead tasks, the same 28 clips. Tests; CI; the stress test on Pi 1.2.0 and the newest Pi, with the same 3 of 274 cells.

## [1.0.14] - 2026-11-07

### Changed

- Internal cleanup across the code, tests and benchmark scripts, with no change to any request.
- The build id in a cut's receipt now follows all the source a build ships.

### Release gates

- **Shipped without a live gate, because its replay matches 1.0.13:** 13,946 requests on 29 recordings, 0 differ, 0 dead tasks, the same 28 clips. A build that changes no request gives a live test nothing to measure. Tests; CI; the stress test on Pi 1.2.0 and the newest Pi, with the same 3 of 274 cells as 1.0.13.

## [1.0.13] - 2026-11-07

### Changed

- **The cut point adapts by itself.** With no `cutAt` set, the band now follows the session: what the setup and the last cut left, plus half a tail of room to
  grow, never below 60% of the room and capped just under the room. Sessions at small windows, or with a large setup, no longer cut every round or two for
  little gain. Larger windows with ordinary setups, such as 131,072 with a 24k setup, stay on 60% and behave almost exactly as before. An explicit `cutAt` keeps today's formula,
  so remove it if you set one by hand for this reason.
- With no `cutAt` set, a cut that isn't due yet must free at least a tenth of the room.
- Internal cleanup: single-use helpers inlined and duplicate paths merged, with no change to any request.

### The trade

On windows that cut too often today, each request carries more context. Cuts, re-processing and request time fall, and billed tokens rise on paid models. On
replay of real sessions at an 81,920 window: 22.3 to 9.3 cuts per 100 requests, request time about 16-20% lower, billed tokens 16-19% higher. At a 65,536 window
it is the worst of these, with billed tokens up by as much as 35%.

### Known issues

- A very large setup at a small window, such as 40k at 65,536, leaves too little free room for any good rhythm: cuts stay frequent and free little.
- A fresh assistant message larger than the free room is refused: nothing can clip it yet. A short next prompt recovers. In an unattended `pi -p` run, a
  refusal ends the run.
- A reply that reports more than the window reads to Pi as a silent overflow; when nothing can be cut, pi-tuck refuses the next prompt, and the prompt after that runs.
- If a provider keeps rejecting requests in a wording Pi does not class as a context overflow, or with a bare HTTP 413, pi-tuck does not recover on its own. Try
  `/compact`.

### Release gates

- Passed: the paired live gate against 1.0.12 on `mac-studio/main` at an 81,920 window, 150 tasks on five chains: resolved 131 against 131, lower bound of the
  difference -1.3 points against a bar of -5, 0 lost tasks ([`benchmark/RESULTS-ADAPTIVE.md`](benchmark/RESULTS-ADAPTIVE.md)). Tests; CI; the stress test on Pi 1.2.0
  and the newest Pi, with 3 of 274 cells reporting the known issues above; frozen replay with 0 dead tasks and every clip read back.
- This release is the exact code the gate measured. Only the version and these notes changed.

## [1.0.12] - 2026-11-06

### Fixed

- **A prompt could be lost, with no notice (1.0.10 and 1.0.11).** When a new prompt arrived over the cut point and pi-tuck's cut kept nothing of the
  conversation before it, which happens when everything since the last cut is one long turn, the prompt was dropped from the request and from the
  saved session. The model never saw it and usually went on with the previous task, so work you asked for could be lost, and could look answered.
  The next prompt ran normally. A fresh one-prompt `pi -p` run could not hit it; a run that resumed a long session could. If you used 1.0.10 or 1.0.11
  and a reply ignored what you had just asked, this is the likely cause. Now the prompt always reaches the model and stays in the session.

### Added

- The settings stress test now fails any prompt missing from a request it opened, or from the session after it: 13 such findings on 1.0.11, none here.

### Known issues

- Correction to the 1.0.11 notes: their count of 4 failing stress cells of 272 understated cut rhythm. With setups that leave a real summary and tail
  after a cut, 1.0.11 cuts too often at small windows, freeing little each time: about 99 cuts in 200 tool rounds at an 81,920 window with a 24k setup.
  It costs time and extra work. An automatic cut point that fixes it is being tested and is not in this release.
- The known issues listed under 1.0.11 still apply.

### Release gates

- **Shipped without a live gate, as a defect that loses work.** Tests and CI passed, and the stress test passed on Pi 1.2.0 and the newest Pi.
- Replay differs from 1.0.11, as it has to: 1,124 of 13,946 requests on 29 recordings, each change starting at the first request of a run, with 0 dead
  tasks, 0 refused requests and the same 9 clips.

## [1.0.11] - 2026-11-06

### Fixed

- A prompt that fits the room is no longer dropped when the previous summary alone fills it (the 1.0.10 known issue): a cut can now shrink a
  summary that sits alone, when the cut is due. A prompt that fits beside the summary is sent as it stands.
- A fresh tool result is clipped in more of the cases where the request would otherwise be refused. The clip's budget is now counted in the
  same units as the request and allows for what the smallest cut keeps, so a round that fits only when clipped no longer ends the run. This
  is most of the refusals the settings stress test found.
- A reply that reports more than the model's window no longer raises pi-tuck's estimate for later requests.
- When a provider refuses a request as over its window, pi-tuck now says so in a notice, where the turn could read as a hang.
- Every refusal says why.

### Added

- A settings stress test (`test/stress`, run with `STRESS=1`): real Pi with a scripted fake model, across 272 cells of window, reserve,
  keep-recent, output cap, setup size and usage reports. CI runs it on Pi 1.2.0 and the newest Pi. Rejection wordings and usage reports in
  it are scripted: no hosted provider API is tested.

### Known issues

- Same settings stress test, this build: 4 of 272 cells report a failure (90 on 1.0.10), none stuck and none losing work. The next prompt runs.
  - A fresh assistant message larger than the free room is refused: nothing can clip it yet. A short next prompt recovers. In an unattended
    `pi -p` run, a refusal ends the run.
  - With a setup near the band, cuts can come too often: with Pi's defaults, a 40k setup at a 65,536 window made 25 cuts in 60 tool rounds, each
    freeing little. It costs extra work, not a task. One sampled cell at a 167,739 window also trips this count. The fix is planned for the next
    patch.
  - A reply that reports more than the window reads to Pi as a silent overflow, so Pi asks for a recovery cut. When nothing can be cut, pi-tuck
    refuses the next prompt: in the stress cell for it, a 6,000-token prompt in a 28,672-token room. The prompt after that runs.
- If a provider keeps rejecting requests in a wording Pi does not class as a context overflow, or with a bare HTTP 413, pi-tuck does not recover
  on its own: the provider's error reaches you, the session stays intact, and every prompt can fail until the request shrinks. Try `/compact`.

### Release gates

- **Shipped without a live gate.** Its replay matches 1.0.10, so the paired live test has nothing to measure on recorded sessions; the fixes
  act only where a request would otherwise be refused. For that reason replay cannot show them working either, and they are shown by the stress
  test alone, on a scripted model.
- Passed: tests; replay of the exact code on 29 recordings against 1.0.10 (13,946 requests, 0 differ, 0 dead tasks, the same 9 clips, all read
  back); the stress test (no cell stuck, none losing work; no cell has a failure 1.0.10 does not. One cell makes 8 cuts where 1.0.10 made 6,
  because its prompts now run instead of being refused).
- An earlier 1.0.11 build ran Pi's defaults on chain t06 with no lost task
  ([`benchmark/RESULTS-DEFAULTS-1010.md`](benchmark/RESULTS-DEFAULTS-1010.md)). One of its tasks, task 21, ran to the 30-minute wall cap on a
  first request the local server never answered, and recorded no token. It is read as a server stall. It was counted as passing under the bar's
  definition; the registered counter alone would count one dead task.

## [1.0.10] - 2026-11-05

### Fixed

- A session no longer stays stuck when Pi's `compaction.keepRecentTokens` covers the whole conversation (the 1.0.8 and 1.0.9 known issue,
  at Pi's defaults on small windows). The cut a prompt needs is now pi-tuck's own: it is planned when the prompt arrives, as at a tool
  boundary, every request of that run carries it, and the run's first boundary saves it. Pi's cut finder, which keeps the last
  keepRecentTokens and then has nothing to cut, is no longer asked. A run that ends before a boundary drops the cut, and the next prompt
  decides afresh.

### Changed

- A prompt's cut no longer goes through Pi's `session_before_compact`, so another extension's veto there no longer stops it. It never
  stopped a cut between tool rounds either. Pi's own threshold and overflow cuts, and `/compact`, still ask other extensions as before.

### Known issue

- When the previous summary alone fills the room and a large prompt arrives, the prompt is dropped: a cut cannot yet shrink a summary on its
  own. 1.0.10 drops it with no message, where 1.0.9 refused it with one ("Already compacted"). The next prompt runs normally. Seen once, on a
  25,160-character prompt at a 32k window. A fix is planned for 1.0.11.

### Release gates

- Passed: tests; replay of the exact build on 29 recordings (no dead task, no refused request, every oversize result clipped and read
  back); the Pi-defaults rerun on chain t06, which lost 28 of 30 tasks on 1.0.8: 0 dead tasks and 0 stuck sessions
  ([`benchmark/RESULTS-DEFAULTS-1010.md`](benchmark/RESULTS-DEFAULTS-1010.md)). It ran on a slow local server: 27 of 30 tasks hit the 30-minute
  wall cap, and 2 of them sat on a first request the server never answered and recorded no token. Those 2 are read as server stalls, and a strict
  no-token count would not meet the bar.
  One task was refused mid-run: its round carried 9,020 tokens of reasoning, so the next request was about 17,801 against the 16,384-token room.
- **Failed as registered:** the paired 32k gate against 1.0.9 (chains t01 and t02, 60 tasks). No task was lost in either arm, but 1.0.10
  resolved 49 tasks against 50, so "resolved no lower" failed by one task (−1.7 points, one-sided 95% lower bound −8.3;
  [`benchmark/RESULTS-V110.md`](benchmark/RESULTS-V110.md)). The user approved shipping as an exception because of the small-window defect.

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
