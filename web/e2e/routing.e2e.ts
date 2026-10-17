import { expect, test } from "@playwright/test";

// P05-A-04..07 at runtime: paths outside the three inference routes are Next's, never proxied to
// FastAPI (whose 404 is JSON {"detail":"Not Found"}). No API server or database runs here.
for (const path of [
  "/api/projects",
  "/api/projects/example/snapshots",
  "/api/random",
  "/api/map/unknown",
  "/api/suggest/unknown",
  "/api/capabilities/unknown",
]) {
  test(`${path} is handled by Next`, async ({ request }) => {
    const res = await request.get(path);
    expect(res.status()).toBe(404);
    expect(res.headers()["content-type"]).toContain("text/html");
    expect(await res.text()).not.toContain('"detail"');
  });
}

// C1-20/C1-24: /api/auth/* is the Better Auth route on Next. With no database or secret it answers
// with Accord's NOT_CONFIGURED envelope instead of a session, and never reaches FastAPI.
for (const [method, path] of [
  ["GET", "/api/auth/get-session"],
  ["POST", "/api/auth/sign-in/email"],
] as const) {
  test(`${method} ${path} is the unconfigured auth route on Next`, async ({ request }) => {
    const res = await request.fetch(path, { method, data: method === "POST" ? {} : undefined });
    expect(res.status()).toBe(503);
    expect(res.headers()["content-type"]).toContain("application/json");
    expect(res.headers()["cache-control"]).toContain("no-store");
    expect(await res.json()).toEqual({ error: { code: "NOT_CONFIGURED", message: expect.any(String) } });
  });
}
