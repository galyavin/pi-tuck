// The id of a build: a hash of the source it ships, so a receipt names the code that wrote it. `src/build-id.ts` is the only file it leaves out.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

export function sourceId(root) {
	const hash = createHash('sha256');
	const add = path => { hash.update(relative(root, path).split(sep).join('/')); hash.update(readFileSync(path)); };
	const walk = dir => {
		for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const path = resolve(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.name !== 'build-id.ts') add(path);
		}
	};
	walk(resolve(root, 'src'));
	add(resolve(root, 'index.ts'));
	return hash.digest('hex');
}
