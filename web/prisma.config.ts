import { defineConfig } from "prisma/config";

// process.env, not env(): `prisma generate` must work without a database (CI, Docker build).
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env.DATABASE_URL },
});
