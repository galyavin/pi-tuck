# pi-tuck

Source preview of a Pi extension for deterministic compaction and history recall
through `pi_tuck_recall` and `pi_tuck_search`. Word recall requires no Python,
weights or semantic setup. Old sessions' `vcc_recall` and `vcc_search` calls remain
recognized in history; those names are not registered as tool aliases.

Version 0.2.1 remains private and unpublished on npm. This source derives from a
files-only extraction, followed by credit and naming changes; no source Git
history is included. The exact original pi-vcc revision is not established.
Derived source headers and complete notices are retained in [LICENSE](LICENSE).
Historical private scores are not adopted as public quality evidence.

## Local source-loading evidence and developer prerequisites

A disposable local source-only copy was loaded through its package manifest by
Pi 1.1.0's unbundled SDK resource loader, without `dist`, prebuilding or locally
supplied host peers. Real session-bound `pi_tuck_recall` and `pi_tuck_search`
retrieved fictional original history with semantics disabled; a fresh SDK process
reopened that session and reproduced recall. This is bounded local source-loading
and persistence evidence, not an interactive CLI or installation witness.

The public Git installation route has **not yet been requalified** for this
candidate. No installability claim is made. Publication and a clean public pinned
installation witness are separate work; the previous public pin's missing-dist
failure is not superseded by this local evidence.

For developer checking/building, use Node.js >=22.19.0 and the exact peer/dev
dependency versions in package.json, already supplied locally:

```sh
npm run check
npm run build
```

These are developer commands, not an installer or a demonstrated public first-use
journey. The Pi resource points at `index.ts`; compiled library exports and types
remain a separate build contract. `pi_tuck_recall` provides keyword lookup and
original-source navigation; `pi_tuck_search` provides historical discovery with
lexical evidence available without semantics. Compaction preserves bounded
navigation back to original history; it is not a promise that every detail
remains in the active model context.

Semantic search is opt-in and currently limited to Apple Silicon. No weights,
encoder, utility environment or downloadable companion is shipped here. Publisher
assets must be acquired and authenticated separately; [RUNTIME.md](RUNTIME.md)
documents the host adapter contract, not a complete public setup journey. Lexical
use does not depend on those assets.

## Credits and license evidence

- [pi-vcc](https://github.com/sting8k/pi-vcc) by sting8k: this package includes
  derived work. The inherited LICENSE is MIT, Copyright (c) 2026 sting8k.
  The [upstream LICENSE inspected at 733e872bf39be627b1b9eb387f964256c77d3cb3](https://github.com/sting8k/pi-vcc/blob/733e872bf39be627b1b9eb387f964256c77d3cb3/LICENSE)
  has the same text. That current upstream snapshot is not an identification of
  the exact pi-vcc revision originally inherited here.
- [pi-blackhole](https://github.com/k0valik/pi-blackhole) by k0valik: retained
  headers credit `isContentBearing`, `extractToolCallText`, `getFileIndicators`
  and `getTouchedFiles` as ports from that MIT-licensed pi-vcc derivative.
  `src/pi-tuck/core/global-indices.ts` separately cites commit `f82e07a`.
  Its [LICENSE at f82e07a5595ee15f958c93f745fae805b26f0f4b](https://github.com/k0valik/pi-blackhole/blob/f82e07a5595ee15f958c93f745fae805b26f0f4b/LICENSE)
  is MIT, Copyright (c) 2026 k0valik; the complete notice is included in LICENSE.
  The [current inspected LICENSE at 0ce5ce5fec47223651644fcc967da34dd269f6f1](https://github.com/k0valik/pi-blackhole/blob/0ce5ce5fec47223651644fcc967da34dd269f6f1/LICENSE)
  is identical. The four other headers do not identify their port revision;
  neither inspected snapshot fills that lineage gap.

- [Pi](https://github.com/earendil-works/pi) by Mario Zechner: the two inlined
  message-construction branches in `src/pi-tuck/cut.ts` have their complete MIT
  notice retained in LICENSE, using the [Pi v1.1.0 notice at abe508e1b89912adde45528136c3221eb69acdd7](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/LICENSE).
  This notice-source pin does not identify the original copy revision.

Copyright (c) 2026 Rustem Galyavin identifies our contributions, not ownership
of the upstream work. The MIT copyright and permission notices must remain with
copies or substantial portions; the complete terms and warranty disclaimer are
in LICENSE. Source provenance and original public-read records are retained
outside this package for independent review, not bundled as Git history.

## Standalone synthetic lexical benchmark

From this source repository's root, with Node.js >=22.19.0 and the declared
TypeScript 5.9.3 development dependency already available:

```sh
nice -n 19 node benchmark/gate-suite.mjs \
  "$(dirname "$(pwd -P)")/tuck-benchmark-results-001" \
  "$(dirname "$(pwd -P)")/tuck-benchmark-work-001"
```

Use fresh absolute normalized destinations outside the source tree, with existing
nonsymlink parents; change both suffixes for another run. Unix `nice` at priority
19 is required. Keep both result and work directories. This command installs
nothing and loads no Vitest, extension host, model, network or private asset.
It is a source-tree command, not an npm script or an npm-tarball availability
claim. Local source is trusted code, not sandboxed.

The default creates a new self-reference from the current source tree, runs the
candidate plus harmless-change and actual-source-loss controls, and invokes the
real comparator. Success requires `suite.json` status 0; this includes the
intentional loss comparator exiting 1 with `Regression c01`. Unexpected failures
stop the suite, and existing results are never overwritten. To compare compatible
result files separately:

```sh
node benchmark/gate-compare.mjs BASELINE_RESULT.json CANDIDATE_RESULT.json
```

The fixed fictional fixture scores only delivered, source-backed literal facts.
Neither any case nor the aggregate may decrease. Results retain raw retrieval,
delivered snippets, scoring inputs, commands, source manifests and generated-module
identities. See [benchmark/README.md](benchmark/README.md) for exact budgets,
validation boundaries, controls and the optional explicit same-harness reference
source. The default self-reference checks mechanics, not non-regression against
an earlier release. No fresh benchmark result for this final tree is claimed here.

## Scope and limits

Only reproducible public synthetic lexical results may support bounded lexical
mechanics claims. This easy, fixed fixture does not establish binding-budget
stress, semantic recall, latency, integration, paired-release quality,
cross-platform behavior or release readiness. The benchmark itself does not
establish real-host registration. Nonsemantic
tests likewise do not establish those properties. Model-dependent qualification
and private evidence are not distributed. See
[CAPABILITY-INVENTORY.md](CAPABILITY-INVENTORY.md) for the shipped scope.
