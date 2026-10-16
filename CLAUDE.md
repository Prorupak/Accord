# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Accord compares two inventory/catalog CSV exports, proposes matches, and produces a traceable
reconciliation package. `docs/accord-implementation-spec.md` is the source of truth (sections are
cited as `§N` in code and docs). `docs/progress.md` records what is built and what is still open.
The one intended deviation from the spec: the backend is Python/FastAPI calling OpenRouter through
the OpenAI SDK, not Node/Express with the AI SDK.

Ownership split (spec §5): the **browser** owns parsing, matching state, acceptance and exports.
The **API** only performs two bounded inference calls and never stores data or accepts matches.

## Layout

- `api/`: FastAPI backend (Python 3.13, uv). See `api/README.md` for endpoints, limits and error codes.
- `web/`: Next.js 16 / React 19 / Tailwind 4 frontend. Working workflow UI in `web/src/ui/`.
- `gateway/`: Cloudflare Worker for sample-only public AI, with a quota Durable Object (`pnpm test`). It forwards to the API hosted on Render (`render.yaml`). Deploys: `docs/cloudflare-deploy.md`.
- `fixtures/`: test CSV data.

## Commands

Backend (run from `api/`):

```sh
uv sync                                  # install; then cp .env.example .env and set OPENROUTER_API_KEY / OPENROUTER_MODEL
uv run python -m app                     # dev server on 127.0.0.1:8000 with reload; docs at /docs
uv run pytest -q                         # all tests; provider is mocked, no network
uv run pytest tests/test_mapping.py::test_name -q   # single test
uv run ruff check . && uv run ruff format --check .
```

Frontend (run from `web/`; lockfile is pnpm):

```sh
pnpm dev        # http://localhost:3000
pnpm lint
pnpm build
npx tsc --noEmit
pnpm build:cloudflare   # static export to out/ (Mode A, no AI actions); see docs/progress.md
pnpm e2e:static         # builds out/ and runs e2e/*.static.ts against a plain static server
```

Docker (repo root; see `docs/docker.md`): `docker compose up -d --build`, then
`scripts/docker-smoke.sh`, `docker compose down`.

Run both servers together for end-to-end work. `web/next.config.ts` rewrites `/api/*` to
`ACCORD_API_ORIGIN` (default `http://127.0.0.1:8000`). UI code calls `/api/...` on its own origin,
so there is no CORS.

## Backend architecture

Request flow: `app/http.py` guards → route in `app/routes/` (`mapping.py` → `POST /api/map`,
`suggestions.py` → `POST /api/suggest`) → `app/openrouter.py` provider call → verification in
`app/schemas.py` → response.

- `http.py` is the trust boundary. It checks the Host (`127.0.0.1`/`localhost` on the API port),
  the Origin (must be `FRONTEND_ORIGIN` when present) and the JSON content type, enforces the
  64 KiB body cap before parsing, builds the §8.3 error envelope (`ApiError` → `error_response`),
  and holds the single inference slot (a concurrent request gets 409 `BUSY`).
- `schemas.py` holds the request/response contracts, every limit constant, and the
  post-model verification. Model output is checked against the *request*: IDs must exist,
  candidates must have been supplied, and evidence values must match exactly. Schema/format
  failures get one repair attempt. Reference/evidence failures return 502
  `MODEL_INVALID_OUTPUT` without a retry.
- `openrouter.py` owns the retry/repair budget (≤3 attempts, ≤1 repair, 45 s deadline, SDK
  retries off) and sends a strict JSON schema with `provider.require_parameters=true`. There is
  no fallback model.
- Responses echo `requestId`, `generation` and (for suggest) `configurationHash`.
- Invariants: the API key never reaches responses, logs or errors. Logs never contain cell
  contents (unless the dev-only `LOG_MODEL_OUTPUT` flag is set). Provider messages and stack traces are never forwarded. A missing key does not stop
  startup; inference then returns 503 `NOT_CONFIGURED`.

## Frontend notes

UI styling follows the `accord-design-system` skill and `docs/ui-design-system.md`. Design tokens
live only in the `@theme static` block of `web/app/globals.css`; components use the generated
utilities (`bg-canvas`, `text-muted`, `rounded-panel`), never hex values or Tailwind palette colors.

`web/AGENTS.md`: this Next.js version has breaking changes from what you may know. Read the
relevant guide in `web/node_modules/next/dist/docs/` before writing Next.js code. `next dev`
rewrites `AGENTS.md`; commit it rather than reverting it.

## Cost caution

The live smoke test in `api/README.md` makes a real OpenRouter request and spends quota. Run it
only with explicit go-ahead.
