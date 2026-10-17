# Phase 05 — HTTP/API contract

**Status: Proposed.** Routes below don't exist in Accord v0.1.0. Existing FastAPI inference routes remain unchanged.

## Route routing plan

| Path | Runtime | State |
|---|---|---|
| `/` | Next page / browser reconciliation | Exists; guest-capable |
| `/api/map`, `/api/suggest`, `/api/capabilities` | FastAPI (same-origin proxy) | Exists; preserve contracts |
| `/api/auth/[...all]` | Next Node / Better Auth | Planned |
| `/api/projects` | Next Node / Prisma | Planned |
| `/api/projects/[id]` | Next Node / Prisma | Planned |
| `/api/projects/[id]/snapshots` | Next Node / Prisma | Planned |
| `/sign-in`, `/sign-up`, `/workspace`, `/workspace/projects/[id]` | Next pages | Planned |

**Required prerequisite:** current Next rewrite is `{source:'/api/:path*', destination:'.../api/:path*'}` and root `vercel.json` forwards `/api/(.*)` to FastAPI. Replace catch-all inference routing with explicit allowlisted FastAPI paths and specific Next routes before deploying auth. Verify real preview requests; do not rely on `web` route-handler code alone.

## Authentication

Better Auth's own handler owns `/api/auth/[...all]`, response shapes, cookie names and error semantics. Do not wrap or reinvent its session protocol. Next product routes read a verified Better Auth session server-side; a `User` ID in JSON/body is never trusted.

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
