import { posix } from "node:path";

// A deliberately bounded shell recognizer: substitutions, redirections and
// unrecognized composition never certify a command as read-only.
function shellWords(command: string, windows: boolean): { words: string[]; simple: boolean } {
	const words: string[] = []; let word = "", quote = "", started = false, simple = true;
	const flush = () => { if (started) words.push(word); word = ""; started = false; };
	for (let i = 0; i < command.length; i++) {
		const c = command[i]!;
		if (quote === "'") { if (c === quote) quote = ""; else word += c; continue; }
		if (c === "\\" && !windows) { if (command[i + 1] === "\n") { i++; continue; } started = true; if (i + 1 < command.length) word += command[++i]; else simple = false; continue; }
		if (c === "$" || c === "`") simple = false;
		if (windows && (c === "%" || c === "^")) simple = false;
		if (quote) { if (c === quote) quote = ""; else word += c; continue; }
		if (c === "'" || c === '"') { quote = c; started = true; }
		else if (/\s/u.test(c)) { flush(); if (c === "\n") { words.push(";"); simple = false; } }
		else if (/[|&;<>]/u.test(c)) { flush(); const op = command[i + 1] === c ? c + command[++i] : c; words.push(op); }
		else { word += c; started = true; if (/[(){}]/u.test(c)) simple = false; }
	}
	flush(); return { words, simple: simple && !quote };
}
const readers = new Set(["ls", "cat", "head", "tail", "wc", "pwd", "echo", "tree", "file", "stat", "grep", "rg"]);
const windowsReaders = new Set(["type", "dir", "get-content", "get-childitem", "select-string", "findstr"]);
const windowsMutators = new Set(["set-content", "add-content", "out-file", "remove-item", "move-item", "copy-item", "new-item", "del", "move", "copy", "ren"]);
const gitMutations = new Set(["checkout", "restore", "stash", "apply", "reset", "pull", "merge", "rebase", "am"]);
function mutatingGit(words: string[]): boolean {
	return words.some((word, at) => {
		if (posix.basename(word.replace(/\\/gu, "/")).replace(/\.exe$/iu, "").toLowerCase() !== "git") return false;
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
	return commands.every(([name, ...args]) => readers.has(name!) || windowsReaders.has(name?.toLowerCase() ?? "") ||
		name === "find" && !args.some(arg => /^-(exec|ok|delete|fprint)/u.test(arg)) ||
		name === "sed" && args.includes("-n") && !args.some(arg => /^-[^-]*i|^--in-place/u.test(arg)) ||
		name === "git" && ["status", "log", "diff", "show"].includes(args[0]!));
}

/** Classify the recorded shell independently of the host OS. Both kept-result lanes use this decision. */
export function classifyBash(command: string, cwd?: string) {
	const commandName = command.trim().split(/\s/u)[0]!.toLowerCase();
	const windows = /^[a-z]:[\\/]|\\/iu.test(cwd ?? "") || /[a-z]:\\/iu.test(command) ||
		windowsReaders.has(commandName) || windowsMutators.has(commandName);
	const { words, simple } = shellWords(command, windows);
	return { words, windows, readOnly: readOnly(words, simple),
		mutatesAll: mutatingGit(words) || !simple && mutatingGit(command.split(/[\s'"`();|&]+/u)),
		directory: words[0] === "cd" && words[2] === "&&" ? words[1] : undefined };
}
