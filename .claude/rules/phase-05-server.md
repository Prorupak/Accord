---
paths:
  - "web/app/api/**/*"
  - "web/src/server/**/*"
  - "web/prisma/**/*"
  - "web/prisma.config.ts"
  - "web/next.config.ts"
  - "vercel.json"
  - "compose.yaml"
---

# Phase 05 — Server and deployment boundary rules

- Read `docs/phase-05/architecture.md`, `docs/phase-05/auth-authorization.md` and the relevant ADR before changing affected paths.
- Distinguish **existing v0.1** code from **planned v0.2** functionality. A documented target is not proof of implemented behavior.
- Prisma and Better Auth are server-only. All protected routes validate a session and scope queries to session-owned workspace. No client-supplied owner ID.
- Validate Origin, content type and request size on product mutations; no sensitive source records, audit JSON or keys in logs.
- Keep `/api/auth/*` and `/api/projects/*` in Next; only `/api/map`, `/api/suggest`, `/api/capabilities` in FastAPI. Always test Vercel outer rewrites as well as local Next rewrites.
- Review migration SQL and deploy to disposable DB first. No `prisma db push`/`migrate reset` in production.
- Database and auth secrets exist only at runtime; never use build args or `NEXT_PUBLIC_*`.
