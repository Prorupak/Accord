import { execFileSync } from "node:child_process";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readAuthConfig } from "../../src/server/auth";
import { scratchDatabase } from "./scratch";

// Phase 05-I/C1 security matrix (docs/phase-05/verification-matrix.md) against real PostgreSQL,
// through the real Next route module and Better Auth handler. Synthetic identities only.
const { url, prisma } = scratchDatabase();
const SECRET = randomBytes(32).toString("hex");
const BASE = "http://localhost:3000";
const SESSION_COOKIE = "better-auth.session_token";

type Route = typeof import("../../app/api/auth/[...all]/route") & Pick<typeof import("../../src/server/auth"), "getCurrentSession">;
type Env = { BETTER_AUTH_SECRET?: string; BETTER_AUTH_URL?: string; ACCORD_SIGNUP_ENABLED?: string; DATABASE_URL?: string };

// Each call gets fresh module state and builds its auth instance now, while `env` is in place.
async function loadRoute(env: Env = {}): Promise<Route> {
  vi.resetModules();
  const defaults: Env = { BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE, ACCORD_SIGNUP_ENABLED: undefined, DATABASE_URL: url };
  for (const [key, value] of Object.entries({ ...defaults, ...env })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const handlers = await import("../../app/api/auth/[...all]/route");
  const auth = await import("../../src/server/auth");
  auth.getAuth();
  return { ...handlers, getCurrentSession: auth.getCurrentSession };
}

const seen: { status: number; text: string }[] = []; // every response, checked for leaks at the end
const randomIp = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(256)}`;
const email = () => `user-${randomUUID()}@example.test`;
const password = () => randomBytes(18).toString("base64url");

// Minimal cookie-aware client. `x-forwarded-for` gives each client its own rate-limit bucket.
function client(route: Route, { base = BASE, ip = randomIp() } = {}) {
  const jar = new Map<string, string>();
  async function call(method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}) {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const request = new Request(`${base}/api/auth${path}`, {
      method,
      headers: {
        origin: base,
        "x-forwarded-for": ip,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const res = await route[method](request);
    for (const set of res.headers.getSetCookie()) {
      const [pair] = set.split(";");
      const [name, value] = [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)];
      if (!value || /max-age=0/i.test(set)) jar.delete(name);
      else jar.set(name, value);
    }
    const text = await res.clone().text();
    seen.push({ status: res.status, text });
    return { res, text, json: () => (text ? JSON.parse(text) : null) };
  }
  return {
    jar,
    call,
    signIn: (e: string, p: string) => call("POST", "/sign-in/email", { email: e, password: p }),
    session: async () => (await call("GET", "/get-session")).json(),
    signOut: () => call("POST", "/sign-out", {}),
  };
}

let route: Route; // default policy: signup disabled
let operator: Route; // signup enabled, used only to seed synthetic accounts
const db = new pg.Pool({ connectionString: url, max: 2 });
const passwords: string[] = [];

async function account() {
  const credentials = { email: email(), password: password() };
  passwords.push(credentials.password);
  const { res } = await client(operator).call("POST", "/sign-up/email", { ...credentials, name: "Synthetic" });
  expect(res.status).toBe(200);
  return credentials;
}

async function signedIn() {
  const credentials = await account();
  const c = client(route);
  expect((await c.signIn(credentials.email, credentials.password)).res.status).toBe(200);
  return { ...credentials, c };
}

beforeAll(async () => {
  expect(prisma("migrate", "deploy")).toMatch(/successfully applied/);
  operator = await loadRoute({ ACCORD_SIGNUP_ENABLED: "true" });
  route = await loadRoute();
});

afterAll(async () => {
  await db.end();
});

describe("configuration (C1-02)", () => {
  const valid = { DATABASE_URL: url, BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: BASE };

  it("accepts a complete configuration with signup off by default", () => {
    expect(readAuthConfig(valid)).toEqual({ secret: SECRET, baseURL: BASE, signupEnabled: false });
    expect(readAuthConfig({ ...valid, ACCORD_SIGNUP_ENABLED: "true" })?.signupEnabled).toBe(true);
    expect(readAuthConfig({ ...valid, ACCORD_SIGNUP_ENABLED: "false" })?.signupEnabled).toBe(false);
  });

  it.each([
    ["no secret", { BETTER_AUTH_SECRET: undefined }],
    ["a short secret", { BETTER_AUTH_SECRET: "x".repeat(31) }],
    ["no database", { DATABASE_URL: undefined }],
    ["no canonical URL", { BETTER_AUTH_URL: undefined }],
    ["a URL with a path", { BETTER_AUTH_URL: `${BASE}/app` }],
    ["a non-http URL", { BETTER_AUTH_URL: "ftp://localhost" }],
    ["an invalid signup flag", { ACCORD_SIGNUP_ENABLED: "yes" }],
  ])("refuses %s", (_, change) => {
    expect(readAuthConfig({ ...valid, ...change })).toBeNull();
  });

  it("answers 503 NOT_CONFIGURED without a secret, never a fallback secret", async () => {
    const unconfigured = await loadRoute({ BETTER_AUTH_SECRET: undefined });
    const { res, json } = await client(unconfigured).call("GET", "/get-session");
    expect(res.status).toBe(503);
    expect(json()).toEqual({ error: { code: "NOT_CONFIGURED", message: expect.any(String) } });
  });
});

describe("registration", () => {
  it("rejects direct signup when disabled by default (C1-03)", async () => {
    const address = email();
    const { res, json } = await client(route).call("POST", "/sign-up/email", { email: address, password: password(), name: "x" });
    expect(res.status).toBe(400);
    expect(json().code).toBe("EMAIL_PASSWORD_SIGN_UP_DISABLED");
    expect((await db.query('SELECT 1 FROM "user" WHERE email = $1', [address])).rowCount).toBe(0);
  });

  it("creates an account only when explicitly enabled (C1-04)", async () => {
    const { email: address } = await account();
    expect((await db.query('SELECT 1 FROM "user" WHERE email = $1', [address])).rowCount).toBe(1);
  });

  it("bootstraps an account from the operator script without public signup (C1-05)", async () => {
    const address = email();
    const secret = password();
    passwords.push(secret);
    const out = execFileSync("node", ["scripts/create-account.mjs", "--email", address], {
      input: `${secret}\n`,
      env: { ...process.env, DATABASE_URL: url },
      encoding: "utf8",
    });
    expect(out.trim()).toBe(`created ${address}`);
    const stored = await db.query('SELECT a.password FROM account a JOIN "user" u ON u.id = a."userId" WHERE u.email = $1', [address]);
    expect(stored.rows[0].password).not.toContain(secret); // hashed by Better Auth
    expect((await db.query('SELECT 1 FROM session s JOIN "user" u ON u.id = s."userId" WHERE u.email = $1', [address])).rowCount).toBe(0);
    expect((await client(route).signIn(address, secret)).res.status).toBe(200);
    // Refuses a second run for the same address and never reads the password from argv.
    expect(() => execFileSync("node", ["scripts/create-account.mjs", "--email", address], { input: `${secret}\n`, env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" })).toThrow();
  });
});

describe("sign-in and sessions", () => {
  it("creates a database session and a session cookie (C1-06, C1-09)", async () => {
    const { email: address, c } = await signedIn();
    const token = c.jar.get(SESSION_COOKIE)!;
    expect(token).toBeTruthy();
    const raw = decodeURIComponent(token).split(".")[0]; // cookie = token.signature
    const rows = await db.query('SELECT 1 FROM session s JOIN "user" u ON u.id = s."userId" WHERE u.email = $1 AND s.token = $2', [address, raw]);
    expect(rows.rowCount).toBe(1);
    expect((await c.session()).user.email).toBe(address);
  });

  it("issues HttpOnly, SameSite=Lax, host-only cookies on http without Secure", async () => {
    const credentials = await account();
    const { res } = await client(route).signIn(credentials.email, credentials.password);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).not.toMatch(/Domain=/i);
    expect(cookie).not.toMatch(/Secure/i);
  });

  it("issues __Secure- prefixed Secure cookies when the canonical URL is https", async () => {
    const https = "https://accord.example.test";
    const secureRoute = await loadRoute({ BETTER_AUTH_URL: https });
    const credentials = await account();
    const c = client(secureRoute, { base: https });
    const { res } = await c.signIn(credentials.email, credentials.password);
    expect(res.status).toBe(200);
    const cookie = res.headers.getSetCookie().find((s) => s.startsWith(`__Secure-${SESSION_COOKIE}=`))!;
    expect(cookie).toMatch(/; Secure/i);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).not.toMatch(/Domain=/i);
    expect((await c.session()).user.email).toBe(credentials.email);
  });

  it("denies a wrong password and an unknown email with the same response (C1-07, C1-08)", async () => {
    const credentials = await account();
    const wrong = await client(route).signIn(credentials.email, password());
    const unknown = await client(route).signIn(email(), password());
    expect(wrong.res.status).toBe(401);
    expect(unknown.res.status).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
    expect(wrong.json().code).toBe("INVALID_EMAIL_OR_PASSWORD");
    expect(wrong.res.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`) && !/max-age=0/i.test(c))).toBe(false);
  });

  it("treats a missing cookie as unauthenticated (C1-10)", async () => {
    const { res, text } = await client(route).call("GET", "/get-session");
    expect([res.status, text, res.headers.get("cache-control")]).toEqual([200, "null", "private, no-store"]);
  });

  it("treats a tampered cookie as unauthenticated (C1-11)", async () => {
    const { c } = await signedIn();
    const [token, signature] = decodeURIComponent(c.jar.get(SESSION_COOKIE)!).split(".");
    const forged = signature.startsWith("A") ? `B${signature.slice(1)}` : `A${signature.slice(1)}`;
    c.jar.set(SESSION_COOKIE, encodeURIComponent(`${token}.${forged}`));
    expect(await c.session()).toBeNull();
    c.jar.set(SESSION_COOKIE, "not-a-session");
    expect(await c.session()).toBeNull();
  });

  it("revokes the session on sign-out; the old cookie no longer works (C1-12, C1-13)", async () => {
    const { c } = await signedIn();
    const old = c.jar.get(SESSION_COOKIE)!;
    const out = await c.signOut();
    expect([out.res.status, out.json()]).toEqual([200, { success: true }]);
    const raw = decodeURIComponent(old).split(".")[0];
    expect((await db.query("SELECT 1 FROM session WHERE token = $1", [raw])).rowCount).toBe(0);
    c.jar.set(SESSION_COOKIE, old); // replay
    expect(await c.session()).toBeNull();
  });

  it("denies an expired session (C1-14)", async () => {
    const { email: address, c } = await signedIn();
    await db.query(`UPDATE session SET "expiresAt" = now() - interval '1 second' FROM "user" u WHERE u.id = session."userId" AND u.email = $1`, [address]);
    expect(await c.session()).toBeNull();
  });

  it("keeps two users' sessions apart (C1-18)", async () => {
    const a = await signedIn();
    const b = await signedIn();
    const [sa, sb] = [await a.c.session(), await b.c.session()];
    expect([sa.user.email, sb.user.email]).toEqual([a.email, b.email]);
    expect(sa.session.id).not.toBe(sb.session.id);
    await a.c.signOut();
    expect(await a.c.session()).toBeNull();
    expect((await b.c.session()).user.email).toBe(b.email);
  });

  it("exposes the verified session through getCurrentSession", async () => {
    const { email: address, c } = await signedIn();
    const cookie = `${SESSION_COOKIE}=${c.jar.get(SESSION_COOKIE)}`;
    const current = await route.getCurrentSession(new Headers({ cookie }));
    expect(current.status === "authenticated" && current.user.email).toBe(address);
    expect(await route.getCurrentSession(new Headers())).toEqual({ status: "unauthenticated" });
  });
});

