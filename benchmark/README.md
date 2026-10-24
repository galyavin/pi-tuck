# Standalone synthetic lexical benchmark

Run from the repository root after its declared development dependencies are available:

```sh
nice -n 19 node benchmark/gate-suite.mjs \
  "$(dirname "$(pwd -P)")/tuck-benchmark-results-001" \
  "$(dirname "$(pwd -P)")/tuck-benchmark-work-001"
```

Requires Node >=22.19 and the declared **TypeScript 5.9.3** development dependency. Nothing else is loaded: no Vitest, extension host, model, network, private asset or accepted snapshot. The command does not install dependencies. Use fresh, absolute, normalized destinations with existing parents, outside the source tree; change both suffixes to rerun. Symlinked source/output ancestors are refused. Unix `nice`/priority 19 is required, as in the accepted harness. Local source is trusted code, not sandboxed.

The default establishes a **new self-reference from this source tree**, runs the candidate and harmless/actual-loss source controls, and executes the real comparator. It is a mechanics check, **not comparison against an earlier release**. Overall exit 0 includes the deliberate loss comparator exiting 1 with `Regression c01`. Unexpected failures stop the suite and are preserved; reruns never overwrite results. A run is successful only if `suite.json` has status 0.

## Fixture and unchanged scoring

`corpus.json` contains 15 fictional documents, ten cases and twenty source-backed literal facts. Corpus bytes, `scoring-block.txt` and `compare-block.txt` preserve the accepted fixture and decision blocks exactly. There is no imported session/evaluation material.

Five actual lexical TypeScript modules from `src/pi-tuck/core/` are transpiled to ESM. Only declared relative runtime imports within those five modules are allowed. The runner calls `searchEntriesDetailed` and scores **only delivered snippets** from the expected source, not full documents or query text. Fixed budgets: semantics false, cap 3, relative floor 0.2, 1200 UTF-16 delivered characters, 3000 ms search checkpoint budget, two snippet-context lines. The deadline is a checkpoint, not a hard interrupt. No scoring, test behavior or budget is tuned by this adaptation.

The comparator requires matching corpus/scorer/budgets, cases, queries and expected facts; neither any case nor aggregate may decrease. Different source identities are retained, not equality gates. Invoke it separately with:

```sh
node benchmark/gate-compare.mjs BASELINE_RESULT.json CANDIDATE_RESULT.json
```

## Validation and evidence

Before transpilation/output, each run checks a full source manifest and explicit add/delete/modify/move declaration with before/after sizes and SHA-256. Unsafe paths, symlinks, nonregular files, stale or duplicate declarations/mappings and undeclared changes fail closed. Root `.git`, `node_modules` and `dist` directories are excluded from source manifests (metadata, dependencies, generated build output); all other files, including the benchmark, are included. This is source-scope validation, not ancestry attestation. `pins.json` validates public harness/fixture bytes; it contains no private provenance. The suite captures the actual source manifests at startup and checks preservation at completion. Hostile concurrent filesystem mutation is outside its guarantees.

The suite retains 25 source/declaration rejection controls, an existing-output rejection, reference/candidate/harmless/loss retrievals and comparator commands. The harmless control moves five lexical files (one with an added comment), adds a note and removes documentation; retrieval must be exactly equal. The actual-loss control changes `capHits` to exclude source entry index 0; it must reduce c01 and be rejected by the comparator. Retrieval JSON is never edited to manufacture loss.

Results retain exact CLI argv/cwd/status/timestamps, stdout/stderr, full manifests/declarations, raw retrieval and delivered snippets, scoring inputs and compiler/Node hashes. Emitted modules remain in the work directory; their identities and source hashes are in each result's `generated-manifest.json`. Keep both result and work directories. Actual machine paths in generated local receipts are not portable source dependencies.

For evidence-only comparison against another explicitly supplied source tree with the same five renamed lexical module paths:

```sh
nice -n 19 node benchmark/gate-suite.mjs \
  /absolute/fresh/results /absolute/fresh/work /absolute/reference-source
```

This establishes a **fresh same-harness reference**, not a relabeling of historical scores. The reference is fully manifested and left unchanged; the candidate delta is derived and validated explicitly. There is no built-in external path. `BENCHMARK_TYPESCRIPT=/absolute/typescript-package` optionally selects an existing read-only compiler installation instead of normal development-dependency resolution; the exact version and hashes are checked/recorded. Ordinary public use needs no override.

This easy, fixed fixture proves bounded lexical mechanics only. It is not binding-budget stress, semantic recall, cross-platform execution, latency, integration, paired-release quality or release readiness.
