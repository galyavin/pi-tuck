# Part 1 results

All seven shapes ran at all three windows on the working tree and on exported v1.0.16, v1.0.15 and 7bcd355 trees, each overlaid with the same tests. The long-steering cells contain timestamped pasted logs. Reserve is 16,384; keepRecent is 20,000. Every cell saved real cuts, and every huge-result cell delivered clipped results to the provider.

**v1.0.16 does not pass every check.** It passes the whole-current-prompt and refusal checks throughout. It loses the first prompt’s opening during the 32k huge-result shape and fails the omission check in every cell. Both older builds also lose required openings in several other shapes.

P = complete current prompt; O = first/newest eight answered openings; M = counted omissions with source pointers; R = refusal only when the current prompt alone does not fit. Cells list failing checks. An absent letter passed throughout that cell.

| Shape | Window | v1.0.16 | v1.0.15 | 7bcd355 |
| --- | ---: | --- | --- | --- |
| one-prompt-tool-run | 32,768 | M | M | M |
| spec-short-steering | 32,768 | M | M | O, M |
| spec-long-steering | 32,768 | M | O, M | O, M |
| tasks-short-steps | 32,768 | M | O, M | O, M |
| tasks-long-steps | 32,768 | M | O, M | O, M |
| tool-heavy-step | 32,768 | M | O, M | M |
| huge-tool-results | 32,768 | O, M | M | O, M |
| one-prompt-tool-run | 81,920 | M | M | M |
| spec-short-steering | 81,920 | M | M | O, M |
| spec-long-steering | 81,920 | M | O, M | O, M |
| tasks-short-steps | 81,920 | M | O, M | O, M |
| tasks-long-steps | 81,920 | M | O, M | O, M |
| tool-heavy-step | 81,920 | M | M | M |
| huge-tool-results | 81,920 | M | M | M |
| one-prompt-tool-run | 131,072 | M | M | M |
| spec-short-steering | 131,072 | M | M | M |
| spec-long-steering | 131,072 | M | O, M | O, M |
| tasks-short-steps | 131,072 | M | O, M | M |
| tasks-long-steps | 131,072 | M | O, M | O, M |
| tool-heavy-step | 131,072 | M | M | M |
| huge-tool-results | 131,072 | M | M | M |

| Build | Cells | Saved cuts | Actual requests | Refused prompts | Cells losing openings |
| --- | ---: | ---: | ---: | ---: | ---: |
| v1.0.16 | 21 | 361 | 3622 | 8 | 1 |
| v1.0.15 | 21 | 350 | 3622 | 8 | 10 |
| 7bcd355 | 21 | 354 | 3622 | 8 | 11 |

All eight refused prompts in each build were 18k/25k task inputs at the 16,384-token room. No fitting prompt was refused. The v1.0.16 opening loss occurs at prompt 2, after its first tool request, at both the saved tool-loop cut and the next provider request; original user index #1 is missing its first 80 characters.

The omission failures include historical tool results replaced by a generic notice with neither a count nor original source pointers. Some cells also drop or clip dialogue whose omission coverage is incomplete. The check requires every omitted unit’s pointer; an aggregate count with only the first eight locators does not cover its unlisted units. These are contract findings, not harness errors.

[evidence.json](./evidence.json) records every cell’s coverage, failure counts and representative source indices. [v1.0.16.json](./v1.0.16.json) records failed logical assertions for the default regression gate: a new failure at a previously passing boundary fails the test. Strict mode requires all four checks to pass. Full per-observation JSON is produced by `SHAPES_REPORT` and by the comparison script.

Revisions: v1.0.16 `012ee9053606bd53aa975fa7e037f493251ce46a`; v1.0.15 `9050ff73a02cf797d9e4c51161e0f9df97cd0ff7`; 7bcd355 `7bcd3552f900f64cfce676f358795cc9aeef3d39`. Worktree HEAD `dee0eab` has the same production source as v1.0.16. No production files were changed. Nothing was staged or committed, and the dependency symlink was left intact.

Validation on 2026-11-08:

- `npx tsc -p tsconfig.tests.json --noEmit`: passed.
- `SHAPES=1 npx vitest run test/shapes --testTimeout=300000`: **28 passed** (21 session cells and 7 oracle tests), 75.81 seconds. The final working-tree run reproduced every exported v1.0.16 failing assertion, with no new failures. It checked 3,622 whole prompts, 3,611 opening/omission views and 1,710 turn outcomes. Known contract findings are allowed only at their saved baseline boundaries.
- Historical exports: all 63 cells completed without harness errors or hollow shapes. The final pasted-log cells were also rerun on each export.
- `STRESS=1 npx vitest run test/stress --testTimeout=300000`: completed 279 cells, exit 0 in its default reporting mode; 43 findings (40 task-turn, 1 useful-cut, 1 refusal, 1 fresh-room).
- `npx vitest run --testTimeout=300000`: **630 passed, 5 failed, 21 skipped**. Three failures were regression benchmark timing limits; one was the mode test's explicit 60-second timeout; one was provisioning's required 5 GiB free-space reserve, with only 2.4 GiB available.
- Required separate `test/regression-bench.test.ts` rerun: 10 passed, 2 timing failures. Cut counts, yield, carried context, summary sizes and refusals matched the goldens; only median cut durations exceeded the limits. `test/semantic-heal-process.test.ts` passed in the full suite and needed no rerun.
- Focused mode/provision rerun reproduced the timeout and free-space failures. A subsequent `test/mode.test.ts` run with no other test run active **passed all 8 tests** in 22.50 seconds. Provisioning's free-space failure remains.
