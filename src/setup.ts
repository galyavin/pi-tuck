// One-time setup of semantic recall's local runtime: download the pinned files (assets.ts), check each against its SHA-256, assemble
// them into the companion layout scripts/provision-eg2.py expects, and provision it. Everything lives under one folder, by default
// ~/.pi/agent/pi-tuck; deleting that folder removes all of it.
import { createHash, randomUUID } from "node:crypto";
import { constants, createWriteStream, existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, realpath, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { LLAMA, MODEL, PINS, PYTHON, REQUIREMENTS, RUNTIME_ID, TOKENIZER, WHEELS, runtimeConfigPath, type Download } from "./assets";

const run = promisify(execFile);
const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const scripts = fileURLToPath(new URL(import.meta.url.endsWith(".ts") ? "../scripts/" : "../../scripts/", import.meta.url));

const DOWNLOAD_BYTES = [PYTHON, MODEL, TOKENIZER, LLAMA, ...Object.values(WHEELS)].reduce((n, d) => n + d.size, 0);
/** Provisioning keeps 5 GiB free after it copies the companion; the downloads and the staged copy come on top. */
const NEEDED_BYTES = 5 * 1024 ** 3 + 3 * DOWNLOAD_BYTES;

/** Returns the runtime configuration's path, setting the runtime up first if it is missing. Safe to call from several Pi processes at
 * once: one sets up, the others wait for it. `notice` is called once, when a download actually starts. */
export async function ensureSemanticRuntime(root: string, notice: (message: string) => void = () => {}): Promise<string> {
	if (existsSync(runtimeConfigPath(root))) return runtimeConfigPath(root);
	await mkdir(join(root, "runtime"), { recursive: true });
	root = await realpath(root); // provisioning refuses paths through symlinks
	const runtime = join(root, "runtime", RUNTIME_ID), config = runtimeConfigPath(root);
	const release = await lock(runtime + ".lock");
	const staging = join(root, `staging-${process.pid}`), lockFile = staging + ".lock.json";
	try {
		if (existsSync(config)) return config; // set up by another process while this one waited
		// Remains of a setup killed before it could clean up; the lock means no other setup is using them.
		await rm(runtime, { recursive: true, force: true });
		for (const [folder, name] of [[root, /^staging-/], [join(root, "downloads"), /\.part$/], [join(root, "python"), /\.part$/]] as const)
			for (const entry of await readdir(folder).catch(() => [])) if (name.test(entry)) await rm(join(folder, entry), { recursive: true, force: true });
		const { bavail, bsize } = await statfs(root);
		if (bavail * bsize < NEEDED_BYTES) throw new Error(`semantic recall needs ${Math.ceil(NEEDED_BYTES / 1e9)} GB of free disk space`);
		notice(`pi-tuck: setting up semantic recall, a one-time download of about ${Math.round(DOWNLOAD_BYTES / 1e6)} MB. Word recall works meanwhile.`);
		const downloads = join(root, "downloads");
		const [python, llama, model, tokenizer, ...wheels] = await Promise.all([PYTHON, LLAMA, MODEL, TOKENIZER, ...Object.values(WHEELS)]
			.map(d => fetchVerified(d, downloads)));
		const interpreter = await installPython(root, python!);
		await rm(staging, { recursive: true, force: true });
		const files = await assemble(staging, { llama: llama!, model: model!, tokenizer: tokenizer!, wheels: Object.keys(WHEELS).map((name, i) => [name, wheels[i]!]) });
		const wheel = Object.keys(WHEELS).find(name => name.startsWith("tokenizers-"))!;
		await writeFile(lockFile, JSON.stringify({ format: 1, platform: "darwin-arm64", python: PYTHON.version, wheel: "wheels/" + wheel, files }));
		await provision(interpreter, ["-I", "-B", join(scripts, "provision-eg2.py"), runtime, "--assets", staging, "--lock", lockFile,
			"--python", interpreter, "--index-directory", join(root, "index")]);
		await rm(downloads, { recursive: true, force: true });
		return config;
	} finally {
		await rm(staging, { recursive: true, force: true });
		await rm(lockFile, { force: true });
		await release();
	}
}

/** Downloads once into a content-addressed cache; a file reaches its final name only after its size and SHA-256 match the pin. */
async function fetchVerified(download: Download, directory: string): Promise<string> {
	const path = join(directory, download.sha256);
	if (existsSync(path)) return path;
	await mkdir(directory, { recursive: true });
	const partial = `${path}.${randomUUID()}.part`; // a download abandoned by a failed sibling may still be writing its own
	const response = await fetch(download.url);
	if (!response.ok || !response.body) throw new Error(`download failed (HTTP ${response.status}): ${download.url}`);
	const hash = createHash("sha256");
	let size = 0;
	await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), async function* (chunks) {
		for await (const chunk of chunks) { hash.update(chunk); size += chunk.length; yield chunk; }
	}, createWriteStream(partial));
	if (size !== download.size || hash.digest("hex") !== download.sha256) {
		await rm(partial, { force: true });
		throw new Error(`download does not match its pinned SHA-256: ${download.url}`);
	}
	await rename(partial, path);
	return path;
}

