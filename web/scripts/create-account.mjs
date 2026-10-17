// Operator-only account bootstrap: creates one email/password account through Better Auth's own
// sign-up (its password hashing and account rows) without enabling public signup or any HTTP route.
// Plain Node, so it runs in the `migrate` image with no build step:
//   node scripts/create-account.mjs --email owner@example.test [--name "Owner"]
// The password is read from a hidden prompt, or the first line of stdin when piped; never argv.
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { betterAuth } from "better-auth";
import pg from "pg";

const MIN_PASSWORD = 12;

function fail(message) {
  console.error(`create-account: ${message}`);
  process.exit(1);
}

async function readPassword() {
  if (!process.stdin.isTTY) {
    const lines = createInterface({ input: process.stdin });
    for await (const line of lines) return line;
    return "";
  }
  process.stderr.write("Password: ");
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  rl._writeToOutput = () => {}; // hide the typed characters
  const password = await new Promise((resolve) => rl.question("", resolve));
  rl.close();
  process.stderr.write("\n");
  return password;
}

let values;
try {
  ({ values } = parseArgs({ options: { email: { type: "string" }, name: { type: "string" } } }));
} catch {
  fail("usage: create-account.mjs --email <address> [--name <display name>]");
}
const email = values.email?.trim().toLowerCase();
if (!email || !/^[^\s@]+@[^\s@]+$/.test(email)) fail("--email <address> is required");
const connectionString = process.env.DATABASE_URL;
if (!connectionString) fail("DATABASE_URL is not set");

const password = await readPassword();
if (password.length < MIN_PASSWORD) fail(`password must be at least ${MIN_PASSWORD} characters`);

const pool = new pg.Pool({ connectionString, max: 1 });
try {
  const existing = await pool.query('SELECT 1 FROM "user" WHERE email = $1', [email]);
  if (existing.rowCount) fail("an account with that email already exists");
  // No cookies or tokens are issued (autoSignIn: false), so a throwaway secret is enough here.
  const auth = betterAuth({
    database: pool,
    secret: randomBytes(32).toString("hex"),
    emailAndPassword: { enabled: true, autoSignIn: false, minPasswordLength: MIN_PASSWORD },
    logger: { level: "error" },
    telemetry: { enabled: false },
  });
  await auth.api.signUpEmail({ body: { email, password, name: values.name?.trim() || email.split("@")[0] } });
  console.log(`created ${email}`);
} catch {
  fail("account creation failed (check the database is migrated and reachable)");
} finally {
  await pool.end();
}
