import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/index.ts",
      miniflare: {
        compatibilityDate: "2026-10-01",
        durableObjects: { QUOTA: { className: "Quota", useSQLite: true } },
        bindings: {
          ENVIRONMENT: "test",
          DAILY_UNITS: "1000000",
          ALLOWED_ORIGINS: "https://develop.accord-web-3so.pages.dev,https://accord-web-3so.pages.dev",
          PUBLIC_AI_ENABLED: "true",
        },
        // No API binding: tests pass their own stand-in for the private Python Worker in env.
      },
    }),
  ],
});
