# Generic shared EG2 runtime contract

The package owns text passage formatting, source eligibility, foreground workers and separate derived indexes. A host owns acquisition/authenticity, asset selection, immutable resource custody and activation. The adapter does not acquire publisher assets or define host activation policy. Deterministic compaction and lexical recall need no Python/model.

## Adapter

```ts
const semanticRecall = createSemanticRecall({
  runtimeRoot: '/absolute/immutable/eg2',
  pythonPath: '/absolute/permanent/utility-env/bin/python',
  indexDirectory: '/absolute/mutable/history-indexes',
  scratchDirectory: '/absolute/mutable/scratch', // optional
  // Windows requires nativeOwnerHelperPath: '/absolute/verified/native-owner.exe'.
});
const handle = await installCompaction(pi, { semanticRecall, assertAccess, recallPolicy });
// Explicitly enable through handle.setSemanticEnabled(true, nativeContext).
// Stop: await session.abort(); await handle.close(); then session.dispose().
```

Explicit host injection bypasses external/ambient semantic config; the standalone default still reads its selected external config. Configure while disabled; await disable/close before replacing bindings, then explicitly enable. Do not relocate venvs or mutate resources while any consumer uses them. Changed runtime configuration/bytes/precision/Python or consumer formatting changes vector identity, not original history. Each controller owns its own SQLite filenames, even when sharing an index parent. Close/invalidate removes its vectors and scratch and joins preparation/searches and owned worker/native processes. Failed cleanup retains custody for retry.

POSIX uses a private Unix socket and owned process group. Windows requires an explicit verified `nativeOwnerHelperPath` supporting streaming `--run` and observed Job settlement; the worker uses authenticated loopback with a transient token. Close/invalidate joins that Job before release. No ambient helper lookup or unauthenticated endpoint fallback exists. These contracts do not qualify a native Windows encoder or complete user journey.

Runtime/index/scratch/config must be outside the caller project, including physical aliases. Index and scratch cannot be inside `runtimeRoot`. Explicit scratch must be a nonempty absolute directory. Default scratch consists of private `.pi-semantic-*` directories beside `indexDirectory`, not inside runtime and not under ambient `TMPDIR`; the worker removes its directory, never the caller's parent. Python uses `-I -B -u`, preventing bytecode writes; child temp/socket storage points to the owned scratch directory. If the host places its venv outside runtime, it must likewise keep that software separate from mutable storage.

## Immutable layout

```text
eg2/
  pins.json
  requirements.lock
  assets.sha256.json
  model.gguf
  models/embedding/tokenizer.json
  native/llama-server                  # Windows: native/llama-server.exe
  wheels/tokenizers-0.23.2-cp310-abi3-macosx_11_0_arm64.whl
  wheels/...                          # complete pinned utility dependencies
  notices/...                         # publisher notices, when supplied
  mmproj.gguf                         # optional other-consumer asset, if selected
utility-env/                          # permanent external venv, or eg2/env/
```

The runtime manifest maps canonical POSIX relative filenames to lowercase 64-hex SHA256. Required entries: `model.gguf`, `models/embedding/tokenizer.json`, `pins.json`, `requirements.lock`, and exactly one of `native/llama-server` or `native/llama-server.exe`; execution requires the host's matching name. Every listed byte is verified before readiness/tokenization; traversal, noncanonical spelling, links, missing files or bad digests refuse. Duplicate JSON keys refuse. Manifest bytes participate in identity; the host's verified publisher lock/manifest authenticates them. Runtime verification alone does not prove publisher authenticity.

For an external venv, retain every pinned utility wheel in the runtime manifest. Readiness checks exact utility versions, installed payload membership and bytes against those verified wheels. A managed root-contained venv instead binds the complete installed library tree, including dependency metadata and native libraries. Added, missing or modified utility code and bytecode refuse; version-only checks never suffice. Host software verification owns the interpreter, installation bookkeeping and authentication of the wheel contents and selected Python/pip.

`requirements.lock` contains the complete exact, hash-locked utility dependency set. Each line has this form:

```text
tokenizers==0.23.2 --hash=sha256:986670e43691469dcee610ea0f846f91a8f84e91fc6f7a48d4c064414c0ec2bf
```

The selected set is tokenizers plus Hugging Face Hub and its declared dependencies: 16 wheels on macOS/Linux, 17 on Windows including colorama. Package-owned `eg2-runtime.py` defines the accepted names/versions; the authenticated manifest supplies target wheel hashes. No online dependency resolution, Torch, Transformers or auxiliary inference backend. The lock describes a Darwin arm64 companion requiring native Python 3.13, matching its CPython-specific wheels; that companion is not bundled. The generic runtime accepts Python 3.12 or 3.13 only with a complete matching publisher-selected wheel set; the tokenizer's ABI3 tag alone does not make the whole set portable. Interpreter version participates in worker identity.

