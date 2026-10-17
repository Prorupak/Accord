# Phase 05 — HTTP/API contract

**Status: Proposed.** Routes below don't exist in Accord v0.1.0. Existing FastAPI inference routes remain unchanged.

## Route routing plan

| Path | Runtime | State |
|---|---|---|
| `/` | Next page / browser reconciliation | Exists; guest-capable |
| `/api/map`, `/api/suggest`, `/api/capabilities` | FastAPI (same-origin proxy) | Exists; preserve contracts |
| `/api/auth/[...all]` | Next Node / Better Auth | Implemented (05-I/C1) |
| `/api/projects` | Next Node / Prisma | Planned |
| `/api/projects/[id]` | Next Node / Prisma | Planned |
| `/api/projects/[id]/snapshots` | Next Node / Prisma | Planned |
| `/sign-in`, `/sign-up`, `/workspace`, `/workspace/projects/[id]` | Next pages | Planned |

**Routing prerequisite (implemented in 05-I/A):** the Next rewrite and root `vercel.json` forward only the three exact FastAPI paths; every other `/api/*` path, including `/api/auth/*` and `/api/projects/*`, is handled by Next (`/api/auth/*` by Better Auth since 05-I/C1, the rest its 404). Still required before deploying auth: verify real preview requests; do not rely on `web` route-handler code alone.

## Authentication

Better Auth's own handler owns `/api/auth/[...all]`, response shapes, cookie names and error semantics. Do not wrap or reinvent its session protocol. Next product routes read a verified Better Auth session server-side; a `User` ID in JSON/body is never trusted.

Implemented in 05-I/C1 (Better Auth 1.7.10 contracts, verified by `web/tests/db/auth.dbtest.ts`):

| Method and path | Result |
|---|---|
| `POST /api/auth/sign-in/email` `{email,password}` | 200 `{redirect,token,user}` + `better-auth.session_token` cookie; 401 `INVALID_EMAIL_OR_PASSWORD` for a wrong password or unknown email alike |
| `GET /api/auth/get-session` | 200 `{session,user}`, or 200 `null` without a valid session |
| `POST /api/auth/sign-out` | 200 `{success:true}`; deletes the session row and clears the cookie |
| `POST /api/auth/sign-up/email` `{name,email,password}` | 400 `EMAIL_PASSWORD_SIGN_UP_DISABLED` unless `ACCORD_SIGNUP_ENABLED=true` |
| any, foreign `Origin` | 403 `INVALID_ORIGIN` on POST with a cookie or an `Origin` header |
| any, over the limit | 429 with `X-Retry-After` (sign-in 5, sign-up 3 per 60 s per client IP; others 100 per 10 s) |

Accord adds only two outcomes around the handler, in the error envelope below: 503
`NOT_CONFIGURED` when `DATABASE_URL`, `BETTER_AUTH_SECRET` (≥ 32 chars), `BETTER_AUTH_URL` (an
http(s) origin) or `ACCORD_SIGNUP_ENABLED` (absent, `true` or `false`) is missing or invalid, and
503 `STORAGE_UNAVAILABLE` for any thrown error or 5xx (database down), with no driver text. All
auth responses carry `Cache-Control: private, no-store`. Successful sign-in and get-session bodies
include the session token by Better Auth's contract; the cookie is HttpOnly, but script on the
page could still read the token from those bodies.

## Proposed product API (v0.2.0)

| Method | Path | Request | Success |
|---|---|---|---|
| GET | `/api/projects?cursor=...&limit=...` | Cursor optional; limit <=20 | `{items:[{id,name,version,updatedAt}],nextCursor}` |
| POST | `/api/projects` | `{name}` | `201 {project:{id,name,version:0}}` |
| GET | `/api/projects/:id` | — | `{project:{id,name,version,updatedAt}}` |
| PATCH | `/api/projects/:id` | `{name}` | `{project:{id,name,version,updatedAt}}` |
| DELETE | `/api/projects/:id` | — | `204` |
| GET | `/api/projects/:id/snapshots` | — | `{projectId,version,snapshot:null | {id,createdAt,audit}}` |
| POST | `/api/projects/:id/snapshots` | `{expectedVersion,idempotencyKey,audit}` | `201 {projectId,version,snapshotId,savedAt}`; repeated key returns existing result |

`Project.name`: trimmed 1–100 characters. `id`: generated server-side UUID/CUID with strict expected format. `expectedVersion`: nonnegative safe integer. `idempotencyKey`: UUID. `audit`: strict AuditV1 JSON, at most 4 MiB encoded request. For any save the engine needs confirmed mappings, no active AI run, and a completed invariant check. `Cache-Control: private, no-store` on all session/project responses; guest page stays guest-safe.

## Error response shape

```json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "This project was updated elsewhere. Reload the latest version before saving."
  }
}
```

| Code | Status | Meaning |
|---|---:|---|
| `UNAUTHENTICATED` | 401 | No current verified session |
| `NOT_FOUND` | 404 | Not visible to this session, or absent |
| `INVALID_INPUT` | 400 | Invalid schema, unsupported audit or invalid transition |
| `INVALID_ORIGIN` | 403 | Disallowed cross-site mutation |
| `PAYLOAD_TOO_LARGE` | 413 | Request exceeds Phase 05 cap |
| `VERSION_CONFLICT` | 409 | Optimistic concurrency check failed |
| `STORAGE_UNAVAILABLE` | 503 | DB unreachable (guest mode still works) |
| `NOT_CONFIGURED` | 503 | Accounts not configured on this server (auth route, 05-I/C1) |
| `INTERNAL_ERROR` | 500 | Generic internal failure; no sensitive details |

Preserve existing FastAPI's separately documented `ApiError` codes without reinterpreting them as project errors.

## Example save

```json
{
  "expectedVersion": 3,
  "idempotencyKey": "bb5ad43f-cf5b-4ccd-89e7-a0ba37e2fdc4",
  "audit": {"schemaVersion": 1, "...": "all other fields from real AuditV1"}
}
```

The ellipsis is explanatory, **not** a valid actual request. Client obtains its audit from `prepareExport`, never by constructing a partial audit document.

## API invariants

- Authorized user's `ownerId` comes from server-verified session and is applied on **every** DB query.
- All writes validate Origin and Content-Type and reject unknown body fields.
- Project list never returns embedded audit/CSV data.
- Snapshot read is one permitted project's latest snapshot only; no publicly guessable download URL.
- Snapshot save uses independent replay validation and ACID transaction, not request-supplied `acceptedPairs` as authority.
- Idempotency key is scoped to a project; replay returns exactly the originally recorded outcome.
- New Next routes must be proved not intercepted by the Vercel FastAPI service before any account-based public release.

## Test fixture priorities

Unauthenticated list, forged ID, cross-user read/write/delete, bad Origin, payload >4 MiB, invalid audit, version stale, idempotent retry, simultaneous writes, inability to find another user's existence, and untouched legacy inference responses.
