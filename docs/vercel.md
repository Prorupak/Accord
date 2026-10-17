# Vercel deployment

`vercel.json` at the repo root deploys one Vercel project with two
[services](https://vercel.com/docs/services):

| Service | Root | Public path |
| --- | --- | --- |
| `api` (FastAPI, `app/main.py:app`) | `api/` | `/api/map`, `/api/suggest`, `/api/capabilities` (exact) |
| `web` (Next.js) | `web/` | everything else, including any other `/api/*` path |

The browser calls `/api/map`, `/api/suggest` and `/api/capabilities` on its own origin. Vercel
passes the path through unchanged, so `api` must be public. No service calls another from the
server, so there are no bindings. `/health`, `/docs` and `/openapi.json` are not exposed.

## Two routing layers

- **Root `vercel.json`** is the outer router on Vercel. Its `rewrites` are evaluated in order and
  the first match picks the service; routing into a service is final, with no fallback to later
  rules. The three exact inference rules come first, then `/(.*)` sends everything else to `web`.
- **`web/next.config.ts` `rewrites()`** is the proxy for `pnpm dev`, `next start` and Docker, where
  Next is the only public entry point. It forwards the same three paths to `ACCORD_API_ORIGIN`.

On Vercel the Next rewrite never sees inference traffic, and a Next rewrite cannot override the
outer router. Change both together. `web/src/routing/apiRouting.test.ts` checks both against the
same path lists; future `/api/auth/*` and `/api/projects/*` handlers are Next's in both layers.

## Environment variables

The `web` build runs `prisma generate` (part of `pnpm build`), which needs no database. Since
Phase 05-I/C1 `/api/auth/*` uses `DATABASE_URL`, `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL`; with
any of them unset it answers 503 `NOT_CONFIGURED` and the guest app is unaffected. **Do not set them
on Vercel yet**: accounts have not been tested on a preview, the database role is still the
privileged migration role (05-I/C2), and serverless connection pooling is undecided. When they are
set, use runtime (not build) variables, give each preview its own `BETTER_AUTH_URL` (its exact
origin, which is the only trusted origin) and its own throwaway database and secret, and keep
`ACCORD_SIGNUP_ENABLED` unset. Migrations stay a separate deploy step, never run by a request.

Set these in the Vercel project: `OPENROUTER_API_KEY` and `OPENROUTER_MODEL`. You do not need
`FRONTEND_ORIGIN`. The API host/origin guard trusts the hostnames Vercel provides in `VERCEL_URL`,
`VERCEL_BRANCH_URL` and `VERCEL_PROJECT_PRODUCTION_URL`. If you attach a custom domain that is not
the production domain, the guard rejects it.

## Local

`vercel dev -L` at the repo root runs both services behind the same rewrites. `pnpm dev` and
Docker keep working as before through the Next rewrite in `web/next.config.ts`.

## Caveats

- The single inference slot (`BUSY`) applies per function instance. Separate instances do not
  share it.
- The rate limits and the daily provider budget (`docs/edge-protection.md`) are also in memory
  per instance. Separate instances keep separate counters, and a cold start resets them. Set a
  credit limit on the OpenRouter key as the hard cap.
- Fluid compute's default maximum duration (300 s) covers the 45 s inference deadline.
- Not yet checked on a real deploy: whether the function receives `http.disconnect` (the Cancel
  flow needs it) and whether it sees the public `Host` header.
- The explicit inference allowlist (Phase 05-I/A) has not been checked on a preview deploy yet.
  Before merging auth work, confirm on a preview: `/api/capabilities` returns the API JSON, `POST
  {}` to `/api/map` and `/api/suggest` returns 400 `INVALID_INPUT`, `/api/auth/get-session`
  returns Next's 503 `NOT_CONFIGURED` JSON (with auth unset), and `/api/projects` and an unknown
  `/api/*` path return Next's HTML 404, not `{"detail":"Not Found"}`.
- Auth rate limits are keyed on `x-forwarded-for`. Vercel documents that it sets this header
  itself; not yet confirmed on a deploy.
