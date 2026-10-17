import { expect, test } from "@playwright/test";

// P05-A-04..07 at runtime: paths outside the three inference routes are Next's (its HTML 404),
// never proxied to FastAPI (whose 404 is JSON {"detail":"Not Found"}). No API server runs here.
for (const path of [
  "/api/auth/session",
  "/api/auth/sign-in/email",
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
