import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
// Per-test timeout 120 s: vitest's 5 s default timed out a property test under load (Nautilus, load 17.6). A timeout is a hang guard,
// not a speed bound; wall time is bounded only in the local timing bench (`npm run timing`).
export default defineConfig({ test: { include: ["test/**/*.test.ts"], testTimeout: 120_000 }, cacheDir: fileURLToPath(new URL("./.cache/vite", import.meta.url)) });
