import "server-only";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { getDb } from "./db";

export type AuthConfig = { secret: string; baseURL: string; signupEnabled: boolean };

// Fails closed: any missing or malformed setting means "accounts not configured", never a default.
// Better Auth itself would fall back to a public placeholder secret outside production.
export function readAuthConfig(env: Record<string, string | undefined> = process.env): AuthConfig | null {
  const { DATABASE_URL, BETTER_AUTH_SECRET: secret, BETTER_AUTH_URL, ACCORD_SIGNUP_ENABLED: signup } = env;
  if (!DATABASE_URL || !secret || secret.length < 32 || !BETTER_AUTH_URL) return null;
  if (signup !== undefined && signup !== "true" && signup !== "false") return null;
  let url: URL;
  try {
    url = new URL(BETTER_AUTH_URL);
  } catch {
    return null;
  }
  // An origin only: Better Auth mounts under /api/auth on it, and it is the one trusted origin.
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.href !== `${url.origin}/`) return null;
  return { secret, baseURL: url.origin, signupEnabled: signup === "true" };
}

function createAuth({ secret, baseURL, signupEnabled }: AuthConfig) {
  return betterAuth({
    database: prismaAdapter(getDb(), { provider: "postgresql" }),
    secret,
    baseURL,
    trustedOrigins: [baseURL],
    // No email delivery exists, so self-service signup stays off unless an operator opts in.
    emailAndPassword: { enabled: true, disableSignUp: !signupEnabled },
    // Every session read hits PostgreSQL, so sign-out and expiry take effect immediately.
    session: { cookieCache: { enabled: false } },
    rateLimit: {
      enabled: true,
      storage: "database",
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": { window: 60, max: 3 },
      },
    },
    advanced: {
      useSecureCookies: baseURL.startsWith("https://"),
      // Better Auth skips Origin/CSRF checks when NODE_ENV=test unless this is set explicitly.
      disableOriginCheck: false,
    },
    // Better Auth logs email addresses at info level.
    logger: { level: "warn" },
    telemetry: { enabled: false },
  });
}

type Auth = ReturnType<typeof createAuth>;
let auth: Auth | undefined;

// Lazy: guest pages, `next build` and the homepage never read auth settings or touch PostgreSQL.
export function getAuth(): Auth | null {
  if (auth) return auth;
  const config = readAuthConfig();
  if (!config) return null;
  auth = createAuth(config);
  return auth;
}

type Verified = NonNullable<Awaited<ReturnType<Auth["api"]["getSession"]>>>;
export type CurrentSession =
  | ({ status: "authenticated" } & Verified)
  | { status: "unauthenticated" }
  | { status: "unavailable" };

// The only way later server routes learn who is calling; never a user ID from the request body.
export async function getCurrentSession(headers: Headers): Promise<CurrentSession> {
  const instance = getAuth();
  if (!instance) return { status: "unavailable" };
  try {
    const verified = await instance.api.getSession({ headers });
    return verified ? { status: "authenticated", ...verified } : { status: "unauthenticated" };
  } catch {
    return { status: "unavailable" };
  }
}
