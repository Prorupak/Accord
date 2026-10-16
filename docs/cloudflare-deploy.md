# Deployment runbook

Plan and requirements: `docs/accord-cloudflare-fullstack-claude-prompt.md`. Status: `docs/progress.md`.

## What runs where

| Environment | Web (Cloudflare Pages `accord-web`) | Gateway (Cloudflare Worker) | API (Render, free) | Public AI |
| --- | --- | --- | --- | --- |
| `develop` → staging | `https://develop.accord-web-3so.pages.dev` | `accord-gateway-staging` | `accord-api-staging` | Sample only, once switched on |
| `main` → production | `https://accord-web-3so.pages.dev` | `accord-gateway-production` | `accord-api-production` | Sample only, once switched on |
| Local / Docker | `pnpm dev`, `docker compose` | None | uvicorn / container | `api/.env` key, any data |

Cloudflare account `278fc37d9cb379ee892fd4077a325214`, Free plan. Render workspace on the Free
plan (no payment method).

The browser talks only to the gateway. The gateway accepts only the built-in sample
(`gateway/src/sample.json`), spends a global daily quota (a SQLite Durable Object), and forwards
to the Render API with a shared token. The API trusts its `onrender.com` Host only while
`GATEWAY_TOKEN` is set, and then rejects any inference request without that token. A user's own
files never leave the browser: the web offers AI only when both loaded files are the sample
(`web/src/analysis/availability.ts`).

The Python API ran on a Cloudflare Python Worker during gate B (2026-10-16) but used 5–13 ms CPU
on `/health` against the 10 ms Workers Free limit, so it moved to Render.

## Automated deploys

- **Web.** `.github/workflows/ci.yml`, job `deploy-web`. It runs on a **push** to `develop` or
  `main` after `web`, `api`, `gateway`, `e2e` and `docker` pass on that commit. It builds with
  `pnpm build:cloudflare`, scans `out/` for secrets and API origins, runs `wrangler pages deploy`,
  checks that Pages reports `production` for `main` and `preview` for `develop`, and reruns
  `pnpm e2e:static` against the deployment URL. The GitHub environment variable
  `ACCORD_API_BASE` (the gateway origin) turns on the AI actions for the sample. If it is unset,
  the site has no AI (Mode A).
- **API.** `render.yaml` (a Render Blueprint). Each service follows its branch with
  `autoDeployTrigger: checksPass`, so Render deploys only after GitHub checks pass. Only changes
  under `api/` trigger a build.
- **Gateway.** Deployed by hand. It changes rarely, and its secrets are set by hand anyway:
  `cd gateway && pnpm exec wrangler deploy --env staging` (then `--env production`). CI runs its
  tests and dry-runs both environments.

## One-time setup (owner)

1. **GitHub CLI access.** This machine's `gh` (`rupak885`) gets 404 on `Prorupak/Accord`. Run
   `gh auth login` with an account that has access.
2. **GitHub environments.** Create `staging` (deployment branch `develop`) and `production`
   (deployment branch `main`). In each, add secret `CLOUDFLARE_API_TOKEN` (a custom token with
   only *Account → Cloudflare Pages → Edit* on this account, one token per environment) and
   variable `CLOUDFLARE_ACCOUNT_ID=278fc37d9cb379ee892fd4077a325214`.
3. **Pages project.** In Workers & Pages → `accord-web` → Settings, set the production branch to
   `main`. Leave Git integration off, because CI owns deploys.
4. **Render.** Sign up at render.com (GitHub login, no card), then New → Blueprint, pick this repo
   and `render.yaml`. Enter `OPENROUTER_API_KEY` when prompted. Use a separate OpenRouter key per
   environment with a low credit limit set at openrouter.ai. Note each service's URL. If Render
   added a suffix to the name, update `API_ORIGIN` in `gateway/wrangler.jsonc`.
5. **Gateway secrets**, per environment, typed at the prompt:
   `cd gateway && pnpm exec wrangler secret put API_TOKEN --env staging`. The value is the
   service's `GATEWAY_TOKEN` from Render → Environment. Then deploy the gateway.
6. **Switch AI on for staging.** Run `pnpm exec wrangler secret put PUBLIC_AI_ENABLED --env staging`
   with the value `true`. Then set GitHub variable `ACCORD_API_BASE` in environment `staging` to
   `https://accord-gateway-staging.<subdomain>.workers.dev` and push to `develop`.
7. **Production**, only after staging is verified: repeat steps 5 and 6 with `--env production`
   and the `production` GitHub environment, then merge to `main`.

## Free-plan behaviour

- A Render free service sleeps after 15 minutes without traffic. The first request after that
  waits about a minute. The web's run deadline is 4 minutes, and a map request can be retried.
  Hitting the gateway's `/health` wakes the API.
- The gateway reserves 3 units per call (`DAILY_UNITS=30`, so 10 calls per UTC day per
  environment) before forwarding, and never refunds them.

| Symptom | Meaning | Action |
| --- | --- | --- |
| Gateway `429 RATE_LIMITED` | Daily unit budget used | Wait for 00:00 UTC |
| Gateway `503 NOT_CONFIGURED` | Kill switch off, `API_TOKEN` missing, or the API has no OpenRouter key | Check the secrets |
| Gateway `/health` shows `api: status 400` or `403` | Host or token mismatch | Compare `API_TOKEN` with Render's `GATEWAY_TOKEN` |
| `502 UPSTREAM_ERROR "credits"` | Provider budget used | Check the OpenRouter key's limit |
| Render service suspended | 750 free hours or bandwidth used up | Wait for the next month |
| Cloudflare error 1027 | 100k requests/day used | Wait for 00:00 UTC |

## Kill switch and rollback

- **AI off, immediately:** `cd gateway && pnpm exec wrangler secret delete PUBLIC_AI_ENABLED --env <env>`.
  The site keeps working and shows the AI error message. To hide the AI actions as well, clear
  `ACCORD_API_BASE` in the GitHub environment and redeploy.
- **Web:** Workers & Pages → `accord-web` → Deployments → *Rollback* on the last good production
  deployment (`pnpm exec wrangler pages deployment list --project-name accord-web` lists them).
  Staging rolls back by pushing a revert to `develop`.
- **Gateway:** `cd gateway && pnpm exec wrangler rollback --env <env>`. Quota data is untouched.
- **API:** Render → service → Events → *Rollback* (free plans keep the two previous deploys).

## Secrets (names only)

| Name | Where | Purpose |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | GitHub env `staging` / `production` | Pages deploy |
| `CLOUDFLARE_ACCOUNT_ID`, `ACCORD_API_BASE` | GitHub env variables | Not secret |
| `OPENROUTER_API_KEY` | Render service env (`sync: false`) | Provider key |
| `GATEWAY_TOKEN` | Render service env (generated) | The API accepts inference only with it |
| `API_TOKEN` | Cloudflare secret on `accord-gateway-<env>` | Same value as `GATEWAY_TOKEN` |
| `PUBLIC_AI_ENABLED` | Cloudflare secret on `accord-gateway-<env>` | Kill switch, `true` to enable |

## Rotation

- **Gateway token.** In Render, set a new `GATEWAY_TOKEN` and save (this redeploys). Then put the
  same value as the gateway's `API_TOKEN`. Inference fails with 403 between the two steps.
- **OpenRouter key.** Revoke it at openrouter.ai/keys, then set the new value in Render →
  Environment.
- **Cloudflare token.** Create a new one, update the GitHub environment secret, then delete the
  old one.
