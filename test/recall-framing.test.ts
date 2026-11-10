import { type ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { installCompaction } from "../src/compaction.js";
import { CLOSING_INSTRUCTION } from "../src/tuck/core/format.js";

// What the agent is told about recall (K8): when to look things up, that `around` takes the #N a summary shows, and how to recover when an
// index was passed as an entryId. Scoops sessions showed `{"around": "<phrase>", "index": "214"}` and `{"entryId": "334"}` for #334.
async function tools(search = true) {
	const found: Record<string, { description: string; execute: (...a: unknown[]) => Promise<{ content: { text: string }[] }> }> = {};
	await installCompaction({ registerCommand: () => {}, registerTool: (tool: { name: string }) => { found[tool.name] = tool as never; }, on: () => () => {} } as unknown as ExtensionAPI, { search });
	return found;
}
function session() {
	const s = SessionManager.inMemory(process.cwd()), ids: string[] = [];
	for (let i = 0; i < 6; i++) ids.push(s.appendMessage({ role: "user", content: `turn ${i}`, timestamp: i }));
	return { s, ids };
}
const run = async (input: unknown, s: SessionManager) => {
	const recall = (await tools()).tuck_recall!;
	return JSON.parse((await recall.execute("read", input, undefined, () => {}, { sessionManager: s, cwd: process.cwd() })).content[0]!.text);
};

test("the summary's closing line says when to look up, names both tools, and keeps the re-read rule", () => {
	expect(CLOSING_INSTRUCTION).toContain("tuck_search");
	expect(CLOSING_INSTRUCTION).toContain("Before redoing a step or deciding from memory, look it up");
	expect(CLOSING_INSTRUCTION).toContain("Re-read a file before editing or importing it.");
	expect(CLOSING_INSTRUCTION.length).toBeLessThanOrEqual(327); // no longer than the line it replaces: a summary's frame costs room at small windows
	expect(CLOSING_INSTRUCTION).not.toContain("Treat anything not shown here as unknown");
});

test("both tool descriptions open with when to use them; tuck_recall points to tuck_search only where it exists", async () => {
	const on = await tools(true), off = await tools(false);
	expect(on.tuck_recall!.description.startsWith("Read anything from before a cut, word for word: use it before redoing a step or answering from memory.")).toBe(true);
	expect(on.tuck_search!.description).toContain("Use it before redoing work or answering from memory.");
	expect(on.tuck_recall!.description).toContain("{around: index or entryId, before, after}");
	expect(off.tuck_recall!.description.includes("tuck_search")).toBe(false);
});

test("around takes a summary index as well as an entryId, and the same neighbours come back", async () => {
	const { s, ids } = session();
	const byId = await run({ around: ids[3], before: 1, after: 1 }, s), byIndex = await run({ around: 3, before: 1, after: 1 }, s);
	expect(byId.status).toBe("ok");
	expect(byIndex).toEqual(byId);
	expect((await run({ around: 99 }, s)).status).toBe("not_found");
});

test("an all-digit entryId that finds nothing says how to read it as an index; other misses are unchanged", async () => {
	const { s } = session();
	const read = await run({ entryId: "3" }, s), around = await run({ around: "3" }, s), other = await run({ entryId: "zz99" }, s);
	expect(read.status).toBe("not_found");
	expect(read.notice).toContain('If 3 is a summary index (#3), pass {"index": 3}.');
	expect(around.notice).toContain('If 3 is a summary index (#3), pass {"index": 3}.');
	expect(other.status).toBe("not_found");
	expect(JSON.stringify(other)).not.toContain("summary index");
});
