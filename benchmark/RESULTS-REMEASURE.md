# Re-measure of retention on pi-tuck 1.0.11 (`PREREG-REMEASURE.md`): closed, stopped at 8 of 190 answer sets

**No result.** The test was registered on 2026-11-06 for 190 answer sets (95 cuts, arms `tuck` and `tuck-lexical`) at a 128,000-token window on the model setup in place when it was registered. It was stopped after 8 sets and will not be resumed, because the setup it was registered for no longer exists. None of its bars was read, no accuracy was scored, and no retention claim past cut 4 comes from it. The registration stands as written; this file only records how far it got and why it ended.

## Why it ended

The registered setup is gone. The test is at a 128,000-token window, and on 2026-11-06 the maintainers confirmed that the model setup now served by `mac-studio/main` has a context of 81,920 tokens (one fingerprint, `d2c36f5557c43295`, in every sample since the first one at 14:55 that day). The registration also says that sets answered on different models are never pooled, and the comparators' answers (1 to 5 November) were made on the earlier model. Which model served the 8 sets below is not established: they ran from 13:41, before the first fingerprint sample. Finishing the other 182 sets would have measured a setup that the registered window and comparators do not describe. The run's scheduler was stopped at 16:02 that day; the sets in flight were cut off and left no record.

## What ran

- Started 13:41 on 2026-11-06 with up to 8 lanes, cut 5 first, on `v1.0.11` (`b231800`), Pi's compaction on, 60-minute wall per set.
- Four sets were set aside as infrastructure at 14:27 when the model server's engine restarted (`tuck` `s01-A` and `s03-B`, `tuck-lexical` `s03-B` and `s04-A`, all cut 5; the registered rule: kept aside, not counted, to be rerun). They were not rerun.
- Eight sets finished, all at cut 5:

| arm | recording | ending | seconds |
|---|---|---|---|
| `tuck` | s04-A | wall-bound | 3,600 |
| `tuck` | s04-B | answered | 3,172 |
| `tuck-lexical` | s01-A | answered | 1,027 |
| `tuck-lexical` | s04-B | wall-bound | 3,600 |
| `tuck-lexical` | s05-A | wall-bound | 3,600 |
| `tuck-lexical` | s06-B | wall-bound | 3,600 |
| `tuck-lexical` | s09-A | answered | 3,483 |
| `tuck-lexical` | s09-B | wall-bound | 3,600 |

Three sets were answered and five were wall-bound; none ended in a refusal by the extension and none made an in-run cut. Seven of the eight sets saw server replies of "Service maintenance is in progress", "engine is recovering" or a 502 on their requests while they ran, so the wall-bound endings cannot be read as the build's behaviour: the server's maintenance, not the build, is the likely limit. The records are kept in `runs/remeasure-1011` and nothing is deleted.

## Not claimed

Nothing about pi-tuck's retention at any cut, on any model, window or build, and nothing about how often its answer sets end in an abort. The earlier abort check (`RESULTS-MAIN.md`) and the tests as registered at cuts 1 to 4 are unchanged. A retention claim past cut 4 needs a new registration on the current model and window.
