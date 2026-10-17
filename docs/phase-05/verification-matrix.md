# Phase 05 — Verification and release gate matrix

**Status: Proposed tests, not passing-test claims.** This matrix supplements `.github/workflows/ci.yml`, `docs/progress.md` and existing domain/E2E tests.

## Required untouched baseline

- `web`: TypeScript, ESLint, Vitest, production Next build.
- `api`: pytest, Ruff check/format.
- `e2e`: Playwright canonical browser import/map/review/export and edge cases with stubs for AI requests.
- `docker`: Compose config/build/up/smoke with no real AI provider requests.
- Keep workflow check names `web`, `api`, `e2e`, `docker` if branch rulesets depend on them. No test should spend OpenRouter quota.

## Proposed tests with stable IDs

| ID | Layer | Test | Expected |
|---|---|---|---|
| P05-T01 | route | Next local `/api/auth/*` | reaches Next Better Auth, never FastAPI. *05-I/C1: passing (Playwright and Docker smoke: 503 `NOT_CONFIGURED` from Next without auth env; `docker-db-check.sh`: real sign-in on the web image).* |
| P05-T02 | route | Next local `/api/map`, `/api/suggest` | reaches original FastAPI; unchanged schemas. *05-I/A: passing (Vitest, Docker smoke).* |
| P05-T03 | deploy | Vercel preview auth + inference routes | correct service in each case. *05-I/A: static test of `vercel.json` passing; preview pending.* |
| P05-T04 | DB | clean schema migrate then restart | migrations idempotent; persisted data intact. *05-I/B: passing (`tests/db/schema.dbtest.ts`: fresh + repeated deploy, no drift, constraints; `scripts/docker-db-check.sh`: restart persistence, re-migrate no-op).* |
| P05-T05 | auth | signup toggle off/on | disabled rejects server-side; enabled creates session. *05-I/C1: passing (C1-03/04).* |
| P05-T06 | auth | sign-out/expiry | revoked session cannot access protected resource. *05-I/C1: session part passing (C1-12/13/14); no protected product route exists yet.* |
| P05-T07 | workspace | simultaneous first access | exactly one workspace per user |
| P05-T08 | BOLA | A accesses B project via list/get/patch/delete | 404 or no visibility for every path |
| P05-T09 | BOLA | A saves or fetches B snapshot | 404, no DB mutation |
| P05-T10 | CSRF | mutation with foreign Origin | 403 without DB mutation. *05-I/C1: auth routes passing (C1-15/16); product routes not built.* |
| P05-T11 | contract | 4MiB+ payload or invalid audit | 413/400, no snapshot/version increment |
| P05-T12 | correctness | canonical audit save→restore→export | matching + unresolved + quantity invariant preserved |
| P05-T13 | correctness | AI decisions, abstentions, undo/exclusion | same decision journal and derived state after reopen |
| P05-T14 | correctness | corrupted/unsupported AuditV1 | safe failure; no partial state mutation |
| P05-T15 | concurrency | two concurrent versions N | one N+1 and one 409; no lost update |
| P05-T16 | idempotency | repeat same key/payload | one snapshot and same acknowledgement |
| P05-T17 | stale UI | state edited during save | UI says unsaved; no false latest-saved indicator |
| P05-T18 | privacy | guest flow without login | no project/upload request, no DB prerequisite. *05-I/B: no-DB part passing (Docker smoke with no `DATABASE_URL`, and with it set while PostgreSQL is down; build without `DATABASE_URL`).* |
| P05-T19 | confidentiality | project list and error responses | no audit JSON, source cell values, secrets or session tokens |
| P05-T20 | ops | Compose down/up, backup and restore | preserved accounts/projects/snapshots and replays. *05-I/B: synthetic rows survive down/up and `pg_dump`/`pg_restore`; replay after restore needs 05-I/D.* |
| P05-T21 | UX | mobile, keyboard, reduced motion, 200% zoom | usable focus, no page overflow/hidden actions |

## Phase 05-I/C1 authentication matrix

Results from the C1 branch; commands and counts in `docs/progress.md`. `dbtest` = `web/tests/db/auth.dbtest.ts` (real PostgreSQL, real route module and Better Auth handler).

| ID | Test | Evidence | Status |
|---|---|---|---|
| C1-01 | No `DATABASE_URL` → guest homepage | `pnpm e2e`, Docker smoke | Passing |
| C1-02 | No/short secret → no fallback | dbtest `configuration` (7 refusals, 503 `NOT_CONFIGURED`) | Passing |
| C1-03 | Signup disabled by default | dbtest, `docker-db-check.sh` | Passing |
| C1-04 | Signup explicitly enabled | dbtest | Passing |
| C1-05 | Operator bootstrap | dbtest (spawns script), `docker-db-check.sh` | Passing |
| C1-06 | Login creates DB session | dbtest, `docker-db-check.sh` | Passing |
| C1-07/08 | Wrong password / unknown email | dbtest (identical 401 bodies) | Passing |
| C1-09/10/11 | Valid / missing / tampered cookie | dbtest | Passing |
| C1-12/13 | Sign-out revokes; replay fails | dbtest, `docker-db-check.sh` | Passing |
| C1-14 | Expired session | dbtest (expiry seeded by SQL) | Passing |
| C1-15/16 | Foreign / non-canonical Origin | dbtest, `docker-db-check.sh` | Passing |
| C1-17 | Repeated sign-in limited | dbtest (5 then 429, row in `rateLimit`) | Passing per IP; spoofable without a trusted proxy |
| C1-18 | Two users isolated | dbtest | Passing |
| C1-19 | Database unreachable | dbtest (503 `STORAGE_UNAVAILABLE`, no DSN); guest Docker with DB down | Passing |
| C1-20/21 | Auth on Next; FastAPI routes unchanged | `pnpm e2e`, Docker smoke, pytest | Passing |
| C1-22 | No server auth code in browser bundles | CI `web` step grep of `.next/static` | Passing |
| C1-23 | Docker image with DB overlay | `docker-db-check.sh` | Passing |
| C1-24 | Default E2E without DB | `pnpm e2e` | Passing |
| C1-25 | No secrets in responses/logs | dbtest (all bodies), `docker-db-check.sh` (web logs) | Passing; sign-in/get-session bodies carry the session token by Better Auth's contract |

## PR checkpoints

| Milestone | Evidence needed | Stop if |
|---|---|---|
| A: route + versions | Dependency compatibility notes, route tests, clean prior suite | Better Auth routes intercepted by FastAPI |
| B: DB/Compose | Schema diff, reviewed SQL, migration CI, volume/health test | DB exposed publicly or unreviewed migration |
| C: auth/projects | Two-user ownership tests and session revocation | Any BOLA/IDOR access |
| D: save/restore | Replay validation, transaction race, idempotency, roundtrip | Direct acceptance of unvalidated pairs or lost update |
| E: release | CI four jobs, preview route checks, self-host restore, redacted logs | No proof of target runtime or backups |

## How to report results

For every milestone, include:

```
Implementation status: NOT STARTED | IN PROGRESS | VERIFIED
Baseline: v0.1.0 commit ...
Changed files: ...
Commands actually executed: ...
Evidence: test names and counts, migration result, screenshots/manual checks
Not verified: ...
Risks / scope differences: ...
```

A test document is a plan, not evidence. Do not claim `Prisma migrate deploy`, auth smoke, or hosted preview passed before commands ran and outputs were examined. Attach only synthetic non-sensitive fixtures to CI artifacts. Do not store cookies, passwords, real uploaded CSVs or audit payloads in traces.
