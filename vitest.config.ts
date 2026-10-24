import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["test/**/*.test.ts"] }, cacheDir: fileURLToPath(new URL("./.cache/vite", import.meta.url)) });
