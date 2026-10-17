# Phase 05 — Deployment, self-hosting and operations

**Status: Proposed.** Existing `compose.yaml`, `web/Dockerfile`, `api/Dockerfile`, root `vercel.json`, `docs/docker.md`, `docs/vercel.md` are shipped v0.1 configurations and are not modified by this pack.

## A. Current deployment shape (v0.1.0)

- `docker compose up -d --build` runs `web` and `api` on private `accord` network; only `127.0.0.1:3000` is published on host.
- Web has read-only root FS, drops privileges and uses read-only production Next standalone output; API private on Docker network and has separate runtime OpenRouter key.
- `ACCORD_API_ORIGIN` Next rewrite destination is baked into the web image at build time.
- Root `vercel.json` routes only `/api/map`, `/api/suggest`, `/api/capabilities` to Python and everything else to Next (05-I/A; preview check pending).
- No data volume or migration runner exists.

## B. Proposed v0.2.0 Compose topology

```text
browser → localhost:3000 → web (Next; server-only auth and Prisma)
                              ├─ api:8000 → OpenRouter
                              └─ db:5432 (PostgreSQL)
                 db → persistent named volume
  one-shot migrate service → db (migrate deploy before web ready)
```

- Pin official supported PostgreSQL image to **fixed tested minor/tag or digest**; choose final version in a compatibility spike (no assumed unverified pin here).
- Database port not published except optional *explicit* loopback `127.0.0.1:5433:5432` for local CLI. Never bind 0.0.0.0:5432.
- Named volume survives `docker compose down`. `down --volumes` **deletes the DB**; it must be labeled destructive in docs/scripts.
- Add `pg_isready` healthcheck, constrained network and non-superuser application role. Postgres init/DB privileges should remain scoped; migration role strategy should be documented if different from app role.
- Use one-shot migration container (`pnpm exec prisma migrate deploy`) that depends on healthy DB. Migration runs from committed SQL, **never** `migrate dev`, `db push`, or auto-resets in production.
- Preserve existing runtime protections. For new migration and PostgreSQL services review practical write requirements (DB must write to its data volume); do not blindly apply `read_only` to a service that must write data.
- Next production image needs generated Prisma Client and runtime driver adapter; generation runs during build without DB credential. `DATABASE_URL`, `BETTER_AUTH_SECRET`, canonical URL, signup toggle supplied only at runtime.
- Python API **must not** receive `DATABASE_URL` or Better Auth session secret; proxy and validation behavior unchanged.
- Handle DB-not-configured in local guest dev without eagerly crashing `web/app/page.tsx` or bundling server modules into client code.

## C. Environment contract (names proposed; implementer confirms installed library requirements)

| Variable | Where | Mandatory | Notes |
|---|---|---|---|
| `DATABASE_URL` | Next runtime + migration job | Account mode | PostgreSQL DSN; never client/build public env |
| `BETTER_AUTH_SECRET` | Next runtime | Account mode | Strong random secret, no repo/CI plaintext |
| `BETTER_AUTH_URL` | Next runtime | Account mode | External canonical origin, HTTPS production |
| `ACCORD_SIGNUP_ENABLED` | Next runtime | Account mode | Default false on public deployment |
| `ACCORD_API_ORIGIN` | Next Docker build / local Next dev | Inference proxy | Existing value, keep build-time caveat |
| `OPENROUTER_API_KEY`, `OPENROUTER_MODEL` | Python runtime only | AI optional | Existing project variables; no client exposure |

Provide tracked `.env.example` files with placeholders, never usable secrets. Check `.gitignore` covers both root and web env variants, plus generated files/cache. Never add real keys to GitHub Actions.

## D. Hosted deployment/Vercel

- Vercel Services evaluates top-level rewrites in order, first match wins, and does not fall back after entering a service (Vercel Services routing docs, checked 2026-10-17). Three exact inference rules then the `/(.*)` → `web` catch-all already send `/api/auth/*` and `/api/projects/*` to Next; no separate rules are needed. Confirm on a preview before an account-based release.
- Provision persistent managed PostgreSQL independently. Do not use ephemeral container filesystem as storage.
- Choose a documented DB connection pool strategy for serverless instances; measure connection exhaustion, don't assume a single in-process Prisma pool protects across many instances.
- Run schema migration as a separate deploy step **before** enabling new account-backed traffic. A failed migration blocks rollout; no migration when a Next request arrives.
- `BETTER_AUTH_URL`/trusted origins/cookies must reflect actual production hostname; preview domains require explicit trust and no accidental production cookie crossover.
- Existing FastAPI provider limits are per process/instance, so production needs an OpenRouter provider spend cap as hard boundary; no promise of reliable global quota enforcement with memory-only rate counters.
- Do not enable public signup until verification/recovery flows exist or an explicit operator accepts that limitation.

## E. Backup, recovery and upgrade runbook (requirements before v0.2.0 release)

**Backup:** record safe `pg_dump` command using env-injected credentials/`pgpass`, target protected backup destination, note that backups contain account and parsed CSV content. Avoid pasting passwords into shell history. Periodically test backup restore to disposable instance.

**Restore test:** create real project → save snapshot → backup DB → restore into isolated DB → authenticate → reopen project → replay snapshot → compare expected CSV. Use a private test dataset.

**Upgrade:** document version prerequisites, apply `migrate deploy` with backup, start new web/api, run smoke. Prisma migrations are generally forward-only; for a failed incompatible migration, restore backup in a separate rollback plan rather than relying on destructive reset.

**Lifecycle:** user project deletion cascades snapshots; user-account deletion and data export/retention beyond project deletion are deferred—state clearly. Session secret rotation invalidates sessions; plan a documented safe rotation process.

## F. Commands that exist vs will exist

Current valid commands:

```sh
# Repository root
 docker compose config --quiet
 docker compose up -d --build
 scripts/docker-smoke.sh
 docker compose down
# web/
 pnpm install --frozen-lockfile && pnpm test && pnpm lint && pnpm build
# api/
 uv sync --locked && uv run pytest -q
```

Planned post-implementation commands (not executable yet):

```sh
cd web
pnpm exec prisma validate
pnpm exec prisma generate
pnpm exec prisma migrate deploy  # only against selected DB with required env
```

## G. Self-hosting release gate

Fresh clone + placeholder env → launch with guest mode; configure account DB/auth → migrate → login and create project → save → stop/restart → reopen → backup → restore to new instance → reopen again. Every step must have a documented command and failure recovery procedure before calling it production-ready.
