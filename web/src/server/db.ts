import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

let client: PrismaClient | undefined;

// Lazy so guest pages, `next build` and tests never need a database. No default DSN: a missing
// DATABASE_URL fails the first real query instead of connecting somewhere unintended.
export function getDb(): PrismaClient {
  if (client) return client;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set; account features need PostgreSQL");
  client = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  return client;
}
