import { test, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
// @ts-expect-error a plain script, used by the build
import { sourceId } from '../scripts/source-id.mjs';
import { BUILD_ID } from '../src/build-id';

test('the committed build id follows the source: run `npm run build` if this fails', () => {
	expect(BUILD_ID).toBe(sourceId(fileURLToPath(new URL('..', import.meta.url))));
});
