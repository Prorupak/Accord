---
name: accord-platform-verification
description: Use when planning or running Accord Phase 05 tests, migration checks, Docker smoke tests, release readiness, security review, or regression triage. Preserve existing web/api/e2e/docker CI job names and never run paid AI requests without approval.
---

# Accord Phase 05 verification

## Required reading

- `docs/phase-05/verification-matrix.md`, `docs/phase-05/deployment-operations.md` and `docs/phase-05/README.md`.
- `.github/workflows/ci.yml`, `web/playwright.config.ts`, `compose.yaml`, `scripts/docker-smoke.sh` and current test folders.

## Procedure

1. Confirm exact revision and active branch; note uncommitted files.
2. Compare implemented behavior against each relevant P05-T test; do not mark planned tests as passed.
3. Run the smallest affected test suites, then the existing full web/api/e2e/docker gates. Do not alter baseline tests to silence regressions.
4. Migration smoke: fresh disposable PostgreSQL → deploy migrations → insert record → restart Compose → record persists. Test backup restore separately.
5. Router smoke: ensure `/api/auth/*` / `/api/projects/*` reach Next and `/api/map` / `/api/suggest` reach FastAPI; check deployed preview for Vercel.
6. Security smoke: two users, BOLA, revoked sessions, cross-origin mutation, oversized or forged audits and conflicting saves.
7. Report executed commands and outcomes, including limitations and skips. CI must never use real OpenRouter keys or include sensitive CSV/audit traces.

## Release blocks

- Any accepted match can bypass `applyDecision` / `checkPair`.
- Guest workflow requires auth or Postgres unexpectedly.
- One user can read or change another user's project.
- Concurrent saves overwrite silently or idempotent retries duplicate snapshots.
- Vercel routes auth/product APIs to FastAPI or proxy leaks secrets.
- Migrations require destructive reset, DB data lost on normal Compose restart or app starts before migration.
- Claim of public signup readiness without email verification and recovery.

## Output

Short checklist with `PASS`, `FAIL`, `NOT RUN` and evidence. No invented coverage percentages, latency numbers or provider-success claims.
