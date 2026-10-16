# Cloudflare deployment runbook

Plan and requirements: `docs/accord-cloudflare-fullstack-claude-prompt.md`. Status: `docs/progress.md`.

## What runs where

| Environment | Web (Pages `accord-web`) | Python Worker | Gateway | Public AI |
| --- | --- | --- | --- | --- |
| `develop` → staging | Branch alias `https://develop.accord-web-3so.pages.dev` | `accord-api-staging` (private probe) | `accord-gateway-staging` (AI off) | **Off** (Mode A) |
| `main` → production | `https://accord-web-3so.pages.dev` | Not deployed | Not deployed | **Off** (Mode A) |
| Local / Docker | `pnpm dev`, `docker compose` | uvicorn | None | `api/.env` key, unchanged |

Cloudflare account `278fc37d9cb379ee892fd4077a325214`. Free plan.

**Mode B (public AI) failed its gate on 2026-10-16.** The deployed Python Worker used 5–13 ms
CPU on `/health` alone, against a 10 ms limit on Workers Free (see progress.md). The
web stays in Mode A: AI is shown as unavailable and the site makes no `/api` requests. The
staging probe Workers are left deployed with AI off. They never receive web traffic.

## Automated web deploys (`.github/workflows/ci.yml`, job `deploy-web`)

The job runs only on a **push** to `develop` or `main`, after `web`, `api`, `e2e` and `docker`
pass on that same commit. PRs, forks, `release/**` and `workflow_dispatch` never deploy.

1. It checks out `github.sha` and runs `pnpm build:cloudflare`.
2. It greps `out/` for provider secrets.
3. It runs `wrangler pages deploy out --branch <ref> --commit-hash <sha>`.
4. It asserts that Pages reports `production` for `main` and `preview` for `develop`. A
   different answer means the project's production branch is misconfigured.
5. It runs `pnpm e2e:static` (canonical sample → 3 exports → audit replay, 390px, 404, zero
   `/api` calls) against the exact deployment URL.

The URL and deployment ID are written to the job summary. Concurrency is `deploy-<branch>` and
never cancels a running deploy.

### One-time setup (owner)

1. **GitHub CLI access.** This machine's `gh` (`rupak885`) gets 404 on `Prorupak/Accord`. Run
   `gh auth login` with an account that has access, then verify CI with `gh run list`.
2. **Environments.** In Settings → Environments, create `staging` with deployment branch
   `develop` and `production` with deployment branch `main`. Add required reviewers to
   `production` if your plan allows it. A private repo on GitHub Free has no branch policies or
   reviewers, so the job's own `if:` is then the only branch guard.
3. **Cloudflare token.** In My Profile → API Tokens → Create Custom Token, grant *Account →
   Cloudflare Pages → Edit* on account `278fc37d…` only. Create one token per environment so
   either can be revoked alone.
4. **Per environment**, add secret `CLOUDFLARE_API_TOKEN` and variable
   `CLOUDFLARE_ACCOUNT_ID=278fc37d9cb379ee892fd4077a325214`.
5. **Pages project.** In Workers & Pages → `accord-web` → Settings, set production branch
   `main`. Leave Git integration off: CI is the only deploy owner.
6. **Branch rules.** Keep the required checks `web`, `api`, `e2e` and `docker`. `deploy-web`
   runs only on push, so it is not a PR check.

## Rollback

- **Web.** `cd web && pnpm exec wrangler pages deployment list --project-name accord-web`
  lists IDs, branches and commits. In the dashboard, open Workers & Pages → `accord-web` →
  Deployments → *Rollback* on the last good production deployment. Staging (preview)
  deployments are rolled back by pushing a revert to `develop`.
- **Workers.** Run `wrangler rollback --env staging` from `gateway/`, or
  `scripts/worker.sh rollback --env staging` from `api/`. Roll back the gateway before the
  API. Rollback never touches Durable Object data, so quota usage is kept.

## Kill switch and probe Workers

- Public AI is on only while the gateway secret `PUBLIC_AI_ENABLED` is exactly `true`. It is
  absent today.
- To turn AI off, run `cd gateway && pnpm exec wrangler secret delete PUBLIC_AI_ENABLED --env <env>`.
  This takes effect immediately with no rebuild, and the static site keeps working.
- To remove the probe entirely, run
  `pnpm exec wrangler delete --name accord-gateway-staging`, then
  `... --name accord-api-staging`.
- The Python Worker has `workers_dev: false` and `preview_urls: false`, and
  `https://accord-api-staging.<subdomain>.workers.dev` returns 404. The only way in is the
  gateway's service binding (`http://accord-api:8000`, accepted by the existing Host guard
  through `API_INTERNAL_HOST`).
- The gateway accepts only the built-in sample (`gateway/src/sample.json`). That file is
  generated and drift-checked by `web/src/domain/gatewaySample.test.ts`. The gateway reserves
  3 units per call (`DAILY_UNITS=30`, so 10 calls per UTC day) in a SQLite Durable Object
  before forwarding, and never refunds them.

## Secrets and names (never values)

| Name | Where | Purpose |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | GitHub env `staging` / `production` | Pages deploy |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub env variable | Non-secret |
| `OPENROUTER_API_KEY` | Cloudflare secret on `accord-api-<env>` (not set) | Provider key, Mode B only |
| `PUBLIC_AI_ENABLED` | Cloudflare secret on `accord-gateway-<env>` (not set) | Kill switch |

## Rotation

- **Cloudflare token.** Create a new token, update the GitHub environment secret, then
  delete the old token in the dashboard.
- **OpenRouter key.** Revoke it at openrouter.ai/keys first, then put the new one with
  `scripts/worker.sh secret put OPENROUTER_API_KEY --env <env>` (from `api/`, typed at the
  prompt). The local `api/.env` key is separate.

## Free-plan triage

| Symptom | Meaning | Action |
| --- | --- | --- |
| Error **1027** | 100k requests/day used | Wait for 00:00 UTC |
| Error **1102** or `exceededCpu` in Workers Logs | CPU limit hit | Expected for the Python Worker; keep AI off |
| Gateway `429 RATE_LIMITED` | Daily unit budget used | Wait for 00:00 UTC |
| `502 UPSTREAM_ERROR "credits"` | Provider budget | Check the OpenRouter key's limit |

## Local Python Worker work

Run `scripts/worker.sh dev|deploy|...` from `api/`. It copies `app/` into the gitignored
`worker/app/`, the module root that keeps `.venv/` and `tests/` out of the upload. It also sets
`CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false`, because plain `wrangler dev` would load
`api/.env` and make real provider calls.
