// Pi extension for the live arms: read, write, edit and bash run inside the current task's SWE-bench container. Every arm loads it, so
// the arms differ only in their compactor. The harness writes the container's name to $TUCK_EVAL_CONTAINER_FILE before each task; inside
// the container the session's working folder is a symlink to /testbed, so host paths the agent sees resolve to the task repository.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";

const containerFile = process.env.TUCK_EVAL_CONTAINER_FILE;
const container = () => {
	if (!containerFile) throw new Error("TUCK_EVAL_CONTAINER_FILE is not set");
	const name = readFileSync(containerFile, "utf8").trim();
	if (!name) throw new Error("No task container is active");
	return name;
};
/** The longest any one command may run when the agent gives no timeout, in seconds. */
const DEFAULT_TIMEOUT = 600;

function docker(args: string[], input?: string): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = spawn("docker", ["exec", "-i", container(), ...args], { stdio: ["pipe", "pipe", "pipe"] });
		const out: Buffer[] = [], err: Buffer[] = [];
		child.stdout.on("data", d => out.push(d));
		child.stderr.on("data", d => err.push(d));
		child.on("error", reject);
		child.on("close", code => code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(Buffer.concat(err).toString().trim() || `exit ${code}`)));
		child.stdin.end(input ?? "");
	});
}

const readFile = (path: string) => docker(["cat", "--", path]);
const writeFile = async (path: string, content: string) => { await docker(["sh", "-c", 'cat > "$1"', "_", path], content); };
const access = async (path: string) => { await docker(["test", "-r", path]); };

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	pi.registerTool(createReadToolDefinition(cwd, { operations: { readFile, access, detectImageMimeType: async () => null } }));
	pi.registerTool(createWriteToolDefinition(cwd, { operations: { writeFile, mkdir: async dir => { await docker(["mkdir", "-p", dir]); } } }));
	pi.registerTool(createEditToolDefinition(cwd, { operations: { readFile, writeFile, access: async path => { await docker(["sh", "-c", 'test -r "$1" && test -w "$1"', "_", path]); } } }));
	pi.registerTool(createBashToolDefinition(cwd, { exposeSessionEnvironment: false, operations: {
		exec: (command, dir, { onData, signal, timeout }) => new Promise((resolve, reject) => {
			const limit = Math.max(1, Math.ceil(timeout ?? DEFAULT_TIMEOUT));
			const script = `source /opt/miniconda3/bin/activate testbed >/dev/null 2>&1; cd "$1" || exit 1; exec timeout -k 5 ${limit} bash -c "$2"`;
			const child = spawn("docker", ["exec", "-i", container(), "bash", "-c", script, "_", dir, command], { stdio: ["ignore", "pipe", "pipe"] });
			child.stdout.on("data", onData);
			child.stderr.on("data", onData);
			child.on("error", reject);
			const onAbort = () => child.kill();
			signal?.addEventListener("abort", onAbort, { once: true });
			child.on("close", code => {
				signal?.removeEventListener("abort", onAbort);
				if (signal?.aborted) reject(new Error("aborted"));
				else if (code === 124) reject(new Error(`timeout:${limit}`));
				else resolve({ exitCode: code });
			});
		}),
	} }));
}
