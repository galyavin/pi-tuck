# pi-tuck

pi-tuck is an extension for [Pi](https://pi.dev). It builds deterministic compaction summaries from the saved session without calling a model. After a cut, the agent can look up original text and tool results on the current branch.

## Install

Use Pi 1.2.0 or later and Node.js 22.19.0 or later on macOS, Linux, or Windows.

```sh
pi install npm:pi-tuck
```

Start a new Pi process after installing or updating. pi-tuck handles automatic compaction and `/compact` by default. Run `/tuck` to see the loaded version, cut history, and active cut policy.

To pin a published release, use `pi install npm:pi-tuck@1.3.4` or install its Git tag with `pi install git:github.com/galyavin/pi-tuck@v1.3.4`. To uninstall, run `pi remove npm:pi-tuck` or pass the Git source you installed from.

## Compaction and recall

A cut replaces older turns in the model's context with a summary while keeping the original entries in the session. The summary prioritizes the current prompt, recent turns, excerpts from earlier prompts, and pointers to files and tool actions. It can also carry recent reads and searches when the session records no action that could have changed their files. The recorded text is historical evidence about the session. Re-read a file before editing it.

`tuck_recall` becomes available when the active branch includes a pi-tuck cut. Use a keyword query to locate a passage.

```json
{ "query": "retry token refresh" }
```

Read the original by the hit's `entryId`, or use `{"index": 212}` to follow a `#212` reference in the summary. Page long sources with `offset` and `limit` in UTF-16 characters. Use `outputPath` with an `entryId` or `index` to export eligible text through Pi's `write` tool. Recall excludes hidden reasoning and system records.

| Command | Purpose |
|---|---|
| `/compact` | Request a cut. pi-tuck builds the summary from the session and ignores any appended instructions. |
| `/tuck` | Inspect the loaded version, saved cuts, and cut point. |
| `/tuck-incident on\|next\|off\|status` | Control diagnostic recording. The default directory is `~/.local/state/pi-tuck-incidents`. |

An unsupported Pi version, a Pi virtual model, or an invalid context window leaves compaction to Pi. To disable automatic compaction, set `"compaction": { "enabled": false }` in Pi's settings. `/tuck` reports why a loaded compactor is standing down. Capacity notices go to stderr when Pi has no UI.

## Settings

Optional settings go in `pi-tuck.json` in Pi's agent directory (`~/.pi/agent` by default, or `PI_CODING_AGENT_DIR`). Restart Pi to apply changes. The input room starts at the model's context window minus Pi's `compaction.reserveTokens`. Invalid JSON uses defaults. An invalid field uses its own default, with a notice when compaction is active.

- **`cutAt`** is a fraction above 0 and at most 1. The default cut point starts at 60% of the room and adapts after a cut. An explicit value fixes the fraction, subject to a 2% margin below the room even at `1`.
- **`cacheSensitiveModels`** lists exact `provider/model` identifiers. For these models, the cut point is the full room, taking precedence over `cutAt`. This delays early cuts that would discard a reusable prompt prefix.
- **`llamaContinuation`** opts one reasoning model into a single extra request after a thinking-only response exhausts the full configured output allowance. In Pi's `models.json`, configure that model on a llama.cpp provider using the `openai-completions` API. Verify that the runtime and template support `continue_final_message: "reasoning_content"` and report reused prompt tokens through `prompt_progress`. Pi-tuck requires the first cache report to match the prefix within 15 seconds. The positive integer `extraTokens` caps the additional allowance within the remaining context. The positive integer `deadlineMs` covers both requests.

```json
{
  "cacheSensitiveModels": ["my-provider/my-model"],
  "llamaContinuation": {
    "model": "my-provider/my-model",
    "extraTokens": 4096,
    "deadlineMs": 5400000
  }
}
```

## Output exhaustion and small windows

- A thinking-only stop at the model's full output allowance stays in the transcript. If it remains unfinished, pi-tuck reports output exhaustion. A thinking-only stop at a smaller request cap can trigger one capacity retry when a cut can free reply room.
- A length stop alone leaves its cause uncertain. Pi-tuck uses the context window declared in Pi’s model configuration. Set that window to the effective limit when a server has a smaller one.
- Pi’s reserve guides compaction. Above the target, pi-tuck uses observed output from the active model to estimate how much room a reply needs. A large fixed system prompt or tool set can leave little room for history. Pi-tuck can refuse a request if the protected prompt and reply budget cannot fit after reductions. Token estimates depend on reported usage, and overflow recovery depends on Pi recognizing the provider's error as a context overflow. Try a shorter prompt, `/compact`, or a larger window.

When using OpenRouter, you can pin an upstream in Pi's `models.json` if upstreams count context differently.

```json
{ "providers": { "openrouter": { "compat": { "openRouterRouting": { "only": ["your-upstream"], "allow_fallbacks": false } } } } }
```

For admission, retries, and calibration, see [Small windows](docs/small-windows.md).

## Use from code

Hosts that embed Pi through its SDK can import the compactor directly.

```ts
import { installCompaction } from "pi-tuck";

const handle = await installCompaction(pi);
```

Pass host-injected messages, a reply reserve, or a recall policy as `CompactionOptions`. Call `await handle.close()` before disposing the session to stop the incident recorder. [SDK options](src/compaction.ts)

## Development

From the repository root, install the locked dependencies and run the checks.

```sh
npm ci
npm run check
npm run build
npm test
```

The build emits the SDK export in `dist/` and refreshes the source identifier in `src/build-id.ts`. Run it before the test suite after changing `index.ts` or `src/`. To run one file, use `npm test -- test/llama-continuation.test.ts`. To try this checkout in Pi for one invocation, run `pi --no-extensions -e ./index.ts`.

- The extension entry point reads settings and registers the optional provider adapter. [Entry point](index.ts) · [Continuation adapter](src/llama-continuation.ts)
- Session hooks plan and commit cuts. Request-capacity code handles Pi's clamp, and reply budgeting. [Compaction hooks](src/compaction.ts) · [Request capacity](src/request-capacity.ts)
- The summary compiler renders the cut. Recall reads eligible source entries from the branch. [Summary compiler](src/tuck.ts) · [Recall](src/recall.ts)

See [Contributing](CONTRIBUTING.md) for stress tests and [the changelog](CHANGELOG.md) for release changes.

## Benchmarks

- **128k live run.** On 300 SWE-bench Verified tasks with pi-tuck 1.0.1 and Pi 1.4.0, median time per completed cut was 0.081 s for pi-tuck (an upper bound from session timestamps) and 235.3 s for Pi with a local model summarizing. Pi-tuck resolved 258 tasks and Pi resolved 251. The one-sided 95% lower bound was +0.3 percentage points with all chains and −0.4 without the chain where Pi's compaction failed 44 times. [128k results](benchmark/RESULTS-MAIN.md)
- **128k recall replay.** The scored mechanical probes at cuts 1–4 supported the preregistered claim that pi-tuck with recall scored at most 3 percentage points lower than the agents answering from Pi's summaries and kept messages. The summaries came from mac-studio/main:xhigh and GPT-6.1 Terra. The results cover completed answer sets. Pi-tuck aborted 52 of 95 sets. [Retention results](benchmark/RESULTS-MAIN.md)
- **32k live run.** On DeepSeek V4.1 Flash, the pi-tuck 1.0.5 arm resolved 120 of 150 tasks, compared with Pi's 94 and observation masking's 117. The one-sided 95% lower bound was +10.7 points against Pi and −2.7 against observation masking. Pi-tuck recorded one dead task against a target of zero. Pi's arm sent requests over the 16,384-token input room in 97 tasks. [32k results](benchmark/RESULTS-32K-ACCEPT.md)

The [benchmark index](benchmark/README.md) records the models, versions, plans, and scope of each result.

## Credits and license

MIT. pi-tuck grew out of [pi-vcc](https://github.com/sting8k/pi-vcc) and includes code from [pi-blackhole](https://github.com/k0valik/pi-blackhole) and [Pi](https://github.com/earendil-works/pi). See [NOTICE](NOTICE).
