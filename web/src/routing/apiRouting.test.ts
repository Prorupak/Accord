import { readFileSync } from "node:fs";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

// P05-A-01..10: only the three inference routes may reach FastAPI, in both routing layers.
// Matching uses Next's own path-to-regexp matcher with the options Next applies to rewrites
// (server/lib/router-utils/filesystem.js). Vercel sources use the same syntax; a preview deploy
// is still the real proof for the outer router.
type Rule = { source: string; destination: unknown };

function firstMatch<R extends Rule>(rules: readonly R[], pathname: string): R | undefined {
  return rules.find((r) => getPathMatch(r.source, { strict: true, removeUnnamedParams: true })(pathname));
}

const INFERENCE = ["/api/map", "/api/suggest", "/api/capabilities"];
const NOT_INFERENCE = [
  "/api/auth",
  "/api/auth/session",
  "/api/auth/sign-in/email",
  "/api/projects",
  "/api/projects/123",
  "/api/projects/123/snapshots",
  "/api/unrecognized",
  "/api/map/extra",
  "/api/suggest/extra",
  "/api/capabilities/extra",
  "/api",
];

describe("Next rewrites", async () => {
  const rewrites = await nextConfig.rewrites!();
  if (!Array.isArray(rewrites)) throw new Error("expected rewrites() to return an array");
  const origin = process.env.ACCORD_API_ORIGIN ?? "http://127.0.0.1:8000";

  it.each(INFERENCE)("proxies %s to the same FastAPI path", (path) => {
    expect(firstMatch(rewrites, path)?.destination).toBe(`${origin}${path}`);
  });

  it.each(NOT_INFERENCE)("leaves %s to Next", (path) => {
    expect(firstMatch(rewrites, path)).toBeUndefined();
  });

  it("has no wildcard or parameter sources", () => {
    expect(rewrites.map((r) => r.source)).toEqual(INFERENCE);
  });
});

describe("Vercel Services rewrites", () => {
  const { rewrites } = JSON.parse(readFileSync(new URL("../../../vercel.json", import.meta.url), "utf8")) as {
    rewrites: { source: string; destination: { service: string } }[];
  };
  const serviceFor = (path: string) => firstMatch(rewrites, path)?.destination.service;

  it.each(INFERENCE)("routes %s to the api service", (path) => {
    expect(serviceFor(path)).toBe("api");
  });

  it.each([...NOT_INFERENCE, "/", "/review", "/health", "/docs", "/openapi.json"])(
    "routes %s to the web service",
    (path) => {
      expect(serviceFor(path)).toBe("web");
    },
  );

  it("ends with the web catch-all", () => {
    expect(rewrites.at(-1)).toEqual({ source: "/(.*)", destination: { service: "web" } });
  });
});
