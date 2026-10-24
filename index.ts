import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installCompaction } from "./src/compaction";
export type { CompactionOptions } from "./src/compaction";
export { installCompaction } from "./src/compaction";
export default async function(pi: ExtensionAPI) { await installCompaction(pi); }

export { inspectIncident, readableIncident } from "./src/diagnostic-replay.js";

export {createSemanticRecall, SemanticRecallController} from "./src/semantic-recall";
export type {SemanticRecallConfig, PriorResult, SemanticState} from "./src/semantic-recall";