## Pins

Expected `pins.json` structure; example for a separately supplied Q8 runtime:

```json
{
  "embedding": {
    "model": "google/embeddinggemma-2",
    "revision": "914f7f89142e33e77833254d9c9b90c3cef7303b",
    "dimensions": 768,
    "maxTokens": 8192,
    "queryInstruction": "task: search result | query: ",
    "documentInstruction": "title: none | text: ",
    "pooling": "mask-aware mean including prompt, projected token states, then float32 L2",
    "dtype": "Q8_0",
    "textOnly": true
  },
  "runtime": { "tokenizers": "0.23.2" },
  "backend": {
    "name": "llama.cpp",
    "commit": "448147d42a71d0147c6dc844f99f9ffe7419183a",
    "artifact": "Q8_0",
    "gpuLayers": 0,
    "compute": "CPU float32 with f32 KV; quantized weights where selected",
    "computePrecision": "float32",
    "modelRepository": "unsloth/embeddinggemma-2-GGUF",
    "modelRevision": "031f0d4b35536f69ab3509d4893c923264fcf253",
    "modelSHA256": "6f1bd4ac6c5df7444f9cca7ca36cafe6cfa34cd6f49fefb1e0b4be8143aed8bc"
  }
}
```

`artifact` and `embedding.dtype` must agree: `Q4_0`, `Q4_K_S`, `Q4_K_M`, `Q8_0`, or `BF16`. GGUF v3 `general.architecture` must be `gemma-embedding2` and `general.file_type` must match (respectively 2/14/15/7/32). Model SHA256 must equal the manifest's model digest, not a hardcoded Q8 hash. Repository/conversion revision is captured exactly; the official encoder revision and supported native commit remain fixed. No F16 weight/inference configuration is accepted. `computePrecision` may be omitted when the exact existing `compute` string is present; if supplied it must be `float32`. Native launch always uses CPU, zero GPU layers, f32 K/V, flash attention off, mean pooling and L2 normalization.

Additional pins/manifest entries (including selected vision resources) remain part of exact configuration identity and are verified, but this consumer does not invoke vision. Raw pins, requirements, manifest, worker/helper source bytes and Python version form worker identity; the controller additionally binds its current text chunk/format implementation. Readiness returns identity, dtype, `computePrecision: "float32"`, Python version, dimensions768, maxTokens8192 and offline status. It verifies configuration/bytes/utility origin; actual text preparation/query still determines usable coverage. It does not promise retrieval quality or selected visual capability.

## Offline provision API

```sh
/absolute/python3.13 -I -B scripts/provision-eg2.py /absolute/new/eg2 \
  --assets /absolute/extracted/companion \
  --lock /absolute/publisher-verified/eg2-assets.lock.json \
  --python /absolute/python3.13 \
  --environment-directory /absolute/new/permanent-env \
  --index-directory /absolute/mutable/history-indexes \
  --scratch-directory /absolute/mutable/scratch
```

Optional `--lock` defaults to bundled Q8 `eg2-assets.lock.json`. Its schema is `{ "format": 1, "platform": "darwin-arm64", "python": "3.13", "wheel": "wheels/tokenizers-0.23.2-cp310-abi3-macosx_11_0_arm64.whl", "files": { ...complete companion path-to-SHA256 map... } }`. Provisioning requires the interpreter minor declared by the selected lock. `files` binds pins, requirements, model/native/tokenizer, all utility wheels and every notice/member exactly; extra companion files/links refuse. The host must authenticate this lock before supplying it. The utility neither downloads nor signs/blesses changed inputs.

Default environment destination is `runtimeRoot/env`; optional external environment is created at its permanent final path. Existing destinations/environments are refused. Assets are copied and reverified; complete wheel installation is offline/hash-locked/no-deps/no-compile. Dependency `pip check`, removal of seed bytecode, exact utility verification and actual tokenizer loading precede `runtimeRoot/semantic-recall.json`. This nonsecret config contains the generic adapter fields. Failure rolls back only newly owned software destinations, preserving source assets/existing user directories. Callers own placement outside their projects. No archives are packed by provisioning.

## Preview limits

This document specifies the external runtime contract, not a reproduced semantic
quality or provisioning claim. The publisher assets, native encoder, utility
wheel closure and environment are not included. A public acquisition and
end-to-end semantic setup journey remains unavailable. No semantic/model runs or
cross-platform qualification are implied by source-level synthetic tests.
Lexical recall and deterministic compaction need none of these external assets.
