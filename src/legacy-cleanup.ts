import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { lstat, mkdir, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { notify } from "./notify.js";

const pending = new Map<string, Promise<void>>();
const directories = ["runtime", "python", "index", "downloads"] as const;
const temporaryDirectory = /^(?:staging-\d+|\.pi-semantic-[A-Za-z0-9]{6})$/;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

async function realDirectory(path: string): Promise<boolean> {
    try { return (await lstat(path)).isDirectory(); } // lstat never admits a symlink.
    catch (error) { if (missing(error)) return false; throw error; }
}

/** Recognize the EG-2 pin fields written by the old setup/provisioner, without pinning a particular release's hashes. */
function ownPins(value: unknown): boolean {
    const record = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
    const strings = (v: Record<string, unknown>, keys: string[]) => keys.every(key => typeof v[key] === "string");
    if (!record(value)) return false;
    const { embedding, backend, runtime } = value;
    return record(embedding) && record(backend) && record(runtime)
        && embedding.model === "google/embeddinggemma-2" && backend.name === "llama.cpp"
        && strings(embedding, ["revision", "queryInstruction", "documentInstruction", "pooling", "dtype"])
        && embedding.dimensions === 768 && embedding.maxTokens === 8192 && embedding.textOnly === true
        && strings(backend, ["commit", "artifact", "computePrecision", "compute", "modelRepository", "modelRevision", "modelSHA256"])
        && typeof backend.gpuLayers === "number" && strings(runtime, ["tokenizers", "python"]);
}

async function ownRuntime(path: string): Promise<boolean> {
    for (const child of await readdir(path)) {
        // These names come only from this directory's inventory; never follow links to claim ownership.
        const directory = join(path, child), pins = join(directory, "pins.json");
        try {
            if (await realDirectory(directory) && (await lstat(pins)).isFile() && ownPins(JSON.parse(await readFile(pins, "utf8")))) return true;
        } catch (error) { if (!missing(error) && !(error instanceof SyntaxError)) throw error; }
    }
    return false;
}

/** lsof uses exit 1 with no output for no matching open files; every other failure is unsafe to delete. */
async function idle(path: string): Promise<boolean> {
    return new Promise((done, reject) => {
        execFile("lsof", ["-t", "+D", path], { timeout: 3000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 }, (error, stdout, stderr) => {
            if (stdout.trim()) { done(false); return; }
            if (error && !(error.code === 1 && !error.killed && !error.signal && !stderr.trim())) reject(error);
            else if (stderr.trim()) reject(new Error(stderr.trim()));
            else done(true);
        });
    });
}

/** One bounded, best-effort measurement of only the candidates, so retained files are not counted as freed. */
async function sizes(paths: string[]): Promise<Map<string, number>> {
    if (process.platform === "win32" || !paths.length) return new Map();
    const started = performance.now();
    return new Promise(done => {
        try {
            execFile("du", ["-sk", ...paths], { timeout: 1000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 }, (error, stdout) => {
                const measured = new Map<string, number>();
                if (!error && performance.now() - started <= 1000) for (const line of stdout.trimEnd().split("\n")) {
                    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
                    if (match && paths.includes(match[2]!)) measured.set(match[2]!, Number(match[1]));
                }
                done(measured);
            });
        } catch { done(new Map()); }
    });
}

function reportFailure(failure: unknown): void {
    try {
        const reason = String((failure as NodeJS.ErrnoException).code ?? failure).replace(/[\r\n]+/g, " ");
        process.stderr.write(`pi-tuck could not finish removing its old search files: ${reason}\n`);
    } catch { /* A closed stderr must not break a session either. */ }
}

/** Once per home, including partial attempts. A later recreation belongs to whoever created it. */
export function cleanupLegacyFiles(ctx: ExtensionContext): Promise<void> {
    let home: string;
    try { home = homedir(); }
    catch (error) { reportFailure(error); return Promise.resolve(); }
    // Deliberately independent of Pi's per-arm agent folder.
    const agent = join(home, ".pi", "agent"), root = join(agent, "pi-tuck"), marker = join(agent, "pi-tuck-semantic-removed");
    const held = pending.get(root);
    if (held) return held;
    const cleanup = (async () => {
        let failure: unknown, started = false, removedRoot = false, freed = 0, sized = process.platform !== "win32";
        const removed: string[] = [];
        try {
            // Check this before inspecting or sizing the old root, even if Pi's agent folder points elsewhere.
            try { await lstat(marker); return; }
            catch (error) { if (!missing(error)) throw error; }
            await readdir(home); // An unreadable/missing home means no attempt could start; retry on the next load.
            if (process.platform === "win32" || !await realDirectory(root)) { started = true; return; }
            const children = await readdir(root);
            started = true;
            const names = [...directories, ...children.filter(name => temporaryDirectory.exec(name)?.[0] === name)];
            const candidates: string[] = [];
            for (const name of names) {
                const path = join(root, name);
                try {
                    if (await realDirectory(path) && (name !== "runtime" || await ownRuntime(path)) && await idle(path)) candidates.push(path);
                } catch (error) { failure ??= error; }
            }
            const measured = await sizes(candidates);
            for (const path of candidates) {
                try {
                    if (!await realDirectory(root) || !await realDirectory(path)) continue;
                    await rm(path, { recursive: true, force: false });
                    removed.push(basename(path));
                    sized &&= measured.has(path);
                    freed += measured.get(path) ?? 0;
                } catch (error) { if (!missing(error)) failure ??= error; }
            }
            // rmdir, rather than recursive removal, preserves every foreign file or skipped directory/link.
            try { await rmdir(root); removedRoot = true; }
            catch (error) { if (!missing(error) && !["ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) failure ??= error; }
        } catch (error) { failure ??= error; }
        finally {
            if (started) try {
                await mkdir(agent, { recursive: true });
                await writeFile(marker, "", { flag: "wx" });
            } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") failure ??= error; }
            if (removed.length || removedRoot) notify(ctx, `pi-tuck removed its old semantic search files from ${root}${sized ? ` (about ${Math.round(freed / 1024)} MB freed)` : ""}.${removed.length ? ` Removed: ${removed.join(", ")}.` : ""}`, "info");
            if (failure) reportFailure(failure);
        }
    })();
    pending.set(root, cleanup);
    void cleanup.finally(() => { pending.delete(root); });
    return cleanup;
}
