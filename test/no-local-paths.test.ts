import { expect, test } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Twice a test hard-coded a builder's local scratch folder and failed on CI's runners. Paths a test writes come from os.tmpdir().
const local = /\/private\/tmp\/claude-|\/Users\/[a-z]+\//;
const files = (dir: string): string[] => readdirSync(dir).flatMap(name => {
	const path = join(dir, name);
	return statSync(path).isDirectory() ? (name === 'node_modules' || name === 'fixtures' ? [] : files(path)) : /\.(ts|mjs|js)$/.test(name) ? [path] : [];
});

test('no source or test file names a local machine path', () => {
	const offenders = [...files('src'), ...files('test'), 'index.ts'].filter(path => local.test(readFileSync(path, 'utf8')));
	expect(offenders).toEqual([]);
});
