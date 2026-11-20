# Benchmarks: an index

This folder holds the plans, the results and the code behind the numbers in the [README](../README.md). This page only says where things are and which file is current. It adds no result of its own: every number lives in the file it links.

## How to read the folder

- `PREREG*.md` files are plans. Each was written before the run it plans, and says so at the top.
- `RESULTS*.md` files record what a run showed. Each states its own setup and limits.
- [`DEVIATIONS.md`](DEVIATIONS.md) logs every change made after a plan was written, in order. [`PINS.md`](PINS.md) lists the versions and models the numbers depend on.
- A result is about the build and the setup it names. A later result about a later build does not replace it unless the table below says so.

## Start here

[`RESULTS-MAIN.md`](RESULTS-MAIN.md) is the main run: pi-tuck 1.0.1 against Pi's compaction, 10 chains of 30 tasks, with its plan [`PREREG.md`](PREREG.md) and the addenda [`PREREG-TERRA.md`](PREREG-TERRA.md) and [`PREREG-CLUSTER.md`](PREREG-CLUSTER.md). Read the section "What tests 1a and 1b-Terra compare" in it before the numbers.

## Results

| File | What it records | Build it measured | Status |
|---|---|---|---|
| [`RESULTS-MAIN.md`](RESULTS-MAIN.md) | The main run: retention, tasks resolved, cut time and tokens, each against Pi's compaction | pi-tuck 1.0.1 | Current. Final numbers of that run |
| [`RESULTS-INTERIM.md`](RESULTS-INTERIM.md) | Cut time and context carried, from the first five chains, while the main run was still going | pi-tuck 1.0.1 | Superseded by `RESULTS-MAIN.md` |
| [`RESULTS-32K-ACCEPT.md`](RESULTS-32K-ACCEPT.md) | The 32k live suite and the acceptance test of the oversize-result fix | the 1.0.5 code (`aa30824`) | Corrected in place on 2026-11-01; current as corrected |
| [`RESULTS-DEFAULTS.md`](RESULTS-DEFAULTS.md) | One session at Pi's default compaction settings, 32k window | pi-tuck 1.0.8 | The result for that build. The same check on later builds is in `RESULTS-DEFAULTS-1010.md` |
| [`RESULTS-DEFAULTS-1010.md`](RESULTS-DEFAULTS-1010.md) | The same check on two later builds | the 1.0.10 candidate and a 1.0.11 candidate | Current for that check |
| [`RESULTS-V108.md`](RESULTS-V108.md) | Candidate gate against 1.0.7, 32k | the 1.0.8 candidate | Gate result for that build |
| [`RESULTS-V110.md`](RESULTS-V110.md) | Candidate gate against 1.0.9, 32k | the 1.0.10 candidate | Gate result for that build |
| [`RESULTS-ADAPTIVE.md`](RESULTS-ADAPTIVE.md) | Tier 2 gate against 1.0.12, window 81,920 | `882f6f6` (the code of 1.0.13) | Gate result for that build |
| [`RESULTS-V1016.md`](RESULTS-V1016.md) | Tier 1 gate against the recorded 1.0.13 arm, window 81,920 | pi-tuck 1.0.16 | Gate result for that build |
| [`RESULTS-V1018.md`](RESULTS-V1018.md) | Tier 1 gate against the recorded 1.0.16 arm, window 81,920 | pi-tuck 1.0.18 | Gate result for that build |
| [`RESULTS-CUTLATER.md`](RESULTS-CUTLATER.md) | A two-build test at 32k, on chains t01 to t05 | `16de3a9` against the 1.0.10 candidate `a67ec30` | A test of one setting, not a release gate |
| [`RESULTS-SUMMARYONLY.md`](RESULTS-SUMMARYONLY.md) | A replay retention test of pi-tuck's summary and kept messages without its recall tools | the summaries of the main run | A test, read on the main-run recordings |
| [`RESULTS-PILOT.md`](RESULTS-PILOT.md) | A thinking-level pilot, `medium` against `xhigh` | a 1.0.11 candidate (`22043bb`) | A coarse screen; the file says it is not a gate of any build |
| [`RESULTS-REMEASURE.md`](RESULTS-REMEASURE.md) | A re-measure of retention that was stopped early | pi-tuck 1.0.11 | Closed with no result. The file says why |

