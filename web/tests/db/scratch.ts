import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll } from "vitest";

// DATABASE_URL names a disposable server whose database ends in `_test`. Each test file gets a
// fresh, randomly named database on that server, dropped afterwards. Synthetic data only.
export function scratchDatabase() {
  const base = process.env.DATABASE_URL;
  if (!base || !new URL(base).pathname.endsWith("_test")) {
    throw new Error("pnpm test:db needs DATABASE_URL pointing at a disposable database whose name ends in _test");
  }
  const dbName = `accord_${randomUUID().replaceAll("-", "").slice(0, 12)}_test`;
  const url = Object.assign(new URL(base), { pathname: `/${dbName}` }).toString();
  const admin = async (sql: string) => {
    const c = new pg.Client({ connectionString: base });
    await c.connect();
    await c.query(sql);
    await c.end();
  };
  const prisma = (...args: string[]) =>
    execFileSync("node_modules/.bin/prisma", args, { env: { ...process.env, DATABASE_URL: url }, encoding: "utf8" });

  beforeAll(async () => {
    await admin(`CREATE DATABASE "${dbName}"`);
    process.env.DATABASE_URL = url;
  });
  afterAll(() => admin(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`));
  return { url, prisma };
}
