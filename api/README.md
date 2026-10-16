# Accord API

FastAPI backend for Accord's two bounded inference operations: column mapping drafts and
candidate suggestions (spec §7–8). It holds the OpenRouter credentials, enforces the request
limits, and checks every model response against the original request before returning it.
It never accepts a match, stores data, or touches exports. Those belong to the browser.

## Setup

Requires [uv](https://docs.astral.sh/uv/). uv installs the pinned Python version (3.13) itself.

```sh
cd api
uv sync                       # install dependencies from uv.lock
cp .env.example .env          # then set OPENROUTER_API_KEY and OPENROUTER_MODEL
```

`OPENROUTER_MODEL` has no default. Choose one that supports structured outputs
(`response_format` with a strict JSON schema). The API sends `provider.require_parameters=true`,
so OpenRouter refuses rather than routing to a provider that would ignore the schema. That
refusal comes back as `502 UPSTREAM_ERROR` ("…no endpoint supporting strict JSON schema output").
There is no fallback model.

The server starts without a key. `/api/map` and `/api/suggest` then return
`503 NOT_CONFIGURED`.

## Commands

```sh
uv run python -m app                    # dev server on API_HOST:API_PORT (127.0.0.1:8000), reload on
uv run pytest -q                        # tests; the provider is mocked, so no network or credits are used
uv run ruff check . && uv run ruff format --check .
```

OpenAPI docs: <http://127.0.0.1:8000/docs> (raw schema at `/openapi.json`).

### Running with Next.js

Use two terminals:

```sh
cd api && uv run python -m app
cd web && npm run dev
```

`web/next.config.ts` rewrites `/api/*` to the FastAPI server (`ACCORD_API_ORIGIN`, default
`http://127.0.0.1:8000`). UI code calls `/api/map`, `/api/suggest` and `/api/capabilities` on
its own origin, so no CORS is configured.

## Endpoints

| Method/path             | Behavior                                                                 |
| ----------------------- | ------------------------------------------------------------------------ |
| `GET /health`           | `{"status":"ok","service":"accord-api"}`                                 |
| `GET /api/capabilities` | `configured`, provider label, model ID, limits. Never the key.           |
| `POST /api/map`         | Headers + ≤5 sample rows per side → draft mappings (nullable) + reasons  |
| `POST /api/suggest`     | ≤5 Source A rows × ≤5 candidates → suggest/abstain proposals + evidence  |

Responses echo `requestId` and `generation`. `/api/suggest` also echoes `configurationHash`, at
the top level and on each proposal. `meta` reports provider, actual model, prompt version,
duration, attempts and provider-reported token usage (`null` when the provider reports none).

### Verification of model output

The model's output is validated with Pydantic and then checked against the request:

- **Mapping:** every column ID must exist on its side, and no column may be used for two
  fields. An uncertain `name` or `quantity` stays `null`.
- **Suggest:** there must be exactly one result per requested row, with no unknown or
  duplicate rows. The candidate must be one supplied for that row. Every evidence reference
  must point to a supplied field, and its value must match that field exactly. A `suggest`
  needs evidence from both rows and the `semantic_equivalence` reason. An `abstain` needs
  `rightId: null` and an abstention reason.

What happens on a failure:

- **Schema or format failure:** one repair attempt.
- **Reference or evidence failure:** no retry. Returns `502 MODEL_INVALID_OUTPUT`.

### Limits and errors

- Request body: 64 KiB, checked before parsing.
- Inference: one request at a time per server. A concurrent request gets 409 `BUSY`. If the client
  disconnects (the UI's Cancel), the provider call is cancelled and the slot is freed at once.
- Time: 45 s overall deadline.
- Provider attempts: at most 3, shared between retries and repair. At most one of them is a
  repair. SDK retries are disabled.
- Output: `max_tokens` 2000.

Requests must have `Content-Type: application/json`, a Host of `127.0.0.1:<port>` or
`localhost:<port>` (plus `API_INTERNAL_HOST:<port>` when set, which Docker Compose does for the
service name `api`), and, if an `Origin` header is present, `FRONTEND_ORIGIN` as its value.

Errors use the spec §8.3 envelope `{"error":{code,message,retryable,requestId,retryAfterSeconds?}}`:

| Status | Code |
| --- | --- |
| 400 | `INVALID_INPUT` (415 for content type, 403 for origin) |
| 413 | `PAYLOAD_TOO_LARGE` |
| 409 | `BUSY` |
| 503 | `NOT_CONFIGURED` |
| 429 | `RATE_LIMITED` |
| 502 | `MODEL_INVALID_OUTPUT` / `UPSTREAM_ERROR` |
| 504 | `TIMEOUT` |

Provider messages and stack traces are never forwarded. Logs record request ID, outcome,
attempts, duration, token counts, per-attempt finish reason and length, and the reason for any
schema or verification failure (IDs only), never cell contents. For local debugging only, set
`LOG_MODEL_OUTPUT=true` to also log the raw model output. That output **contains cell values**,
so it is off by default. In `pnpm dev`, the browser console shows `[accord]` lines with each
`/api/map` and `/api/suggest` response and the reason for any client-side rejection.

## Live smoke test (opt-in, makes one real request)

Run this only after configuring `.env`. It sends the spec §13.1 tote and travel-cup rows to
your configured model, which uses your OpenRouter quota:

```sh
curl -s http://127.0.0.1:8000/api/suggest -H 'content-type: application/json' -d '{
  "requestId":"smoke-1","generation":1,"configurationHash":"smoke",
  "rows":[
    {"left":{"rowId":"A:x:1","fields":[{"side":"A","rowId":"A:x:1","columnId":"c1","value":"Organic cotton tote natural"}]},
     "candidates":[{"rowId":"B:y:1","fields":[{"side":"B","rowId":"B:y:1","columnId":"c1","value":"Natural cotton shopping bag"}]}]},
    {"left":{"rowId":"A:x:3","fields":[{"side":"A","rowId":"A:x:3","columnId":"c1","value":"Travel cup blue"}]},
     "candidates":[{"rowId":"B:y:3","fields":[{"side":"B","rowId":"B:y:3","columnId":"c1","value":"Travel tumbler blue 350ml"}]},
                   {"rowId":"B:y:4","fields":[{"side":"B","rowId":"B:y:4","columnId":"c1","value":"Travel tumbler blue 500ml"}]}]}
  ]}' | python3 -m json.tool
```

Expected: a `200` with verified proposals, where the travel cup should abstain. The other
honest outcome is an error envelope that says why, for example that the model lacks strict
schema support.