describe("origins and CSRF", () => {
  it("rejects sign-in from a foreign Origin (C1-15)", async () => {
    const credentials = await account();
    const { res, json } = await client(route).call("POST", "/sign-in/email", credentials, { origin: "https://evil.example.test" });
    expect(res.status).toBe(403);
    expect(json().code).toBe("INVALID_ORIGIN");
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("rejects a cookie-bearing sign-out from a foreign Origin and keeps the session", async () => {
    const { c } = await signedIn();
    const { res } = await c.call("POST", "/sign-out", {}, { origin: "https://evil.example.test" });
    expect(res.status).toBe(403);
    expect(await c.session()).not.toBeNull();
  });

  it("rejects an origin that is not the canonical one, such as 127.0.0.1 for localhost (C1-16)", async () => {
    const credentials = await account();
    const { res } = await client(route).call("POST", "/sign-in/email", credentials, { origin: "http://127.0.0.1:3000" });
    expect(res.status).toBe(403);
  });
});

describe("rate limiting (C1-17)", () => {
  it("limits repeated sign-in attempts per client, stored in PostgreSQL", async () => {
    const credentials = await account();
    const attacker = client(route);
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await attacker.signIn(credentials.email, password())).res.status);
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
    const limited = await attacker.signIn(credentials.email, credentials.password);
    expect(limited.res.status).toBe(429); // even the right password, until the window passes
    expect(Number(limited.res.headers.get("x-retry-after"))).toBeGreaterThan(0);
    expect(limited.text).not.toContain(credentials.password);
    expect((await client(route).signIn(credentials.email, credentials.password)).res.status).toBe(200); // other client
    expect((await db.query(`SELECT 1 FROM "rateLimit" WHERE key LIKE '%|/sign-in/email'`)).rowCount).toBeGreaterThan(0);
  });
});

