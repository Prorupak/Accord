# Docker (local integration)

Deployment phase 01. Production-mode images for `web/` (Next.js) and `api/` (FastAPI), run together
with one `compose.yaml`. This is local integration only. Nothing here deploys anywhere.

`docs/recommendation.md` ruled Docker out for v1. This phase adds it at the owner's request. The
non-Docker commands in `CLAUDE.md` still work unchanged.

## Architecture

```
browser ──► 127.0.0.1:3000 ──► web (node server.js, Next.js standalone)
                                 │  /api/{map,suggest,capabilities} rewrite, baked at build time
                                 ▼
                               api:8000 (uvicorn, internal network only)
                                 │
                                 ▼
                               OpenRouter (only on Analyze / Suggest mappings)
```

- Only `web` publishes a port, and only on loopback (`127.0.0.1:3000`). `api` uses `expose`, so it
  is reachable from `web` and nowhere else.
- The browser still calls `/api/...` on its own origin, so there is no CORS. Spec §5 ownership is
  unchanged: the browser owns parsing, matching state and exports; the API only runs inference.
- `api` must report healthy (`GET /health`) before `web` starts (`depends_on: service_healthy`).
- Both containers run as non-root with a read-only root filesystem, `cap_drop: [ALL]` and
  `no-new-privileges`. `/tmp` (and Next's `.next/cache`) are tmpfs.

## Prerequisites

- Docker Engine with Compose v2 (`docker compose version`). Tested with Docker 29.4.3 and Compose v5.1.4.
- Port 3000 free on loopback. Stop `pnpm dev` first.

## Setup

```sh
cp api/.env.example api/.env        # once; then set OPENROUTER_API_KEY and OPENROUTER_MODEL
```

`api/.env` is gitignored and excluded from both build contexts. Compose passes it to the `api`
container **at runtime** (`env_file`). The key is never a build argument, never in an image layer, and
never in the `web` container. Without the file, or with an empty key, the stack still starts and
inference returns 503 `NOT_CONFIGURED`. Manual reconciliation and export still work.

Compose sets three values itself and overrides the same names in `api/.env`:
`API_PORT=8000`, `API_INTERNAL_HOST=api`, `FRONTEND_ORIGIN=http://localhost:3000`.

## Commands

Run from the repo root.

```sh
docker compose build                 # build both images
docker compose up -d                 # start (add --build to rebuild first)
docker compose ps                    # api should show (healthy); web shows 127.0.0.1:3000->3000/tcp
docker compose logs -f api web       # follow logs
scripts/docker-smoke.sh              # smoke checks against the running stack (no provider calls)
docker compose down                  # stop and remove containers and the network
```

Open http://localhost:3000.

## Health verification

```sh
curl -s http://127.0.0.1:3000/                    # 200, HTML includes the sample fixture names
curl -s http://127.0.0.1:3000/api/capabilities    # 200 JSON via the Next.js proxy
docker inspect --format '{{.State.Health.Status}}' "$(docker compose ps -q api)"   # healthy
docker port "$(docker compose ps -q api)"         # empty: the API publishes no host port
```

`scripts/docker-smoke.sh` runs these checks. It also POSTs `{}` to `/api/map` and `/api/suggest`
through the proxy and expects 400 `INVALID_INPUT` from schema validation. That proves the proxied
Host and Origin pass the API guard without calling OpenRouter. It never sends a real analysis
request. Finally it checks that `/api/auth/session`, `/api/projects`, `/api/projects/example/snapshots`,
`/api/random` and `/api/map/unknown` get Next's HTML 404, not FastAPI's JSON 404: only the three
inference paths are proxied.

Do not use `curl 127.0.0.1:8000` to check exposure. A local `uv run python -m app` may be listening
there, and that is not the container.

## How the images are built

**web** (`web/Dockerfile`, build context = repo root):
- `node:24.22.0-bookworm-slim`, pnpm 10.16.1 via corepack, `pnpm install --frozen-lockfile` from
  `web/pnpm-lock.yaml`.
- The context is the repo root because `app/page.tsx` reads `../fixtures/inventory/*.csv` at build
  time. The page is prerendered, so the CSVs are baked into it and the runtime image does not
  carry `fixtures/`.
- `NEXT_OUTPUT_STANDALONE=1` turns on `output: "standalone"` in `next.config.ts` for this build only.
  Local `pnpm build` / `pnpm start` / Playwright are unaffected.
- `ACCORD_API_ORIGIN` is a **build arg** (`http://api:8000`). Next resolves `rewrites()` at build time
  into `.next/routes-manifest.json`, so changing it means rebuilding. Setting it at runtime alone
  does nothing.
- Runtime stage: only `.next/standalone`, `.next/static` and `public/`, owned by root and run as `node`.
- `pnpm build` runs `prisma generate` first. It reads `web/prisma/schema.prisma` only; no
  `DATABASE_URL` exists at build time and none is baked in. Nothing imports Prisma yet, so the
  runtime image carries no Prisma code until Phase 05-I/C. When a server route does import
  `src/server/db.ts`, Next traces the client and `pg` into the standalone output; that was
  rehearsed with a temporary route (not committed) on 2026-10-17.
- `migrate` target (`FROM deps`): `node_modules` plus `prisma.config.ts` and `prisma/`, runs as
  `node`, command `prisma migrate deploy`. `openssl` is installed in `deps` so the
  `@prisma/engines` install script picks the right schema-engine build
  (`pnpm.onlyBuiltDependencies` in `web/package.json` allows that script).

**api** (`api/Dockerfile`, build context = `api/`):
- `python:3.13.16-slim` with uv 0.12.18 copied from `ghcr.io/astral-sh/uv:0.12.18`.
- `uv sync --locked --no-dev --no-install-project`: the exact `uv.lock` set, no pytest/ruff/httpx.
- Runtime stage: the venv and `app/` only, user `accord` (uid 10001).
- `uvicorn app.main:app --host 0.0.0.0 --port 8000`. Not `python -m app`, which binds
  `API_HOST` (loopback) and enables reload.

## Host guard in containers

`api/app/http.py` accepts only `Host: 127.0.0.1:<port>` / `localhost:<port>`. The Next.js proxy
arrives as `Host: api:8000`, so Compose sets `API_INTERNAL_HOST=api`. That adds exactly one host,
`api:8000`. The value must be a bare lowercase label (no `*`, dots or port), or settings fail to load.
Origin rules are unchanged: an `Origin` header must equal `FRONTEND_ORIGIN`. `http://api:8000` is not
an allowed origin. Unset (the default, and every non-Docker run), behaviour is as before.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `Bind for 127.0.0.1:3000 failed: port is already allocated` | `pnpm dev` or another server holds 3000. Stop it. |
| `web` never starts, `api` is `unhealthy` | `docker compose logs api`. The image failed to boot or bind; rebuild with `docker compose build api`. |
| Every inference call returns 500 `UPSTREAM_ERROR` | Settings failed to load, e.g. an invalid `API_INTERNAL_HOST` or `API_PORT` in `api/.env`. `/health` does not read settings, so the container still reports healthy. |
| `/api/capabilities` returns `"configured": false`, analysis gives 503 `NOT_CONFIGURED` | `api/.env` missing or key/model empty. Edit it, then `docker compose up -d` (recreates `api`; no rebuild needed). |
| 400 `Unexpected Host header` | `API_INTERNAL_HOST` does not match the service name, or the image was built with a different `ACCORD_API_ORIGIN`. |
| 403 `Origin not allowed` | The page was opened on an origin other than `FRONTEND_ORIGIN`. Use `http://localhost:3000`, not `http://127.0.0.1:3000`, or change both. |
| Inference calls hit the wrong host after editing `ACCORD_API_ORIGIN` | The rewrite is baked at build time. `docker compose build web`. |
| 409 `BUSY` | One inference at a time (spec). Wait or cancel the running request. |
| `Cannot connect to the Docker daemon` | Start Docker Desktop. |

## Tradeoffs

- **Standalone output behind an env flag** keeps local commands unchanged. The cost is one
  conditional line in `next.config.ts`.
- **Build-time rewrite target**: the web image is tied to the `api` service name. A different backend
  address needs a rebuild. That is acceptable for local integration. A deploy phase may want a
  runtime-configurable proxy instead.
- **Read-only root FS + tmpfs** is the stricter default. If a future feature writes to disk, it
  needs an explicit volume.
- **Debian slim over Alpine** avoids musl edge cases with Next's native SWC/lightningcss binaries,
  at some image size cost.
- The base `compose.yaml` still has no database or volumes: the API is stateless and the browser
  owns all guest data (spec §5). PostgreSQL is opt-in through `compose.db.yaml`, below.

## Account database (opt-in, Phase 05-I/B)

`compose.db.yaml` adds PostgreSQL and a one-off migration runner. **Nothing in the app reads or
writes the database yet**: there is no login, no project API and no save/reopen (Phase 05-I/C and
05-I/D). Guest mode is plain `docker compose up` and never needs it.

It is a separate file, not a Compose profile, because Compose interpolates required variables
(`${POSTGRES_PASSWORD:?}`) for every service in a file, including inactive profiles. A profile
would make guest `up` demand a database password.

| Service | Image | Notes |
| --- | --- | --- |
| `db` | `postgres:18.6-bookworm` | Named volume `accord-db` at `/var/lib/postgresql` (PostgreSQL 18 keeps PGDATA in `18/docker` under it). `expose` only, **no host port**. `pg_isready` health check. `cap_drop: ALL` plus `CHOWN, DAC_OVERRIDE, SETGID, SETUID` (the minimum that starts and restarts; tested), `no-new-privileges`. Not `read_only`: it writes its data volume. |
| `migrate` | `accord-migrate:local` (`web/Dockerfile` target `migrate`) | Profile `migrate`, so `up` never starts it. Waits for a healthy `db`, runs `prisma migrate deploy` on the committed SQL, exits. Read-only root, `cap_drop: ALL`. |
| `web` | unchanged | Gets `DATABASE_URL` at runtime. Does **not** depend on `db`: guest pages work with the database stopped. |
| `api` | unchanged | Gets no database or auth variables. |

```sh
cp .env.example .env                    # once; set POSTGRES_PASSWORD (e.g. openssl rand -hex 24)
DB="-f compose.yaml -f compose.db.yaml"
docker compose $DB up -d --wait db      # start PostgreSQL
docker compose $DB run --rm migrate     # apply committed migrations (safe to repeat)
docker compose $DB up -d --build        # web + api (+ db) with DATABASE_URL set on web
docker compose $DB exec db psql -U accord accord     # local inspection; no published port
docker compose $DB down                 # stop; the accord-db volume and its data stay
```

Use a URL-safe password (hex is): it is embedded in `DATABASE_URL`. Rotating it after the first
start needs `ALTER ROLE` inside the database; `POSTGRES_PASSWORD` only applies to a new volume.

**`docker compose ... down --volumes` deletes the database.** Never use it as routine cleanup. CI
uses it only on throwaway runners.

Migrations run only when you run `migrate`; the web container never migrates on startup.
Prisma migrations are forward-only. To undo a bad migration, restore a backup taken before it
(below); do not use `prisma migrate reset` or `db push` on a database you care about.

`scripts/docker-db-check.sh` rehearses the lifecycle under its own Compose project
(`accord-dbcheck`) with a throwaway password and synthetic rows: first migrate, no host port,
insert, `down`/`up` with the volume kept, rows still there, second migrate is a no-op, then
`pg_dump`/`pg_restore` into a scratch database. It deletes only its own volume on exit and never
touches the `accord` project's data.

### Backup and restore

Backups contain everything in the database: once accounts and snapshots exist, that includes
email addresses, password hashes, sessions and **parsed source CSV cells** inside saved audits.
Store dumps encrypted, with access limited like the database itself, and delete old ones on a
schedule. The commands below read the password inside the container, so it never appears in your
shell history.

```sh
DB="-f compose.yaml -f compose.db.yaml"
docker compose $DB exec -T db pg_dump -U accord -d accord -Fc > accord-$(date +%F).dump
# Restore rehearsal into a scratch database, never over the live one:
docker compose $DB exec -T db createdb -U accord accord_restore_check
docker compose $DB exec -T db pg_restore -U accord -d accord_restore_check --no-owner --exit-on-error < accord-YYYY-MM-DD.dump
docker compose $DB exec -T db dropdb -U accord accord_restore_check
```

Only the synthetic rehearsal in `scripts/docker-db-check.sh` has been run. No real data has been
backed up or restored.

### Known limitations

- One database role (`accord`, the image's superuser) serves migrations and, later, the app. A
  separate least-privilege application role is planned for Phase 05-I/C.
- The image is pinned by tag, not digest.
- No connection pooling or TLS settings yet; both matter for hosted deployments (`docs/vercel.md`).

## Cloudflare

Cloudflare Workers do not run Docker images. These images are for local integration and any
container host chosen later. This phase adds no Wrangler config, adapters, CI or deployment, and
deploys nothing to Cloudflare or anywhere else.

For a future public deploy behind Cloudflare (WAF, edge rate limits, stopping direct access to the
origin), see `docs/edge-protection.md`.
