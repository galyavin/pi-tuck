# Pins

Everything the numbers depend on. The pi-tuck row is filled in when the main run starts and does not change after.

| What | Pin |
|---|---|
| pi-tuck under test | 1.0.1, commit `d71234af5a6a8c5bbb3b211c14b95f9719082949` (branch `claude/release-1-0-1-c5296f`, local; exported with `git archive` into `runs/tuck-1.0.1`). Pilot only: the installed 1.0.0 package (live arm B) and this repository's `src/` at the eval branch tip (replay cuts). |
| Pi | `@earendil-works/pi-coding-agent` 1.4.0 and `pi-ai` 1.4.0 (the `devDependencies` of this repository; the installed CLI is the same version) |
| Node | v26.3.0 |
| Task suite | SWE-bench Verified, `princeton-nlp/SWE-bench_Verified` at revision `c104f840cc67f8b6eec6f759ebc8b2693d585d4a`; graded with `swebench` 4.1.0 (`make_test_spec`, `get_eval_report`) |
| Task images | Epoch AI native arm64 images `ghcr.io/epoch-research/swe-bench.eval.arm64.<instance_id>:latest` (420 of the 500 instances exist; the x86 images would run under emulation) |
| Task draw | `harness/select_tasks.py`, seed 20261030, 377 eligible instances (image exists, difficulty under 1 hour); chains in `data/sessions.json` |
| Live model | `mac-studio/main` (Qwen3.8 Flash Next IQ3_S, window 131,072, max output 32,768), thinking `xhigh`; compaction reserve 32,768, keepRecent 20,000 |
| Replay LLM compactors | `openai/gpt-6-astra` thinking `high` (ChatGPT plan sign-in); `mac-studio/main` thinking `xhigh` |
| Replay agents | `mac-studio/main` thinking `xhigh`; `openai/gpt-6-astra` thinking `medium` |
| Next-step judge | `openai/gpt-6.1-sol` thinking `low` |
| Embeddings (pi-tuck semantic search) | pinned by pi-tuck: EmbeddingGemma-2 8-bit GGUF through llama.cpp b11476 (see its `src/assets.ts`) |
| 32k suite (PREREG-32K.md) | Arm B: pi-tuck v1.0.3, commit `656f77ac899589978e94501ed33fb364970aad74` (exported with `git archive` into `runs/tuck-1.0.3`; only the version differs from 1.0.1 in `package.json`, so the same dependencies). Model `openrouter/~deepseek/deepseek-flash-latest`, thinking `high`, window forced to 32,768, reply cap and reserve 8,192, `keepRecentTokens` 5,000. Chains `t01`-`t03`, seed 20261031. |
