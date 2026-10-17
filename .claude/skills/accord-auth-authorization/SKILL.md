---
name: accord-auth-authorization
description: Use for implementing or auditing Better Auth, Next.js sessions, signup, cookies, owner-scoped project APIs, tenant isolation, CSRF defenses, and authorization regression tests for Accord Phase 05-I. Check installed library docs and use real database-backed two-user tests.
---

# Accord authentication and authorization

## Required reading

- `docs/phase-05/auth-authorization.md`, `docs/phase-05/http-contracts.md`, `docs/phase-05/data-model.md`.
- `docs/phase-05/decisions/0003-personal-workspaces.md`.
- `web/next.config.ts`, `vercel.json`, current installed Better Auth/Prisma 7 docs and generated schema.
- Root `CLAUDE.md`, `web/AGENTS.md` and `docs/phase-05/verification-matrix.md`.

## Rules

1. Verify auth/version compatibility before installing. Generate Better Auth Prisma models with its pinned CLI and inspect SQL migration. Never fabricate auth tables based on memory.
2. Implement signed session checks *server-side* on every private route. Client session hooks only control presentation.
3. Personal workspace has UNIQUE owner; do not introduce organization plugin or member roles yet.
4. No access check may trust `userId`/`workspaceId` from request body. Scope project reads and writes by verified session ownership; use 404 for another user's IDs.
5. Protect cookie-based mutations from cross-origin requests; preserve Better Auth default session/CSRF protections. No wildcard CORS.
6. Server-enforce signup toggle. No public signup promise while verification/password recovery are absent.
7. Keep session cookies out of localStorage, logs, URL parameters and client-exposed environment variables.
8. Guest `/` remains functional without a database and never saves imported source data automatically.
9. Do not add OAuth, password-reset email, SMTP or social login without explicit scope change.

## Required verification

Use isolated PostgreSQL test data and at least two users. Cover registration disabled, session creation/revocation, invalid cookie, A→B list/read/update/delete/snapshot, foreign Origin, missing DB, and no project-existence leak. Ensure next and Vercel routes actually dispatch auth to Next and AI endpoints to FastAPI.

## Completion format

Report source files changed, exact versions pinned, migrations, test results run, known operational limitations and unverified behavior. Do not call the implementation secure based only on mocked auth hooks.
