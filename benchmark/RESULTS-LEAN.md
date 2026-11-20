# Lean cuts and the 1.0.2 bundle: replay results

R&D replays, 2026-10-31. Same numbers as `rnd/IDEAS.md`. Model: DeepSeek flash on OpenRouter (`openrouter/~deepseek/deepseek-flash-latest:high`), as agent and as next_step judge, the same on both sides.
Sessions (5): eval recordings s02-A and s02-B, live pilot recordings p01-A, p01-B and p02-A.
Gate per set: discordant pairs on the same probes, losses − wins ≤ max(2, ⌊0.05·n⌋). A loss is a probe the base answers right and the variant wrong.

## Lean cuts (`GATE-lean.md`): PASS on all three conditions
Build 1bda64b, cutAt 0.6 against cutAt 1, same tree. Windows: 128k is 131,072 with reserve 32,768; 32k is 32,768 with reserve 16,384. Cuts come from pi-tuck's own trigger (`trigger-cuts.ts`).

Answers:

| Set | n | Losses | Wins | Limit | Without files_changed (n, losses / wins) |
|---|---|---|---|---|---|
| 128k shared | 99 | 3 | 7 | 4 | 78, 3 / 6 |
| 128k asymmetric | 67 | 3 | 1 | 3 | 27, 1 / 0 |
| 32k shared | 77 | 5 | 3 | 3 | 77, 5 / 3 |
| 32k asymmetric | 343 | 9 | 5 | 17 | 255, 8 / 3 |

Shared probes sit at moments both variants share. Asymmetric probes ask about evidence that the base keeps native and the variant has summarised.

Billed input, 0.6 against 1. This is simulated billing (`rnd/billing.ts`) over the same 5 sessions replayed through the real trigger, not provider bills. Auto is prefix caching at 0.1× for the shared prefix. Explicit is cache breakpoints, written at 1.25× and read at 0.1×.

| Window | Auto | Explicit |
|---|---|---|
| 128k | −17.9% | −17.0% |
| 32k | −14.0% | −9.6% |

Cut yield: cuts go from 6 to 12 at 128k and from 84 to 157 at 32k. None frees less than a tenth of the room.

Watch item: in 32k asymmetric, the losses lean against 0.6 (test_result 4 / 2, error_hit 3 / 1). They are inside the limit. This set is re-checked when more eval recordings land.

Spend: about $1.64.

## 1.0.2 bundle arm: PASS on all four sets
bfebec0 against cea8ef4. At 128k cuts sit at the eval's fixed positions; at 32k they come from pi-tuck's own trigger.

| Set | n | Losses | Wins | Limit |
|---|---|---|---|---|
| 128k main | 128 | 1 | 2 | 6 |
| 128k time | 48 | 0 | 0 | 2 |
| 32k main | 127 | 4 | 2 | 6 |
| 32k asymmetric | 56 | 0 | 2 | 2 |

11 of 146 answer sessions hit the 15-minute wall limit (5 base, 6 bundle), and their probes drop out of the pairing.

Spend: about $0.95.
