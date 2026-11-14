import type { SessionEntry, SessionHeader } from "@earendil-works/pi-coding-agent";
import { posix } from "node:path";
import { isTextOnly, textOf } from "./tuck/core/content";
import { extractPath } from "./tuck/core/tool-args";
import type { TranscriptRecord } from "./tuck/core/transcript";

// A deliberately bounded shell recognizer: substitutions, redirections and
// unrecognized composition never certify a command as read-only.
function shellWords(command: string): { words: string[]; simple: boolean } {
	const words: string[] = []; let word = "", quote = "", started = false, simple = true;
	const flush = () => { if (started) words.push(word); word = ""; started = false; };
	for (let i = 0; i < command.length; i++) {
		const c = command[i]!;
		if (quote === "'") { if (c === quote) quote = ""; else word += c; continue; }
		if (c === "\\") { if (command[i + 1] === "\n") { i++; continue; } started = true; if (i + 1 < command.length) word += command[++i]; else simple = false; continue; }
		if (c === "$" || c === "`") simple = false;
		if (quote) { if (c === quote) quote = ""; else word += c; continue; }
		if (c === "'" || c === '"') { quote = c; started = true; }
		else if (/\s/u.test(c)) { flush(); if (c === "\n") { words.push(";"); simple = false; } }
		else if (/[|&;<>]/u.test(c)) { flush(); const op = command[i + 1] === c ? c + command[++i] : c; words.push(op); }
		else { word += c; started = true; if (/[(){}]/u.test(c)) simple = false; }
	}
	flush(); return { words, simple: simple && !quote };
}
const readers = new Set(["ls", "cat", "head", "tail", "wc", "pwd", "echo", "tree", "file", "stat", "grep", "rg"]);
const gitMutations = new Set(["checkout", "restore", "stash", "apply", "reset", "pull", "merge", "rebase", "am"]);
function mutatingGit(words: string[]): boolean {
	return words.some((word, at) => {
		if (posix.basename(word) !== "git") return false;
		for (let i = at + 1; i < words.length; i++) {
			const arg = words[i]!;
			if (["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"].includes(arg)) { i++; continue; }
			if (arg.startsWith("-")) continue;
			return gitMutations.has(arg);
		}
		return false;
	});
}
function readOnly(words: string[], simple: boolean): boolean {
	if (!simple) return false;
	if (words[0] === "cd" && words[2] === "&&") words = words.slice(3);
	if (!words.length || words.some(word => ["&&", "||", "&", ";", ">", ">>", "<", "<<"].includes(word))) return false;
	const commands: string[][] = [[]];
	for (const word of words) { if (word === "|") commands.push([]); else commands.at(-1)!.push(word); }
	return commands.every(([name, ...args]) => readers.has(name!) ||
		name === "find" && !args.some(arg => /^-(exec|delete|fprint)/u.test(arg)) ||
		name === "sed" && args.includes("-n") && !args.some(arg => /^-[^-]*i|^--in-place/u.test(arg)) ||
		name === "git" && ["status", "log", "diff", "show"].includes(args[0]!));
}
const pathKey = (path: string, cwd?: string) => posix.normalize(cwd && !posix.isAbsolute(path) ? posix.join(cwd, path) : path);

/** Whole successful text reads, newest result first. Mutations invalidate earlier calls even when they fail or have no result. */
export function keptReadCandidates(entries: readonly (SessionEntry | SessionHeader)[], indices: ReadonlyMap<string, number>,
	resolvable: (entry: SessionEntry) => boolean): TranscriptRecord[] {
	const cwd = entries.find((entry): entry is SessionHeader => entry.type === "session")?.cwd;
	const reads = new Map<string, { path: string; key: string; order: number }>(), mutations = new Map<string, number>();
	let allMutated = -1;
	let order = 0;
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		for (const block of entry.message.content) {
			if (block.type !== "toolCall" || !["read", "write", "edit", "bash"].includes(block.name) ||
				!block.arguments || typeof block.arguments !== "object") continue;
			const args = block.arguments as Record<string, unknown>;
			order++;
			if (block.name === "bash") {
				if (!reads.size || typeof args.command !== "string") continue;
				const { words, simple } = shellWords(args.command);
				if (readOnly(words, simple)) continue;
				if (mutatingGit(words) || !simple && mutatingGit(args.command.split(/[\s'"`();|&]+/u))) { allMutated = order; continue; }
				const base = words[0] === "cd" && words[2] === "&&" ? pathKey(words[1]!, cwd) : cwd;
				const names = [...words, ...args.command.split(/[\s'"`=;|&()<>{},]+/u)];
				for (const name of names) if (name) { mutations.set(pathKey(name), order); mutations.set(pathKey(name, base), order); }
				continue;
			}
			const path = extractPath(args);
			if (!path || /[\r\n]/u.test(path)) continue;
			const key = pathKey(path, cwd);
			if (block.name === "read") {
				if (!("offset" in args) && !("limit" in args)) reads.set(block.id, { path, key, order });
			} else mutations.set(key, order);
		}
	}
	const seen = new Set<string>(), records: TranscriptRecord[] = [];
	for (let at = entries.length - 1; at >= 0; at--) {
		const entry = entries[at]!;
		if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.isError || !isTextOnly(entry.message.content)) continue;
		const read = reads.get(entry.message.toolCallId), sourceIndex = indices.get(entry.id);
		if (!read || seen.has(read.key) || Math.max(allMutated, mutations.get(read.key) ?? -1, mutations.get(pathKey(read.path)) ?? -1) > read.order) continue;
		const text = textOf(entry.message.content);
		if (!text.length || sourceIndex === undefined || !resolvable(entry)) continue;
		seen.add(read.key);
		records.push({ kind: "section", title: "Kept-read", sourceIndex,
			text: `read ${read.path} (as recorded at #${sourceIndex}; no write or edit recorded since):\n${text}` });
	}
	return records;
}