describe("failure handling", () => {
  it("fails safely when PostgreSQL is unreachable (C1-19)", async () => {
    const { c } = await signedIn(); // a correctly signed cookie, so the lookup must reach the database
    const cookie = `${SESSION_COOKIE}=${c.jar.get(SESSION_COOKIE)}`;
    const unreachable = "postgresql://synthetic:synthetic-password@127.0.0.1:1/accord_test";
    const down = await loadRoute({ DATABASE_URL: unreachable });
    const { res, text, json } = await client(down).signIn(email(), password());
    expect(res.status).toBe(503);
    expect(json().error.code).toBe("STORAGE_UNAVAILABLE");
    expect(text).not.toMatch(/synthetic-password|127\.0\.0\.1:1|postgres|ECONNREFUSED/i);
    expect(await down.getCurrentSession(new Headers({ cookie }))).toEqual({ status: "unavailable" });
  });

  it("never returns secrets, passwords, hashes or tokens in response bodies (C1-25)", async () => {
    const hashes = (await db.query("SELECT password FROM account WHERE password IS NOT NULL")).rows.map((r) => r.password);
    const tokens = (await db.query("SELECT token FROM session")).rows.map((r) => r.token);
    const all = seen.map((r) => r.text).join("\n");
    for (const value of [SECRET, ...passwords, ...hashes]) expect(all).not.toContain(value);
    // Successful sign-in and get-session bodies carry the session token by Better Auth's
    // contract (documented); no failed or rejected response may.
    const failures = seen.filter((r) => r.status !== 200).map((r) => r.text).join("\n");
    for (const token of tokens) expect(failures).not.toContain(token);
  });
});
