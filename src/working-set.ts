import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { pathKey } from "./path-key";
import { isTextOnly, textOf } from "./tuck/core/content";
import { extractPath } from "./tuck/core/tool-args";

/** Pi's read tool returns at most 50KB of a file's text, so a larger file can never equal a recorded whole read. */
const MAX_FILE_BYTES = 64 * 1024;
/** Reads a file's current text, or undefined when it cannot be read. Never throws. */
export type FileReader = (absolutePath: string) => string | undefined;
const diskReader: FileReader = path => {
	try { return statSync(path).size > MAX_FILE_BYTES ? undefined : readFileSync(path, "utf8"); } catch { return undefined; }
};
let reader = diskReader;
/** Test and offline-replay seam: where carried files are checked. Undefined restores the disk. */
export const setWorkingFileReader = (next?: FileReader): void => { reader = next ?? diskReader; };

/** Where Pi's read tool reads a recorded path: an "@" prefix dropped, "~" expanded, relative to the session's folder. */
export const readPath = (path: string, cwd: string): string => {
	let name = path.startsWith("@") ? path.slice(1) : path;
	if (name === "~") name = homedir(); else if (name.startsWith("~/")) name = homedir() + name.slice(1);
	return isAbsolute(name) ? name : resolve(cwd, name);
};

export interface WorkingFile { path: string; key: string; reads: number; sourceIndex: number; position: number; text: string }
/**
 * The files the agent has read more than once, most reads first, then most recent last read. A file is carried only when its last read
 * covered the whole file (no offset or limit) and the file on disk holds exactly that read's text now. Pi's read tool returns a whole small
 * file verbatim, so equality proves both that the read was complete and that nothing (an edit, a write, a shell command, a generator) has
 * changed the file since. `rejected` counts the files whose last read was whole but whose disk text differs or cannot be read.
 * Only last reads inside the compacted prefix (before `boundary`) are offered: a later read is still in the native tail.
 */
export function workingSetCandidates(entries: readonly SessionEntry[], boundary: number, indices: ReadonlyMap<string, number>, cwd: string,
	resolvable: (entry: SessionEntry) => boolean): { files: WorkingFile[]; rejected: number } {
	const calls = new Map<string, { path: string; key: string; whole: boolean }>(), last = new Map<string, string>(), reads = new Map<string, number>();
	const results = new Map<string, { entry: SessionEntry; position: number }>();
	entries.forEach((entry, position) => {
		if (entry.type !== "message") return;
		if (entry.message.role === "toolResult") { results.set(entry.message.toolCallId, { entry, position }); return; }
		if (entry.message.role !== "assistant") return;
		for (const block of entry.message.content) {
			if (block.type !== "toolCall" || block.name !== "read" || !block.arguments || typeof block.arguments !== "object") continue;
			const args = block.arguments as Record<string, unknown>, path = extractPath(args);
			if (!path || /[\r\n]/u.test(path)) continue;
			const key = pathKey(path, cwd);
			calls.set(block.id, { path, key, whole: !("offset" in args) && !("limit" in args) });
			last.set(key, block.id); reads.set(key, (reads.get(key) ?? 0) + 1);
		}
	});
	const files: WorkingFile[] = [];
	let rejected = 0;
	for (const [key, id] of last) {
		const count = reads.get(key)!, call = calls.get(id)!, result = results.get(id);
		if (count < 2 || !call.whole || !result || result.position >= boundary) continue;
		const { entry, position } = result;
		if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.isError || !isTextOnly(entry.message.content)) continue;
		const text = textOf(entry.message.content), sourceIndex = indices.get(entry.id);
		if (!text.length || sourceIndex === undefined || !resolvable(entry)) continue;
		if (reader(readPath(call.path, cwd)) !== text) { rejected++; continue; }
		files.push({ path: call.path, key, reads: count, sourceIndex, position, text });
	}
	files.sort((a, b) => b.reads - a.reads || b.position - a.position);
	return { files, rejected };
}
