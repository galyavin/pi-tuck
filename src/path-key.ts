import { posix } from "node:path";

/** Lexical identity for recorded paths, independent of the machine reading the session.
 * Only drive letters fold case; callers retain the original spelling for display. */
export function pathKey(path: string, cwd?: string): string {
	const slashes = (value: string) => value.replace(/\\/gu, "/").replace(/^[A-Z]:/u, drive => drive.toLowerCase());
	const name = slashes(path);
	return posix.normalize(cwd && !posix.isAbsolute(name) && !/^[a-z]:\//u.test(name) ? posix.join(slashes(cwd), name) : name);
}
