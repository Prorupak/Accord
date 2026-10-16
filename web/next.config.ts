import type { NextConfig } from "next";

// Deployment-only switch. Unset keeps local `next dev`/`next start` and Docker exactly as before.
const target = process.env.ACCORD_DEPLOY_TARGET;
if (target !== undefined && target !== "" && target !== "cloudflare-static")
  throw new Error(`ACCORD_DEPLOY_TARGET must be unset or "cloudflare-static", got "${target}"`);
const staticExport = target === "cloudflare-static";
// Hosted AI: the public gateway origin (gateway/), inlined into the static build. Not a secret.
const apiBase = process.env.ACCORD_API_BASE ?? "";
if (apiBase !== "" && !(staticExport && /^https:\/\/[a-z0-9.-]+$/.test(apiBase)))
  throw new Error(`ACCORD_API_BASE must be an https origin and needs ACCORD_DEPLOY_TARGET=cloudflare-static, got "${apiBase}"`);
if (staticExport && process.env.NEXT_OUTPUT_STANDALONE === "1")
  throw new Error('ACCORD_DEPLOY_TARGET=cloudflare-static and NEXT_OUTPUT_STANDALONE=1 conflict; set only one');

const nextConfig: NextConfig = {
  /* config options here */
  experimental: {
    agentFeedback: true,
    // The dev proxy defaults to 30 s; the API's inference deadline is 45 s (spec §8.2).
    proxyTimeout: 60_000,
  },
  // Next's export step throws "PPR cannot be enabled in export mode" with this on; the app uses no cache APIs.
  cacheComponents: !staticExport,
  // Inlined into client code so a static build can never render AI actions that have no API behind them.
  env: { ACCORD_DEPLOY_TARGET: staticExport ? "cloudflare-static" : "", ACCORD_API_BASE: apiBase },
  // Only the Docker build (web/Dockerfile) sets NEXT_OUTPUT_STANDALONE; `next start` and local builds are unchanged.
  output: staticExport ? "export" : process.env.NEXT_OUTPUT_STANDALONE === "1" ? "standalone" : undefined,
  // Same-origin proxy to the FastAPI backend (api/); keeps the Python host out of UI code.
  // Static export cannot rewrite, so the key is omitted there instead of being silently ignored.
  ...(staticExport
    ? {}
    : {
        async rewrites() {
          const apiOrigin = process.env.ACCORD_API_ORIGIN ?? "http://127.0.0.1:8000";
          return [{ source: "/api/:path*", destination: `${apiOrigin}/api/:path*` }];
        },
      }),
  partialPrefetching: !staticExport, // requires cacheComponents
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
