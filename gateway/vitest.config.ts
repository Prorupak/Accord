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
          API_ORIGIN: "https://api.test",
          API_TOKEN: "test-token",
        },
      },
    }),
  ],
});
