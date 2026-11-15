import type { SessionEntry, SessionHeader } from "@earendil-works/pi-coding-agent";
import { classifyBash } from "./bash-command";
import { pathKey } from "./path-key";
import { isTextOnly, textOf } from "./tuck/core/content";
import { extractPath } from "./tuck/core/tool-args";
import type { TranscriptRecord } from "./tuck/core/transcript";

interface Pipeline { directory?: string; stages: string[][] }
const searchTail = new Set(["head", "tail", "sort", "uniq", "wc", "cut", "grep"]);

/** A small shell lexer, not a shell interpreter. Unclassified shell syntax fails closed. */
function pipeline(command: string, windows: boolean): Pipeline | undefined {
	if (/[;<>`\r\n]/u.test(command) || command.includes("$(")) return;
	const expands = (at: number) => command[at] === "$" && /[\w{@*#!?$-]/u.test(command[at + 1] ?? "");
	const tokens: { word: string; operator?: boolean }[] = [];
	let word = "", started = false, quote = "";
	const flush = () => { if (started) tokens.push({ word }); word = ""; started = false; };
	for (let at = 0; at < command.length; at++) {
		const ch = command[at]!;
		if (quote) {
			if (ch === quote) quote = "";
			else if (!windows && ch === "\\" && quote === '"' && /[\\"$]/u.test(command[at + 1] ?? "")) word += command[++at];
			else if (quote === '"' && expands(at)) return;
			else word += ch;
		} else if (ch === "'" || ch === '"') { quote = ch; started = true; }
		else if (!windows && ch === "\\") { if (++at === command.length) return; word += command[at]; started = true; }
		else if (/\s/u.test(ch)) flush();
		else if (ch === "|" || ch === "&") {
			flush();
			const op = command[at + 1] === ch ? ch + command[++at] : ch;
			if (op !== "|" && op !== "&&") return;
			tokens.push({ word: op, operator: true });
		} else if (/[()]/u.test(ch) || ch === "#" && !started || expands(at)) return;
		else { word += ch; started = true; }
	}
	if (quote) return;
	flush();
	let directory: string | undefined;
	if (tokens[0]?.word === "cd" && tokens[1] && !tokens[1].operator && tokens[1].word &&
		!tokens[1].word.startsWith("-") && tokens[2]?.operator && tokens[2].word === "&&") {
		directory = tokens[1].word; tokens.splice(0, 3);
	}
	const stages: string[][] = [[]];
	for (const token of tokens) {
		if (token.operator) {
			if (token.word !== "|" || !stages.at(-1)!.length) return;
			stages.push([]);
		} else stages.at(-1)!.push(token.word);
	}
	if (!stages.at(-1)!.length) return;
	return { directory, stages };
}

const isSearch = ({ stages }: Pipeline) => ["grep", "rg"].includes(stages[0]![0]!) &&
	stages.slice(1).every(stage => searchTail.has(stage[0]!));

export const parseSearchCommand = (command: string, windows = false): Pipeline | undefined => {
	const parsed = pipeline(command, windows);
	return parsed && isSearch(parsed) ? parsed : undefined;
};

// Options whose next word is a value, rather than a path operand. Pattern-file options name files too.
const searchValues = new Set(["regexp", "file", "after-context", "before-context", "context", "max-count", "color", "colour",
	"binary-files", "devices", "directories", "exclude", "exclude-dir", "include", "label", "glob", "iglob", "type", "type-not",
	"type-add", "type-clear", "encoding", "engine", "max-columns", "max-depth", "max-filesize", "path-separator",
	"pre", "pre-glob", "replace", "sort", "sortr", "threads", "ignore-file", "hostname-bin", "hyperlink-format", "field-match-separator", "field-context-separator"]);
const shortValues: Record<string, string> = { grep: "efABCmDd", rg: "efgtrjABCmME",
	head: "nc", tail: "ncs", sort: "ktoST", uniq: "fsw", cut: "bcfd" };
const otherValues = new Set(["lines", "bytes", "sleep-interval", "key", "field-separator", "output", "buffer-size", "temporary-directory",
	"skip-fields", "skip-chars", "check-chars", "characters", "fields", "delimiter"]);

function pathOperands(stage: string[]): string[] {
	const [name, ...args] = stage, search = name === "grep" || name === "rg";
	const paths: string[] = [], positional: string[] = [];
	let literal = false, explicitPattern = false, filesOnly = false;
	for (let at = 0; at < args.length; at++) {
		const arg = args[at]!;
		if (!literal && arg === "--") { literal = true; continue; }
		if (!literal && arg.startsWith("--")) {
			const [option, ...value] = arg.slice(2).split("=");
			if (search && (option === "regexp" || option === "file")) explicitPattern = true;
			if (name === "rg" && option === "files") filesOnly = true;
			if ((search ? searchValues : otherValues).has(option!)) {
				const optional = name === "grep" && (option === "color" || option === "colour");
				const operand = value.length ? value.join("=") : optional ? undefined : args[++at];
				if (option === "file" && operand) paths.push(operand);
			}
			continue;
		}
		if (!literal && arg.startsWith("-") && arg !== "-") {
			for (let i = 1; i < arg.length; i++) if (shortValues[name!]?.includes(arg[i]!)) {
				const option = arg[i]!, value = arg.slice(i + 1) || args[++at];
				if (search && (option === "e" || option === "f")) explicitPattern = true;
				if (search && option === "f" && value) paths.push(value);
				break;
			}
			continue;
		}
		positional.push(arg);
	}
	if (search && !explicitPattern && !filesOnly) positional.shift();
	return [...paths, ...positional].filter(path => path && path !== "-");
}

export function searchPathsMatch(a: string, b: string): boolean {
	const left = pathKey(a).replace(/^\/+|\/+$/gu, ""), right = pathKey(b).replace(/^\/+|\/+$/gu, "");
	return !!left && !!right && (left === right || left.endsWith("/" + right) || right.endsWith("/" + left));
}

/** Whole search results from this prefix only. Calls, rather than result arrival, order invalidations. */
export function keptSearchCandidates(entries: readonly (SessionEntry | SessionHeader)[], indices: ReadonlyMap<string, number>,
	resolvable: (entry: SessionEntry) => boolean): TranscriptRecord[] {
	const cwd = entries.find((entry): entry is SessionHeader => entry.type === "session")?.cwd;
	const results = new Map(entries.flatMap(entry => entry.type === "message" && entry.message.role === "toolResult" ? [[entry.message.toolCallId, entry.message] as const] : []));
	const searches = new Map<string, { command: string; parsed: Pipeline; order: number }>();
	const mutations: { path: string; order: number }[] = [];
	let order = 0, lastUnsafeBash = -1;
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "bashExecution") {
			order++;
			if (!classifyBash(entry.message.command, cwd).readOnly) lastUnsafeBash = order;
			continue;
		}
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		for (const block of entry.message.content) {
			if (block.type !== "toolCall") continue;
			order++;
			const args = block.arguments && typeof block.arguments === "object" ? block.arguments as Record<string, unknown> : {};
			if (block.name === "bash") {
				const command = args.command;
				const classified = typeof command === "string" ? classifyBash(command, cwd) : undefined;
				if (!classified?.readOnly) lastUnsafeBash = order;
				const parsed = typeof command === "string" ? parseSearchCommand(command, classified!.windows) : undefined;
				if (parsed) searches.set(block.id, { command: command as string, parsed, order });
			} else if (["write", "edit"].includes(block.name) && !results.get(block.id)?.isError) {
				const path = extractPath(args);
				if (path) mutations.push({ path: pathKey(path), order });
			}
		}
	}
	const seen = new Set<string>(), records: TranscriptRecord[] = [];
	for (let at = entries.length - 1; at >= 0; at--) {
		const entry = entries[at]!;
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		const search = searches.get(entry.message.toolCallId);
		if (!search) continue;
		const key = search.command.replace(/\s+/gu, " ").trim();
		if (seen.has(key)) continue;
		seen.add(key);
		const sourceIndex = indices.get(entry.id);
		if (search.order < lastUnsafeBash || entry.message.isError || !isTextOnly(entry.message.content) || sourceIndex === undefined || !resolvable(entry)) continue;
		const text = textOf(entry.message.content);
		if (!text.length || text.length > 2000) continue;
		const paths = [...search.parsed.stages.flatMap(pathOperands), ...text.split("\n").flatMap(line => {
			const prefix = /^((?:[a-z]:[\\/])?[^:\r\n]+):/iu.exec(line)?.[1];
			return prefix ? [prefix] : [];
		})].map(path => pathKey(path, search.parsed.directory ? pathKey(search.parsed.directory, cwd) : undefined));
		if (mutations.some(mutation => mutation.order > search.order && paths.some(path => searchPathsMatch(path, mutation.path)))) continue;
		records.push({ kind: "section", title: "Kept-search", sourceIndex,
			text: `bash ${search.command} (as recorded at #${sourceIndex}; no file it lists was written or edited since):\n${text}` });
	}
	return records;
}