The README quotes numbers from `RESULTS-MAIN.md`, `RESULTS-32K-ACCEPT.md`, `RESULTS-DEFAULTS.md`, `RESULTS-DEFAULTS-1010.md`, `RESULTS-V108.md`, `RESULTS-V110.md`, `RESULTS-ADAPTIVE.md`, `RESULTS-V1016.md` and `RESULTS-V1018.md`.

## Plans

| File | What it plans | Where the result is |
|---|---|---|
| [`PREREG.md`](PREREG.md) | The main run | `RESULTS-MAIN.md` |
| [`PREREG-TERRA.md`](PREREG-TERRA.md) | Replaces the frontier comparator of the main run | `RESULTS-MAIN.md` |
| [`PREREG-CLUSTER.md`](PREREG-CLUSTER.md) | A second bound, clustered by chain, beside the registered one | `RESULTS-MAIN.md` |
| [`PREREG-ABORTCHECK.md`](PREREG-ABORTCHECK.md) | A check of why some answer sets of the main replay ended in an abort | The section "Answer sets lost to aborts in the recall arms" of `RESULTS-MAIN.md` |
| [`PREREG-32K.md`](PREREG-32K.md) | The 32k live suite | `RESULTS-32K-ACCEPT.md` |
| [`PREREG-DEFAULTS.md`](PREREG-DEFAULTS.md) | pi-tuck at Pi's default compaction settings | `RESULTS-DEFAULTS.md`, `RESULTS-DEFAULTS-1010.md` |
| [`PREREG-V108.md`](PREREG-V108.md) | The 1.0.8 candidate gate | `RESULTS-V108.md` |
| [`PREREG-V110.md`](PREREG-V110.md) | The 1.0.10 candidate gate | `RESULTS-V110.md` |
| [`PREREG-ADAPTIVE.md`](PREREG-ADAPTIVE.md) | The Tier 2 gate of the adaptive cut point, and, under "Later gates", one line for each gate that followed | `RESULTS-ADAPTIVE.md`, `RESULTS-V1016.md`, `RESULTS-V1018.md` |
| [`PREREG-CUTLATER.md`](PREREG-CUTLATER.md) | The cut-later test | `RESULTS-CUTLATER.md` |
| [`PREREG-SUMMARYONLY.md`](PREREG-SUMMARYONLY.md) | The summary-only retention test | `RESULTS-SUMMARYONLY.md` |
| [`PREREG-PILOT.md`](PREREG-PILOT.md) | The thinking-level pilot | `RESULTS-PILOT.md` |
| [`PREREG-REMEASURE.md`](PREREG-REMEASURE.md) | The re-measure of retention | `RESULTS-REMEASURE.md` (closed, no result) |
| [`PREREG-V103.md`](PREREG-V103.md) | The same tests for pi-tuck 1.0.3 | No result file in this folder |
| [`PREREG-LME.md`](PREREG-LME.md) | A test on the public LongMemEval-S set | No result file in this folder; the code is in `lme/` |
| [`PREREG-RECALL.md`](PREREG-RECALL.md) | A test of independent questions and of the search tool removed in 1.2.0 | No result file in this folder; the code is in `recall/` |

## Folders

- `analysis/`: scripts that compute the numbers in the result files.
- `data/`: the task draws, and the records of the main run.
- `harness/`: the code that runs the live arms.
- `replay/`: the code that replays recorded sessions through each compactor and asks the probe questions.
- `lme/`, `recall/`: code for the two plans above that have no result file.

Raw session recordings are not in the repository.
