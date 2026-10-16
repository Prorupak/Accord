// The deployment-mode switch in next.config.ts: static export must drop rewrites and PPR, and
// conflicting or unknown targets must fail the build instead of picking one silently.
import { afterEach, expect, it, vi } from "vitest";

async function load(env: Record<string, string>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return (await import("./next.config")).default;
}
afterEach(() => vi.unstubAllEnvs());

it("default keeps the /api rewrite and server output", async () => {
  const c = await load({ ACCORD_DEPLOY_TARGET: "", NEXT_OUTPUT_STANDALONE: "", ACCORD_API_BASE: "" });
  expect(c.output).toBeUndefined();
  expect(c.cacheComponents).toBe(true);
  expect(await c.rewrites!()).toEqual([{ source: "/api/:path*", destination: "http://127.0.0.1:8000/api/:path*" }]);
  expect(c.env).toEqual({ ACCORD_DEPLOY_TARGET: "", ACCORD_API_BASE: "" });
});

it("Docker keeps standalone output and the rewrite", async () => {
  const c = await load({ ACCORD_DEPLOY_TARGET: "", NEXT_OUTPUT_STANDALONE: "1" });
  expect(c.output).toBe("standalone");
  expect(c.rewrites).toBeTypeOf("function");
});

it("cloudflare-static exports with no rewrites and no PPR, and tells the client", async () => {
  const c = await load({ ACCORD_DEPLOY_TARGET: "cloudflare-static", NEXT_OUTPUT_STANDALONE: "", ACCORD_API_BASE: "" });
  expect(c.output).toBe("export");
  expect(c.rewrites).toBeUndefined();
  expect(c.cacheComponents).toBe(false);
  expect(c.partialPrefetching).toBe(false);
  expect(c.env).toEqual({ ACCORD_DEPLOY_TARGET: "cloudflare-static", ACCORD_API_BASE: "" });
});

it("rejects an unknown target and a static+standalone conflict", async () => {
  await expect(load({ ACCORD_DEPLOY_TARGET: "cloudflare", NEXT_OUTPUT_STANDALONE: "" })).rejects.toThrow(/must be unset/);
  await expect(load({ ACCORD_DEPLOY_TARGET: "cloudflare-static", NEXT_OUTPUT_STANDALONE: "1" })).rejects.toThrow(/conflict/);
});

it("inlines a gateway origin only into a static build, and only an https origin", async () => {
  const gateway = "https://accord-gateway-staging.example.workers.dev";
  const c = await load({ ACCORD_DEPLOY_TARGET: "cloudflare-static", NEXT_OUTPUT_STANDALONE: "", ACCORD_API_BASE: gateway });
  expect(c.env).toEqual({ ACCORD_DEPLOY_TARGET: "cloudflare-static", ACCORD_API_BASE: gateway });
  for (const bad of ["http://gateway.test", "https://gateway.test/", "https://gateway.test/api"])
    await expect(load({ ACCORD_DEPLOY_TARGET: "cloudflare-static", NEXT_OUTPUT_STANDALONE: "", ACCORD_API_BASE: bad })).rejects.toThrow(/ACCORD_API_BASE/);
  await expect(load({ ACCORD_DEPLOY_TARGET: "", NEXT_OUTPUT_STANDALONE: "", ACCORD_API_BASE: gateway })).rejects.toThrow(/ACCORD_API_BASE/);
});