/** The interpreter stays where it is unpacked: the runtime's virtual environment points at it. */
async function installPython(root: string, archive: string): Promise<string> {
	const directory = join(root, "python", PYTHON.name), interpreter = join(directory, "python", "bin", "python3");
	if (existsSync(interpreter)) return interpreter;
	const partial = `${directory}.${process.pid}.part`;
	await rm(partial, { recursive: true, force: true });
	await mkdir(partial, { recursive: true });
	await run("tar", ["-xzf", archive, "-C", partial]);
	await rm(directory, { recursive: true, force: true });
	await rename(partial, directory);
	return interpreter;
}

/** Lays out the companion and returns its manifest: every file's path and SHA-256. */
async function assemble(staging: string, inputs: { llama: string; model: string; tokenizer: string; wheels: [string, string][] }) {
	const files: Record<string, string> = {};
	const put = async (path: string, from: string, sha: string) => {
		await mkdir(join(staging, path, ".."), { recursive: true });
		await copyFile(from, join(staging, path), constants.COPYFILE_FICLONE);
		files[path] = sha;
	};
	const write = async (path: string, data: string | Uint8Array) => {
		await mkdir(join(staging, path, ".."), { recursive: true });
		await writeFile(join(staging, path), data);
		files[path] = sha256(data);
	};
	await put("model.gguf", inputs.model, MODEL.sha256);
	await put("models/embedding/tokenizer.json", inputs.tokenizer, TOKENIZER.sha256);
	for (const [name, path] of inputs.wheels) await put("wheels/" + name, path, WHEELS[name]!.sha256);
	const unpacked = staging + ".llama";
	await mkdir(unpacked, { recursive: true });
	try {
		await run("tar", ["-xzf", inputs.llama, "-C", unpacked]);
		const from = (name: string) => join(unpacked, LLAMA.folder, name);
		for (const [name, sha] of [...Object.entries(LLAMA.files), ["LICENSE", LLAMA.license]] as const) {
			const bytes = await readFile(from(name)); // follows the archive's symlinks, so the copy is a plain file
			if (sha256(bytes) !== sha) throw new Error(`llama.cpp archive member does not match its pinned SHA-256: ${name}`);
			await write(name === "LICENSE" ? "notices/llama.cpp/LICENSE" : "native/" + name, bytes);
		}
	} finally { await rm(unpacked, { recursive: true, force: true }); }
	const hashOf = (requirement: string) => {
		const name = requirement.split("==")[0]!.toLowerCase().replace(/[-_.]+/g, "_");
		return WHEELS[Object.keys(WHEELS).find(wheel => wheel.toLowerCase().startsWith(name + "-"))!]!.sha256;
	};
	await write("requirements.lock", REQUIREMENTS.map(r => `${r} --hash=sha256:${hashOf(r)}\n`).join(""));
	await write("pins.json", JSON.stringify(PINS));
	return files;
}

/** Runs provisioning so that it ends with Pi: an orphan would roll back its own folder under a later setup. Its error is the last
 * line it wrote, not the whole command and log. */
async function provision(interpreter: string, args: string[]) {
	const pending = run(interpreter, args, { maxBuffer: 16 * 1024 * 1024 }), stop = () => pending.child.kill("SIGTERM");
	process.once("exit", stop);
	try { await pending; }
	catch (error) {
		const lines = String((error as { stderr?: string }).stderr ?? "").trim().split("\n");
		throw new Error(`provisioning failed: ${lines.at(-1) || (error as Error).message}`);
	}
	finally { process.off("exit", stop); }
}

/** A directory lock: whoever creates it sets up. It is taken over when its holder has exited, or after six hours (a reused pid);
 * the takeover renames the lock away first, so of several waiters only one takes it. */
async function lock(path: string): Promise<() => Promise<void>> {
	for (;;) {
		try {
			await mkdir(path);
			await writeFile(join(path, "pid"), String(process.pid));
			return () => rm(path, { recursive: true, force: true });
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
		const holder = Number(await readFile(join(path, "pid"), "utf8").catch(() => ""));
		const age = Date.now() - (await stat(path).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs;
		// A lock with no pid yet is a holder between its two steps, unless it has been like that for a while.
		if (age > 6 * 3600_000 || (holder ? !alive(holder) : age > 30_000)) {
			const taken = `${path}.stale-${randomUUID()}`;
			if (await rename(path, taken).then(() => true, () => false)) await rm(taken, { recursive: true, force: true });
		} else await new Promise(done => setTimeout(done, 2000));
	}
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } };
