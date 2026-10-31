// The context a live session carries right after each of its cuts, measured the way replay measures every compactor's "context carried":
// Pi's own chars/4 estimate of the projection (summary plus kept messages). Works from the session file's compaction entries, so it covers both
// arms (pi-tuck's tool-loop cuts emit no events). Usage: live_after.ts SESSION_DIR... ; writes SESSION_DIR/cuts-after.json
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { carried, sessionOf, type Entry, type Recording } from "./lib.js";

for (const dir of process.argv.slice(2)) {
	const file = join(dir, "session.jsonl");
	if (!existsSync(file)) continue;
	const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
	const header = lines[0], entries = lines.slice(1) as Entry[];
	const cuts: { index: number; tokensBefore: number; carriedAfter: number }[] = [];
	entries.forEach((entry, i) => {
		if ((entry as any).type !== "compaction") return;
		const manager = sessionOf({ cwd: header.cwd, header } as Recording, entries.slice(0, i + 1));
		cuts.push({ index: cuts.length + 1, tokensBefore: (entry as any).tokensBefore, carriedAfter: carried(manager) });
	});
	writeFileSync(join(dir, "cuts-after.json"), JSON.stringify(cuts, null, 1));
	console.log(dir, cuts.map(c => c.carriedAfter).join(" "));
}
