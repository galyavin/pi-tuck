# pi-tuck

**Compaction for [Pi](https://pi.dev) with no model call, and a history the agent can search by keyword or by meaning, all on your machine.** A cut takes about a tenth of a second. It costs no tokens. The same session always gives the same summary. And nothing is lost: the agent can read back anything earlier, word for word, and on Apple silicon it can find it by meaning.

```sh
pi install npm:pi-tuck
```

## pi-tuck against Pi's built-in compaction

Pi's built-in compaction asks a model to write a summary. pi-tuck builds the summary from the session itself.

| | Pi's built-in | pi-tuck |
|---|---|---|
| Model call per cut | One, to a model you pay for or wait on | None |
| Time per cut | **269 s** (median) | **0.09 s** (median) |
| Context carried after a cut | 29,200 tokens | 27,800 tokens (about the same) |
| Same session, same summary | No | Yes |
| Can the agent get dropped detail back | No recall tool. The full history stays in the session file, but the agent has no tool made to search it | Yes. `tuck_recall` reads any original exactly |
| Search history by meaning | No | Yes, with `tuck_search`, on macOS with Apple silicon. It runs locally, and no text leaves your machine. Elsewhere it searches by keyword |
| Can the summary invent history | Yes, a model wrote it | No, it holds only recorded text |
| What the summary leaves out | Whatever the model dropped | Tool output only; the agent reads it back exactly |
| Billed input from cutting early (simulated) | | 10–18% less than cutting at the full room |
| Answer quality against LLM compactors | | **Being measured. Not claimed yet.** |

The time and context rows are live runs on a local model with a 131k window: 27 cuts per arm over 5 chains, interim, pi-tuck 1.0.1. Every number comes from a file in this repository. Conditions, sample sizes and links are in [Benchmarks](#benchmarks). The last row is the one that matters most, and it is not finished: see [What is proven, and what is not](#what-is-proven-and-what-is-not).

## Ask your history

A summary cannot hold everything. So pi-tuck lets the agent look things up instead of guess. Say you fixed a login bug two hours ago, and the summary no longer holds the details. You ask:

> "What was the reason we dropped the retry on the token refresh?"

The original message says "removing the backoff loop from the auth renewal". The words differ, so a keyword search finds nothing. The agent calls `tuck_search`, which also searches by meaning:

```json
{ "query": "why did we drop the retry on token refresh" }
```

It gets back the original passage, with a pointer such as `#212`. It reads the whole message, exactly as it was written:

```json
{ "index": 212 }
```

That is `tuck_recall`. The agent answers from the original text, not from a model's memory of it.

*This example is an illustration. It is not a recorded session.* The call shapes are real. **Semantic search has no measured quality numbers yet.** The benchmarks below measure cut time, cost and answer retention after cuts, not how well `tuck_search` finds a passage. It runs only on macOS with Apple silicon. Elsewhere, `tuck_search` uses keywords, and the example above would not find its match.

## Install

```sh
pi install npm:pi-tuck
```

Then start a new Pi session. That is all. pi-tuck takes over Pi's compaction, both automatic and `/compact`. You change no setting.

- Needs Pi 1.1 or later (tested on 1.1.0 and 1.4.0), on macOS or Linux.
- On macOS with Apple silicon, the first session also downloads a local search model in the background (about 390 MB, once). Until it is ready, search works by keyword. See [Semantic search](#semantic-search).
- Prefer GitHub? `pi install git:github.com/galyavin/pi-tuck@v1.0.3`.
- To pin a version, add it: `pi install npm:pi-tuck@1.0.3`.

## How it works

When context fills up, pi-tuck replaces the older turns with one summary. The summary keeps:

- **The dialogue.** What you asked and what the agent answered, in order, word for word. If it is too long for the room, it shrinks: the oldest assistant text is clipped first, then older prompts. Clipped text says how to read it in full.
- **The files.** Files the agent read, wrote or edited, newest first (up to 60), each with a pointer to read it back.
- **The action trail.** The agent's other tool calls, such as shell commands, newest first (up to 30). The output is left out. A pointer leads to it.
- **Your first prompt**, word for word (up to 12,000 characters).

Tool output stays in the session file, not in the summary. Each summary ends with a short instruction to the agent: re-read a file before you edit it, look things up, and treat anything not shown as unknown.

The summary is plain text, one line per record, such as `#12 user @2026-10-30T14:00:00Z: text`. The number is the index that `tuck_recall` takes. Summaries from earlier versions are still read.

The agent gets two tools to get anything back:

- **`tuck_recall`** finds earlier text by keyword. It reads any original message or tool result exactly, by the index shown in a summary. It can also write an original out to a file.
- **`tuck_search`** finds earlier history related to a question, even when the wording differs. It combines keyword hits with local semantic search and returns the original text with pointers for `tuck_recall`.

Both tools cost about 1,050 tokens of tool description per request.

| Command | Does |
|---|---|
| `/tuck-semantic on\|off\|status` | Turns semantic search on or off for this session, or shows its state. |
| `/tuck-incident on\|next\|off\|status` | Records this session's compaction decisions to a file you can attach to a bug report. |

`/compact` works as usual, but pi-tuck does not take custom summary instructions. Pi's own setting `"compaction": { "enabled": false }` turns compaction off.

## What is proven, and what is not

**Measured so far:** a cut takes a fraction of a second, where a model-written summary takes minutes on a local model. A cut calls no model, so it costs no tokens. pi-tuck carries about as many tokens after a cut as the built-in does, not fewer. Cutting early saves billed input in simulation, and answers held in replay.

**Not proven yet: that the summary is as good as a model-written one.** The claim is that pi-tuck compacts as well as the best LLM compactors, in far less time and at no cost. That claim has a pre-registered test. The test is running now. It was written down before any result came in, and a failed test will be reported as failed. When the result is final, it goes in [`benchmark/`](benchmark) and in this README. Until then, this README does not claim that pi-tuck is as good as, or better than, an LLM compactor.

The test has three parts:

1. **A live run** at a 128k window on a local model. Ten chains of 30 SWE-bench Verified tasks per arm, with Pi's built-in compaction in one arm and pi-tuck in the other. Official grading.
2. **A paired replay with probe questions.** The same cuts, made by pi-tuck and by LLM compactors, then questions about facts that fell before the cut. Pre-registered rule: the claim holds only if pi-tuck is no more than 3 points worse than the better LLM compactor, with a 95% bound.
3. **A 32k suite**, where tasks are bigger than the room, so cuts must summarise work in progress.

The plan: [`benchmark/PREREG.md`](benchmark/PREREG.md), [`benchmark/PREREG-32K.md`](benchmark/PREREG-32K.md), and every change after the freeze in [`benchmark/DEVIATIONS.md`](benchmark/DEVIATIONS.md).

Known limits today:

- pi-tuck's summary does not explain why things happened. It holds the words that were said, not a model's reading of them. The agent must look things up. Each look-up costs a tool call.
- At a 32k window with Pi's default 16,384 reply reserve, pi-tuck can refuse to compact where Pi's built-in compaction runs. The fix is planned for 1.0.4. Until then, lower the reserve; see [Small windows](#small-windows).
- Semantic search runs only on macOS with Apple silicon.

## Benchmarks

Each row says what was measured, under which conditions, and where the data is. "Interim" means the run is not finished.

| What | Result | Conditions | Source |
|---|---|---|---|
| Cut time, live | pi-tuck median 0.087 s (90th percentile 0.205 s); Pi's built-in median 268.8 s (90th percentile 421.6 s). Context carried after a cut, median: 27,751 against 29,241 tokens | **Interim.** pi-tuck 1.0.1, Pi 1.4.0, SWE-bench Verified chains of 30 tasks, 131,072-token window, reply reserve 32,768, local model `mac-studio/main` writing Pi's summaries. 27 cuts per arm, 5 chains. The built-in time depends on that model and on server load. pi-tuck's time is an upper bound read from the session file | [`benchmark/RESULTS-INTERIM.md`](benchmark/RESULTS-INTERIM.md) section 1 |
| Cut time, paired replay | pi-tuck median 0.062 s (range 0.005 to 0.48 s); local-model summarizer 193.4 s (77.3 to 413.3 s); frontier summarizer 96.1 s (39.1 to 267.8 s). Context carried after a cut, median: 28,006 (pi-tuck), 26,424 (local), 25,555 (frontier) tokens | **Interim.** The same recorded sessions cut at the same positions. pi-tuck: 10 recordings, 52 cuts. Summarizers: 6 recordings, 28 and 29 cuts. Frontier is `openai/gpt-6-astra`. pi-tuck's time leaves out the background search index | [`benchmark/RESULTS-INTERIM.md`](benchmark/RESULTS-INTERIM.md) section 2 |
| Billed input, cutting at 60% of the room instead of 100% | −17.9% at 128k, −14.0% at 32k with automatic prompt caching; −17.0% and −9.6% with explicit cache breakpoints | Simulated billing, prompt caching priced, on build `1bda64b` (the default shipped in 1.0.3); 5 recorded live sessions | [`rnd/replay32/GATE-lean.md`](rnd/replay32/GATE-lean.md), [`rnd/IDEAS.md`](rnd/IDEAS.md) item 5 |
| Answers after cutting at 60% instead of 100% | No loss beyond the pre-set limit on any of 4 sets (for example 128k: 3 losses and 7 wins over 99 shared questions; 32k: 5 and 3 over 77) | Paired replay, DeepSeek flash as agent and judge, 5 recorded live sessions. The limit is max(2, 5% of questions) | [`rnd/IDEAS.md`](rnd/IDEAS.md) item 5 |
| 1.0.2 changes (plain-text summary, shrinking dialogue view, time on user turns only) against 1.0.1 | No loss of answer accuracy; for example 128k: 2 wins and 1 loss over 128 questions; 32k: 2 wins and 4 losses over 127 (limit 6) | Paired replay, DeepSeek flash as agent and judge, 5 sessions | [`rnd/IDEAS.md`](rnd/IDEAS.md) "Bundle arm result", [`CHANGELOG.md`](CHANGELOG.md) |
| Summary size, plain-text format against the 1.0.1 JSON format | About 30% shorter where the agent writes little, about 14% shorter where it writes a lot | Same dialogue | [`CHANGELOG.md`](CHANGELOG.md) 1.0.2 |
| Small-window fix | A session that writes little prose cut 174 times in 300 tool rounds at 32k with a 16k reserve (1.0.1 code). With the fix: 47 cuts, none freeing under a tenth of the room | Real planner on synthetic sessions | [`rnd/IDEAS.md`](rnd/IDEAS.md) item 7 |
| Stall fix: a long session's cut | A cut at 3,888 entries took 72 s in 1.0.0 and takes 174 ms since 1.0.1. Cost now grows about in line with the session: four times the entries takes 3.3 to 3.9 times as long | One machine, the same synthetic session for both numbers (little prose, 128k window, reserve 16,384, turn 644) | [`CHANGELOG.md`](CHANGELOG.md) 1.0.1 |

Notes:

- The billing figures come from a simulation that replays real sessions through the real cut trigger and prices every request. They are not bills.
- An earlier version of the simulation, before the build existed, gave −28% at 60% on 4 live sessions at 128k. The build's own gate is the figure in the table.
- The answer replays use one cheap hosted model (DeepSeek flash) as agent and judge. They compare pi-tuck with other pi-tuck settings and versions. They do not compare pi-tuck with an LLM compactor.
- The live and replay time rows measure pi-tuck 1.0.1. The newer versions are listed in the [changelog](CHANGELOG.md). A cut still calls no model, but the eval has not yet re-timed 1.0.3.
- Everything here is from SWE-bench-style tasks on a small set of models. It may not carry to your work.

## Settings

pi-tuck needs none. Two are optional. Put them in `pi-tuck.json` in Pi's agent folder (`~/.pi/agent`, or the folder `PI_CODING_AGENT_DIR` names):

```json
{ "cutAt": 0.6, "semanticRecall": true }
```

- **`cutAt`** (above 0, at most 1; default 0.6) is the part of the input room a request may fill before pi-tuck cuts. At 0.6, each cut leaves room to grow, so fewer tokens are carried and billed per request. `{ "cutAt": 1 }` cuts at the full room. A lower value cuts earlier and smaller. The whole room still decides which request pi-tuck refuses.
- **`semanticRecall`** (`false` turns semantic search off). Nothing is then downloaded, and `tuck_search` uses keywords only.

A bad file is reported at session start, and pi-tuck uses the defaults.

### Small windows

pi-tuck keeps room for the model's reply: the larger of the model's output limit and Pi's `compaction.reserveTokens` (default 16,384). It refuses a request that cannot fit, rather than let the provider cut it off. With a window of 32k tokens or less, the default reserve can leave too little room, and pi-tuck then refuses where Pi's built-in compaction would run. This is a known defect, due for 1.0.4. Meanwhile, lower the reserve for that model in Pi's `settings.json`. The 32k evaluation runs with a reserve of 8,192:

```json
{ "compaction": { "modelOverrides": { "my-provider/my-model": { "reserveTokens": 8192 } } } }
```

## Semantic search

Semantic search is on by default on macOS with Apple silicon. It runs entirely on your Mac: an embedding model, [EmbeddingGemma-2](https://huggingface.co/google/embeddinggemma-2), served by [llama.cpp](https://github.com/ggml-org/llama.cpp) on the CPU. No text leaves your machine. Elsewhere, `tuck_search` uses keywords, and everything else works.

The first time a session starts, pi-tuck downloads what it needs, once, about 390 MB, in the background. Keyword search works meanwhile:

| File | From |
|---|---|
| EmbeddingGemma-2, 8-bit GGUF (310 MB) and its tokenizer (32 MB) | huggingface.co |
| llama.cpp release b11476 for macOS arm64 (12 MB) | github.com/ggml-org/llama.cpp |
| CPython 3.13 (25 MB) and 16 Python packages for the tokenizer (9 MB) | github.com/astral-sh/python-build-standalone, pypi.org |

Every file is pinned to a SHA-256 in [src/assets.ts](src/assets.ts) and checked before use. Everything goes to `~/.pi/agent/pi-tuck`; to remove it, delete that folder. Setup needs about 6.5 GB of free disk space while it runs, and uses 460 MB after. If it fails, for example offline, pi-tuck says so and tries again at the next session start. One-shot runs (`pi -p`) do not start the setup.

Indexing starts in the background the first time a session uses `tuck_search`, and catches up after each compaction. Semantic search is off when Pi runs in a folder that contains Pi's agent folder, such as your home folder, because its own files live there. Open Pi in a project folder.

## Use from code

The package also exports its parts for hosts that embed Pi through its SDK:

```ts
import { installCompaction, createSemanticRecall, ensureSemanticRuntime } from "pi-tuck";

const config = JSON.parse(readFileSync(await ensureSemanticRuntime("/abs/path/outside/projects"), "utf8"));
const semanticRecall = createSemanticRecall(config);
const handle = await installCompaction(pi, { semanticRecall });
await handle.setSemanticEnabled(true, ctx); // e.g. in a session_start handler
```

`installCompaction` options (reply reserve, host-injected messages, recall policy, `cutAt` and others) are documented in [src/compaction.ts](src/compaction.ts). `handle.close()` stops the semantic worker; call it before disposing a session.

## Development

```sh
npm install
npm run check   # types
npm test        # unit tests (Vitest) and the Python runtime tests
npm run build   # dist/ for the library export
```

Changes are listed in [CHANGELOG.md](CHANGELOG.md). Releases are published from GitHub Actions by npm trusted publishing, with provenance.

## Credits

pi-tuck grew out of [pi-vcc](https://github.com/sting8k/pi-vcc) by sting8k and includes code from [pi-blackhole](https://github.com/k0valik/pi-blackhole) by k0valik and from [Pi](https://github.com/earendil-works/pi) by Mario Zechner, all MIT; their notices are in [LICENSE](LICENSE). The downloaded model is Apache-2.0, llama.cpp is MIT, and CPython is under the PSF license.

## License

MIT
