# Accord progress

Last updated: 2026-10-15

## Summary

The FastAPI backend is built and tested. It sits behind the existing Next.js app through a dev
proxy. Both inference endpoints from spec §6–8 work against a mocked provider. Live OpenRouter
inference has **not** been verified yet.

The spec's Node/Express + AI SDK backend became Python + FastAPI, calling OpenRouter through the
OpenAI Python SDK. Everything else follows `accord-implementation-spec.md`.

## Done

### Repo hygiene

- Added a root `.gitignore`. Before this, `api/.env` (which holds the real OpenRouter key) was
  untracked but not ignored, so a plain `git add .` would have committed it. It now excludes
  `.env`, `.env.*` (except `.env.example`), `.venv/`, Python caches, `.pytest_cache/`,
  `.ruff_cache/` and `.DS_Store`.

### Backend (`api/`)

Python 3.13 project managed with uv. Dependencies: fastapi, uvicorn, pydantic v2,
pydantic-settings, openai. Dev: pytest, httpx, ruff.

| File | Role |
| --- | --- |
| `app/main.py` | App, `GET /health`, `GET /api/capabilities`, error handlers |
| `app/config.py` | Settings from `api/.env`; key held as `SecretStr` |
| `app/http.py` | Request guards, §8.3 error envelope, single inference slot |
| `app/schemas.py` | Request/response contracts, limits, model-output verification |
| `app/openrouter.py` | Provider call, retry/repair budget, error mapping |
| `app/routes/mapping.py` | `POST /api/map` (§7.2 prompt) |
| `app/routes/suggestions.py` | `POST /api/suggest` (§7.3 prompt) |
| `app/__main__.py` | `uv run python -m app` dev server |
| `README.md`, `.env.example` | Setup, commands, smoke test |

What it enforces:

- **Trust boundary:** Host must be `127.0.0.1` or `localhost` on the API port. Origin, when
  present, must be the frontend. Content type must be JSON. The 64 KiB body cap is checked
  before parsing, including on streamed bodies. Validation errors name fields, never values.
- **Request bounds:** at most 5 Source A rows, 5 candidates per row, and 5 samples per side.
  Cells are capped at 2,048 characters. Unknown fields are rejected.
- **Inference budget:** one request at a time (a second gets 409 `BUSY`), 45 s deadline,
  at most 3 provider attempts with at most 1 schema repair, `max_tokens` 2000, temperature 0.
  SDK retries are off. Retry-After is honored only if it fits in the deadline.
- **Strict output:** requests use a strict JSON schema and
  `provider.require_parameters=true`, so OpenRouter refuses rather than routing to a provider
  that ignores the schema. No fallback model and no downgrade.
- **Verification of model output** (no retry on failure; returns 502 `MODEL_INVALID_OUTPUT`):
  unknown row IDs, invented candidates, duplicate or missing results, nonexistent columns,
  altered evidence values, one-sided evidence, and inconsistent abstention.
- **Echoes:** `requestId`, `generation` and (for suggest) `configurationHash`, on the response
  and on each proposal.
- **Secrets and data:** the key never reaches the frontend, logs or error messages. Logs record
  route, request ID, outcome, attempts, duration, model and token counts, never cell contents.
  A missing key does not stop startup; inference returns 503 `NOT_CONFIGURED`.

### Frontend (`web/`)

- `web/next.config.ts`: added only a `rewrites()` entry sending `/api/*` to
  `ACCORD_API_ORIGIN` (default `http://127.0.0.1:8000`). Same-origin, so no CORS.
- No UI work yet. The app still renders the starter page.

## Verification

| Check | Result |
| --- | --- |
| `uv run pytest -q` | 35 passed, provider mocked, no network |
| `uv run ruff check .` / `ruff format --check .` | Clean |
| `npm run lint`, `tsc --noEmit` (web) | Clean |
| `/health`, `/api/capabilities`, `/docs`, `/openapi.json` on a running server | 200 |
| `/api/capabilities` and `/api/map` through the Next proxy on :3000 | Proxied; Host/Origin guard passed |
| `git check-ignore api/.env` | Ignored |
| Live OpenRouter request | **Not run** |

## Open items

1. **Live smoke test.** Run the `curl` in `api/README.md` once to confirm the configured model
   (`google/gemma-4-31b-it:free`) returns verified proposals. It uses the OpenRouter quota, so it
   waits for an explicit go-ahead.
2. **Strict-schema support is unknown** for that free model. If it lacks it, the API returns
   502 `UPSTREAM_ERROR` saying so, and a different model must be chosen in `.env`.
3. **Error-classification heuristic.** A provider error mentioning "parameter" is reported as
   missing strict-schema support. The live run will show whether OpenRouter's wording matches.
4. **Frontend.** The upload, mapping, review and export UI from the spec is not built. Nothing
   calls the API yet.
5. **Nothing is committed.** All work is untracked on `main`.

## Running locally

```sh
# terminal 1
cd api && uv sync && uv run python -m app      # http://127.0.0.1:8000/docs

# terminal 2
cd web && npm run dev                          # http://localhost:3000
```
