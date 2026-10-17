import type { NextConfig } from "next";

// The only FastAPI routes proxied through Next; every other /api/* path (auth, projects) is Next's.
const INFERENCE_PATHS = ["/api/map", "/api/suggest", "/api/capabilities"] as const;

const nextConfig: NextConfig = {
  /* config options here */
  experimental: {
    agentFeedback: true,
    // The dev proxy defaults to 30 s; the API's inference deadline is 45 s (spec §8.2).
    proxyTimeout: 60_000,
  },
  cacheComponents: true,
  // Only the Docker build (web/Dockerfile) sets this; `next start` and local builds are unchanged.
  output: process.env.NEXT_OUTPUT_STANDALONE === "1" ? "standalone" : undefined,
  // Same-origin proxy to the FastAPI backend (api/); keeps the Python host out of UI code.
  async rewrites() {
    const apiOrigin = process.env.ACCORD_API_ORIGIN ?? "http://127.0.0.1:8000";
    return INFERENCE_PATHS.map((path) => ({ source: path, destination: `${apiOrigin}${path}` }));
  },
  partialPrefetching: true,
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
