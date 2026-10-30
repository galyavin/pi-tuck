# pi-tuck

Deterministic compaction for [Pi](https://pi.dev). When a session's context fills up, pi-tuck replaces older turns with a summary built
from the session itself, not written by a model: no extra model call, no cost, no invented history, and the same input always gives the
same summary. Nothing is lost: the full history stays in the session file, and the agent gets two tools to read it back, by keyword and
by meaning.

## Install

```sh
pi install npm:pi-tuck
```

or straight from GitHub:

```sh
pi install git:github.com/galyavin/pi-tuck@v1.0.0
```

Requires Pi 1.1 or later (tested on 1.1.0 and 1.4.0) and macOS. Semantic search needs Apple silicon; on an Intel Mac everything else works.
Start a new Pi session after installing.

## What it does

**Compaction.** pi-tuck takes over Pi's compaction, both automatic and `/compact`. A summary keeps:

- the dialogue: what you asked and what the agent answered, in order;
- the files the agent read, wrote or edited, newest first (up to 60), with pointers to read them back;
- the agent's other tool calls, such as shell commands, newest first (up to 30), without their output but with pointers to it;
- your first prompt in the session, word for word (up to 12,000 characters).

Tool output is left out of the summary; it stays in the session file. If the dialogue itself is too long for the room left, the summary
keeps a ranked selection of records instead. Each summary ends with a short instruction to the agent: re-read a file before editing it,
and look things up rather than guess.

**`tuck_recall`** finds earlier text by keyword and reads any original message or tool result exactly, by the index shown in a summary.
It can also write an original back out to a file.

**`tuck_search`** finds earlier history related to a question even when the wording differs. It combines keyword hits with local
semantic search (see below) and returns the original text with pointers for `tuck_recall`.

**Commands**

| Command | Does |
|---|---|
| `/tuck-semantic on\|off\|status` | Turns semantic search on or off for this session, or shows its state. |
| `/tuck-incident on\|next\|off\|status` | Records this session's compaction decisions to a file you can attach to a bug report. |

`/compact` works as usual; pi-tuck does not take custom summary instructions. Pi's own setting `"compaction": { "enabled": false }`
turns compaction off.

**Small context windows.** pi-tuck keeps room for the model's reply: the larger of the model's output limit and Pi's
`compaction.reserveTokens` (default 16,384). It refuses a request that cannot fit rather than let the provider cut it off. For a model
with a window of 32k tokens or less, lower the reserve for that model in Pi's `settings.json`:

```json
{ "compaction": { "modelOverrides": { "my-provider/my-model": { "reserveTokens": 4096 } } } }
```

## Semantic search

Semantic search is on by default and runs entirely on your Mac: an embedding model,
[EmbeddingGemma-2](https://huggingface.co/google/embeddinggemma-2), served by [llama.cpp](https://github.com/ggml-org/llama.cpp) on the
CPU. No text leaves your machine.

The first time a session starts, pi-tuck downloads what it needs, once, about 390 MB in the background, and keeps working with keyword
search meanwhile:

| File | From |
|---|---|
| EmbeddingGemma-2, 8-bit GGUF (310 MB) and its tokenizer (32 MB) | huggingface.co |
| llama.cpp release b11476 for macOS arm64 (12 MB) | github.com/ggml-org/llama.cpp |
| CPython 3.13 (25 MB) and 16 Python packages for the tokenizer (9 MB) | github.com/astral-sh/python-build-standalone, pypi.org |

Every file is pinned to a SHA-256 in [src/assets.ts](src/assets.ts) and checked before use. Everything goes to `~/.pi/agent/pi-tuck`;
to remove it, delete that folder. Setup needs about 6.5 GB of free disk space while it runs and uses 460 MB after. If it fails, for
example offline, pi-tuck says so and tries again at the next session start. One-shot runs (`pi -p`) don't start the setup.

Indexing starts in the background the first time a session uses `tuck_search`, and catches up after each compaction. Semantic search is off when Pi
runs in a folder that contains Pi's agent folder, such as your home folder, because its own files live there; open Pi in a project folder.

**Turn it off** by creating `~/.pi/agent/pi-tuck.json`:

```json
{ "semanticRecall": false }
```

Nothing is then downloaded, and `tuck_search` uses keywords only. If you set `PI_CODING_AGENT_DIR`, the file and the download folder are
in that folder instead.

## Use from code

The package also exports its parts for hosts that embed Pi through its SDK:

```ts
import { installCompaction, createSemanticRecall, ensureSemanticRuntime } from "pi-tuck";

const config = JSON.parse(readFileSync(await ensureSemanticRuntime("/abs/path/outside/projects"), "utf8"));
const semanticRecall = createSemanticRecall(config);
const handle = await installCompaction(pi, { semanticRecall });
await handle.setSemanticEnabled(true, ctx); // e.g. in a session_start handler
```

`installCompaction` options (reply reserve, host-injected messages, recall policy and others) are documented in
[src/compaction.ts](src/compaction.ts). `handle.close()` stops the semantic worker; call it before disposing a session.

## Development

```sh
npm install
npm run check   # types
npm test        # unit tests (Vitest) and the Python runtime tests
npm run build   # dist/ for the library export
```

## Credits

pi-tuck grew out of [pi-vcc](https://github.com/sting8k/pi-vcc) by sting8k and includes code from
[pi-blackhole](https://github.com/k0valik/pi-blackhole) by k0valik and from [Pi](https://github.com/earendil-works/pi) by Mario
Zechner, all MIT; their notices are in [LICENSE](LICENSE). The downloaded model is Apache-2.0, llama.cpp is MIT, and CPython is under the
PSF license.

## License

MIT
