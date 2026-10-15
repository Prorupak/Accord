import { defineConfig, devices } from "@playwright/test";

// Browser tests run against a production build. Every /api/* call is answered or aborted by
// page.route inside the tests, so no API server or AI provider is needed or contacted.
export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: true,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:3100", acceptDownloads: true },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: { command: "pnpm build && pnpm start -p 3100 -H 127.0.0.1", url: "http://127.0.0.1:3100", reuseExistingServer: false, timeout: 180_000 },
});
