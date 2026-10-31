import { LEGACY_TRANSCRIPT_HEADER, TRANSCRIPT_HEADER_V1 } from '../src/tuck/core/transcript';
import { DIALOGUE_SUFFIX } from '../src/tuck/core/format';

// Summaries saved by 1.0.x are one JSON object per line under TUCK-TRANSCRIPT/1 (VCC-TRANSCRIPT/1 before the rename). This build reads
// them and no longer writes them, so the tests that need one build it here, exactly as that format wrote it.
export const v1Body = (records: readonly object[]): string => records.map(record => JSON.stringify(record)).join('\n');
export const v1Summary = (records: readonly object[], closing = DIALOGUE_SUFFIX, header = TRANSCRIPT_HEADER_V1): string => `${header}\n${v1Body(records)}${closing}`;
export const legacySummary = (records: readonly object[], closing = DIALOGUE_SUFFIX): string => v1Summary(records, closing, LEGACY_TRANSCRIPT_HEADER);
