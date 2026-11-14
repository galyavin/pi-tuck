import type { SessionEntry } from "@earendil-works/pi-coding-agent";

/** Where the current view starts, as a branch position: the latest compaction entry's first kept entry. Earlier entries were compacted away. With no compaction, nothing is out of view. */
export function viewStart(branch:SessionEntry[]):number{
 const at=branch.findLastIndex(entry=>entry.type==='compaction');if(at<0)return 0;
 const entry=branch[at]!,kept=entry.type==='compaction'?branch.findIndex(candidate=>candidate.id===entry.firstKeptEntryId):-1;
 return kept>=0&&kept<=at?kept:at;
}
