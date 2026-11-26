# pi-tuck

pi-tuck is an extension for [Pi](https://pi.dev). It writes Pi's compaction summary from the session itself, with no model call. In our 128k live run, a cut took a median 0.08 s (pi-tuck 1.0.1). A cut costs no tokens. The same session always gives the same summary. The agent can read back any earlier message or tool result, word for word.

```sh
pi install npm:pi-tuck
```

Words used on this page:

- **Window**: the tokens the model accepts in one request.
- **Reply reserve**: the tokens Pi keeps free for the reply (`compaction.reserveTokens`, default 16,384).
- **Room**: the window less the reply reserve.
- **Cut**: the replacement of older turns with one summary.
- **Recall**: the agent's way to read back what a cut removed (`tuck_recall`).

## How pi-tuck compares with Pi's built-in compaction

Pi's built-in compaction asks a model to write the summary. pi-tuck builds it from the session. The 128k rows compare pi-tuck 1.0.1 with Pi 1.4.0's built-in compaction, with a local model writing the built-in summary. The 32k row is a different run, described below.

| | Pi's built-in | pi-tuck |
|---|---|---|
| Model call per cut | One | None |
| Time per cut (median) | 235 s | 0.08 s |
| Context carried after a cut | 27,750 tokens | 26,790 tokens |
| Same session, same summary | Not guaranteed | Yes |
| Can the summary invent history | It can, since a model writes it | No, it holds only recorded text |
| What the summary leaves out | Whatever the model dropped | Tool output only |
| Can the agent read back cut detail | No recall tool | Yes, with `tuck_recall` |
| Facts asked back after a cut, 128k window | From the summary alone | Not more than 3 points below Pi's summary (cuts 1 to 4 only; claim below) |
| Tasks resolved, 128k window, 300 per arm | 251 | 258 (claim: no loss larger than 0.4 points) |
| Tasks resolved, 32k window, 150 per arm | 94 | 120 (+17.3 points, 95% lower bound +10.7) |

What these numbers cover:

- **Time, context and 128k tasks.** One live run of pi-tuck 1.0.1: 10 chains of 30 SWE-bench Verified tasks, window 128,000. A local model wrote the built-in summaries. The medians come from 46 pi-tuck cuts and 48 built-in cuts. The pi-tuck time is an upper bound, read from the session file.
- **Retention.** The claim, as [`benchmark/RESULTS-MAIN.md`](benchmark/RESULTS-MAIN.md) words it: **pi-tuck, answering with its recall tools, retains probed facts at a rate not more than 3 points below that of "Pi's compaction prompts on mac-studio/main:xhigh" (20 recordings) or of "Pi's compaction prompts on GPT-6.1 Terra" (19 of 20 recordings, s09-A missing), each answering from its summary alone, on these probes.** The test compares pi-tuck with its recall tool against Pi's summary alone. It does not compare summary with summary. Every probe was a mechanical fact: files changed, test result, required tag, error class or the session's result-line rule. The numbers cover cuts 1 to 4 only, because 52 of pi-tuck's 95 answer sets in the replay ended in an abort. This README makes no retention claim past cut 4.
- **128k tasks.** The claim is only "no loss larger than 0.4 points". Chain s09 decides it: Pi's compaction failed 44 times there. Without s09 the lower bound is −0.4 points. With it, the bound is +0.3.
- **32k tasks.** One model (DeepSeek V4.1 Flash), one window, pi-tuck 1.0.5. Only pi-tuck was held to the 16,384-token room: Pi's built-in compaction sent a request over it in 97 of 150 tasks. Observation masking, a third approach, resolved 117 (pi-tuck +2.0 points, lower bound −2.7: no difference shown). The pi-tuck arm had 1 dead task, so it missed its pre-registered bar of zero by one task.
- **All results.** They come from SWE-bench-style tasks and may not carry to your work.

This README does not say that pi-tuck is as good as or better than any compactor, model, window or kind of task other than those named. It never calls pi-tuck "the best LLM compactor". The plans were written before any result. Every plan and result, including those that did not favour pi-tuck, is in [`benchmark/`](benchmark) (index: [`benchmark/README.md`](benchmark/README.md)).

## Install

Run the command at the top, then start a new Pi session. pi-tuck takes over automatic compaction and `/compact`. You change no setting. pi-tuck downloads nothing.

- Use Pi 1.2.0 or later (tested on 1.2.0 and 1.4.0), on macOS, Linux or Windows. Windows works since 1.2.0 (tested on Windows 10 with Node 24 and Pi 1.5.2).
- On an older Pi, pi-tuck stays off, Pi's own compaction runs, and pi-tuck says so once.
- To install from GitHub, run `pi install git:github.com/galyavin/pi-tuck@v1.3.4`.
- To pin a version, run `pi install npm:pi-tuck@1.3.4`.
- Restart an open Pi session after an update. It keeps the build it started with.

## Ask your history

A summary cannot hold everything, so pi-tuck lets the agent look things up. Say you fixed a login bug two hours ago, and the summary no longer holds the details. You ask:

> "What was the reason we dropped the retry on the token refresh?"

The agent searches its history by keyword with `tuck_recall`:

```json
{ "query": "retry token refresh" }
```

It gets ranked passages with a pointer such as `#212`. It reads the whole message, exactly as written:

```json
{ "index": 212 }
```

The agent answers from the original text. This example is an illustration, not a recorded session. Keyword recall finds only the words that the original message contains.

## How it works

When the context passes the cut point, pi-tuck replaces the older turns with one summary. The summary keeps:

- your current prompt, whole;
- the start of your first prompt and of your recent prompts;
- the newest turns, as they were;
- the files the agent read, wrote or edited (up to 60), each with a pointer;
- **kept reads**: up to 4 whole reads of files that did not change since;
- **kept searches**: the latest `grep` or `rg` output of each command (up to 4), under the same rules;
- an action trail: the agent's other tool calls (up to 30), without their output, each with a pointer.

A later write or edit, a shell command that is not read-only and names the file, or a git `checkout`, `stash`, `restore` or `reset` drops a kept read or search. A search that pi-tuck cannot classify is never kept. The header of a kept read says only that no write or edit was recorded since. It does not prove that the file on disk is unchanged.

Whatever does not fit is counted. `tuck_recall` reads it back by index range. Tool output stays in the session file. Each summary ends with a short instruction to the agent: re-read a file before you edit it, look things up, and treat anything not shown as unknown.

The summary is plain text, one line per record, such as `#12 user @2026-10-30T14:00:00Z: text`. The number is the index that `tuck_recall` takes.

`tuck_recall` finds earlier text by keyword. It reads any original message or tool result by index. It can write an original out to a file. The tool appears only after the first cut. Before that, a request is the same as one without pi-tuck. Pass a search result's `next` value as `continuation` to get the next page. Page a long source with `offset` and `limit`, counted in UTF-16 characters. `outputPath` with an `entryId` or `index` writes the original out through Pi's `write` tool.

| Command | Does |
|---|---|
| `/tuck` | Shows the loaded version, the cuts so far, the cut point and, if pi-tuck is not acting, why. |
| `/tuck-incident on\|next\|off\|status` | Records this session's compaction decisions to a file that you can attach to a bug report. |

pi-tuck stands down to native Pi when it cannot work safely: the window is unknown, the model is a Pi virtual model, or Pi's auto-compaction is off. Pi then does what it does without pi-tuck, and `/tuck` says `standing down:` with the reason. With no UI (`pi -p`, JSON runs), refusal, overflow and manual-cut notices go to stderr.

`/compact` works as usual. Text after it does not steer the summary. pi-tuck cuts as plain `/compact` does and says it did not use the text. Pi's setting `"compaction": { "enabled": false }` turns compaction off.

## Settings

pi-tuck needs no setting. One is optional. Put it in `pi-tuck.json` in Pi's agent folder (`~/.pi/agent`, or the folder that `PI_CODING_AGENT_DIR` names):

```json
{ "cutAt": 0.8 }
```

- If you do not set `cutAt`, the cut point adapts to the session. It stays between 60% of the room and just under the room.
- A number above 0 and at most 1 fixes the cut point as a share of the room. `1` cuts at the full room.
- If the file is bad, pi-tuck says so at session start and uses the defaults.

## Small windows

- pi-tuck keeps the same reply room as native Pi (`reserveTokens`).
- After a reply that stops for length with thinking only, pi-tuck retries the turn once.
- When a run ends on a reply cut at the output limit, pi-tuck says so.
- When a server clips replies below the window, pi-tuck learns the smaller window. It drops that window when the model's window changes.
- pi-tuck refuses a request only past the window. The refusal names what does not fit.

If a small window refuses, use a larger window. With OpenRouter, you can also pin one upstream. Add this to `models.json` in Pi's agent folder, and name the upstream:

```json
{ "providers": { "openrouter": { "compat": { "openRouterRouting": { "only": ["your-upstream"], "allow_fallbacks": false } } } } }
```

The details are in [`docs/small-windows.md`](docs/small-windows.md).

## Known limits

- The summary holds the words that were said, not why. The agent must look things up, and each look-up costs a tool call.
- A very large fixed setup in a small window keeps cuts frequent, and each frees little. Example: 40k of system prompt and tools at a 65,536 window.
- Between the room and the window, the reply reserve does not cushion a wrong token count. At a cold start, an undercount can reach the provider. A provider that errors is learned from. A server that truncates silently truncates, as it does for native Pi.
- pi-tuck learns from a provider refusal only when Pi classes it as a context overflow. After a refusal in another wording, or a bare HTTP 413, pi-tuck does not recover. The session stays intact. Every prompt can fail until the request shrinks. Try `/compact`.
- A custom message with no text has nothing to quote. If a run starts from one, the message stays unprotected after a cut in the middle of the run.

Fixed problems are in [`CHANGELOG.md`](CHANGELOG.md).

## Uninstall

```sh
pi remove npm:pi-tuck
```

Use the same source that you installed from. If you turned `/tuck-incident` on, its records are in `~/.local/state/pi-tuck-incidents`. Versions before 1.2.0 downloaded about 460 MB for a feature that no longer exists. pi-tuck deletes those files once per machine when it first starts, and shows a notice. On Windows, delete `~/.pi/agent/pi-tuck` yourself.

## Use from code

Hosts that embed Pi through its SDK can use the package:

```ts
import { installCompaction } from "pi-tuck";

const handle = await installCompaction(pi);
```

[`src/compaction.ts`](src/compaction.ts) documents the options of `installCompaction`. Use `hostMessages` for context the host injects, `requestReserve` for a host reply budget, and `recallPolicy` to restrict recall. Set `responseExact: true` in the reserve result to use the declared value; without it, a host reserve is at least the model's configured output limit. Call `await handle.close()` before you dispose a session. It stops the incident recorder.

## Development

```sh
npm ci
npm run build   # dist/ for the library export
npm run check   # types
npm test        # unit tests (Vitest)
```

The build rewrites the tracked `src/build-id.ts`. Include the refreshed file when you commit changes to `index.ts` or `src/`. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the stress tests. [`CHANGELOG.md`](CHANGELOG.md) lists the changes. GitHub Actions publishes releases with npm trusted publishing and provenance.

## Credits

pi-tuck grew out of [pi-vcc](https://github.com/sting8k/pi-vcc) by sting8k. It includes code from [pi-blackhole](https://github.com/k0valik/pi-blackhole) by k0valik and from [Pi](https://github.com/earendil-works/pi) by Mario Zechner, all MIT. Their notices are in [NOTICE](NOTICE).

## License

MIT
