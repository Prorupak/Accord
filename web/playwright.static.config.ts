import { defineConfig, devices } from "@playwright/test";

// The Cloudflare Pages artifact (Mode A): `out/` from build:cloudflare, served by a plain static
// file server with no Next.js runtime and no /api proxy, as Pages serves it.
export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.static.ts",
  // shortcut: python http.server resets connections past a 5-deep backlog under parallel workers; fine for 3 tests.
  workers: 1,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:3200", acceptDownloads: true },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm build:cloudflare && python3 -m http.server 3200 --bind 127.0.0.1 --directory out",
    url: "http://127.0.0.1:3200",
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
