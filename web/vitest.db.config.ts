import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Integration tests against a real, disposable PostgreSQL (`pnpm test:db`). Kept out of `pnpm test`.
export default defineConfig({
  resolve: {
    // `server-only` throws outside a React Server build; the server modules under test are plain Node here.
    alias: { "server-only": fileURLToPath(new URL("tests/db/server-only.ts", import.meta.url)) },
  },
  test: {
    include: ["tests/db/**/*.dbtest.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
