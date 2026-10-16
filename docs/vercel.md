# Vercel deployment

`vercel.json` at the repo root deploys one Vercel project with two
[services](https://vercel.com/docs/services):

| Service | Root | Public path |
| --- | --- | --- |
| `api` (FastAPI, `app/main.py:app`) | `api/` | `/api/*` |
| `web` (Next.js) | `web/` | everything else |

The browser calls `/api/map`, `/api/suggest` and `/api/capabilities` on its own origin. Vercel
passes the path through unchanged, so `api` must be public. No service calls another from the
server, so there are no bindings. `/health` is not exposed.

## Environment variables

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
