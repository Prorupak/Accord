# Accord progress

Last updated: 2026-10-15

## Phase 03-II (2026-10-15): AI orchestration for `/api/suggest`

Done. The browser can now run a bounded, verified semantic-suggestion pass. Design notes are in
`docs/ai-orchestration.md`. There is still no UI; Phase 03-III consumes `useSuggestAnalysis`.

- **New `web/src/analysis/`:**
  - `contract.ts`: strict Zod schemas that mirror the Pydantic models, the limits, and the typed failure taxonomy.
  - `request.ts`: a pure request builder with a UTF-8 byte cap.
  - `response.ts`: validation against the frozen request.
  - `runner.ts`: a sequential runner with one request in flight, at most four requests and 20 rows, a 4-minute deadline, `AbortController` and idempotent cancel.
  - `useSuggestAnalysis.ts`: a React adapter that starts each committed run exactly once and is safe under Strict Mode.
- **Domain changes:**
  - New `domain/aiContext.ts`, which clips AI context to 160 code points as specified in §7.4.
  - `proposalDefect` now does three new things:
    - It compares evidence with the clipped value the model saw.
    - It allows an abstention to cite competing Source B rows. This was a gap: the API accepted such abstentions, but the engine counted the row as failed.
    - It fails closed with a new `truncated_context` reason when a suggestion rests on clipped identity text.
  - `unresolvedReason` now checks `no_candidates` before the run-level cancelled or failed reasons.
- **Reducer change:** `analysis/completed` ignores unsent rows that have no candidates left, which happens when a human resolved them mid-run. Such a run now ends `complete` instead of `partial`.
- **Contract drift tests:**
  - Shared fixtures live in `fixtures/contracts/suggest/`.
  - They are checked by `api/tests/test_contract_fixtures.py` and by `web/src/analysis/contract.test.ts`.
  - The backend app code is unchanged. The only API change is the new test file.

| Check (run 2026-10-15) | Result |
| --- | --- |
| `pnpm test` (web) | 17 files, 300 tests passed (233 existing, 62 analysis, 5 domain/reducer regressions) |
| `npx tsc --noEmit` (web) | Clean |
| `pnpm lint` (web) | Clean |
| `pnpm build` (web) | Succeeded |
| `uv run pytest -q` (api) | 41 passed (35 existing, 6 contract fixtures) |
| `uv run ruff check .` / `ruff format --check .` | Clean |

**Live provider check: failed.** One authorized request was sent: the `api/README.md` smoke
payload, posted directly to `127.0.0.1:8000/api/suggest`. The API on that port was the
already-running local dev server, configured with `google/gemma-4-31b-it:free`. The result:

- **Response:** 502 `UPSTREAM_ERROR`: "The configured model is unavailable or has no endpoint supporting strict JSON schema output." `retryable: false`.
- **Not verified:** whether strict structured output works with this model. Because no successful response came back, there were no proposals, abstentions, usage or model metadata, and the Pydantic `SuggestResponse` path was not exercised.
- **Client validation:** the real error body passed `apiErrorSchema`. `readSuggestResponse` classified it as `UPSTREAM_ERROR`, run-scoped, not retryable, with no metadata.
- **Next step:** choose a model with an OpenRouter endpoint that supports strict `json_schema` in `api/.env`, then rerun the smoke test. The server's message cannot tell a 404 apart from a "parameter" rejection (Phase 01 open item 3).

Still open: Phase 03-III (export lifecycle, Blob URLs, downloads and the working UI), a model
that passes the live check, and the evaluation harness.

## Phase 03-I (2026-10-15): workflow state and reducer

Done. The browser-side workflow state machine is built in `web/src/workflow/` (design notes in
`docs/workflow-state.md`). It wraps the domain engine without duplicating its policy. The UI does
not use it yet, and nothing calls the API.

- **State:** one `WorkflowState` holding the stage, both sources (each with a pending import
  token), the draft mapping, `reconciliation` (null until mappings are confirmed) and a display
  error. Counts, statuses and progress are derived by selectors.
- **Reducer:** pure, with an exhaustive action union and no generic setters.
  - Imports are token-guarded, so a slower earlier file cannot overwrite a newer one.
  - Replacing or clearing a source drops the confirmation, decisions, proposals and any run,
    and keeps the other source.
  - Confirmation re-validates the current draft and datasets against what was hashed.
  - Every decision goes through `applyDecision`.
  - Analysis start, batch, batch failure, completion, cancellation and failure are guarded by
    status, generation and configuration hash. Terminal transitions advance the generation.
- **Hook:** `useAccordWorkflow` owns one `useReducer`. It creates tokens, decision IDs and
  timestamps, and it runs parsing and hashing outside the reducer.
- **Domain changes:**
  - New `proposalIdOf` helper.
  - Bug fix: `addProposals` no longer drops and re-adds a proposal when the same batch is
    replayed. Before, the replay bumped revision with no change. There is a regression test.
- **Web change:** added the dev dependency `jsdom` 30.1.3, for the hook test only.
- **Deviation:** spec §5.3 puts the reducer under `src/app/`. It lives in `web/src/workflow/`
  instead, next to `web/src/domain/`, because `web/app/` is the Next.js route directory.

| Check (run 2026-10-15) | Result |
| --- | --- |
| `pnpm test` (web) | 12 files, 233 tests passed (174 existing, 1 domain regression, 58 workflow) |
| `npx tsc --noEmit` (web) | Clean |
| `pnpm lint` (web) | Clean |
| `pnpm build` (web) | Succeeded |
| Backend | Unchanged; not re-run |

Still open: 03-II (AI orchestration: the `/api/suggest` request builder, Zod response schema,
context clipping, batching, retries and `AbortController`) and 03-III (export lifecycle, Blob URLs,
downloads and the working UI).

## Phase 02 (2026-10-15): deterministic reconciliation engine

The browser-side domain engine is now built in `web/src/domain/` (design notes in
`docs/domain-engine.md`). It has no UI wiring yet, and it does not call the API.

- **CSV ingestion:** strict parsing (§4.1).
  - SHA-256 over the original bytes, fatal UTF-8 decoding, BOM handling.
  - Positional columns, side-qualified row IDs, blank-record counting.
  - Typed errors that never include cell values.
- **Mapping and configuration:** validation, and a fixed-tuple configuration hash.
- **Exact-ID matching:**
  - Duplicate-ID quarantine applied on both sides.
  - A single eligibility policy (`checkPair`) shared by every matching path.
- **Candidates:** lexical retrieval (NFKC, case fold, token-set Jaccard; top five; ties broken by B index) plus a manual-picker set.
- **Quantities:** BigInt arithmetic in thousandths, with unit rules (§4.6).
- **Decisions:** accept, reject, defer, exclude-exact and undo, plus proposal intake with generation and hash guards.
- **Invariants:** an invariant checker, with export blocked whenever a check fails.
- **Export and replay:**
  - `matches.csv`, `unresolved.csv` and `audit.json` built from one revision, with formula protection.
  - A pure `replayAudit`.
- **Fixtures:** `fixtures/inventory/source-{a,b}.csv` (spec §13.1).
- **Web changes:**
  - Added dependencies, at exact versions: `papaparse` 5.7.0, `zod` 4.6.7, `@types/papaparse` 5.5.2, `vitest` 5.0.4.
  - Added a `test` script.
  - Raised the `tsconfig` target from ES2017 to ES2020, which BigInt literals and Unicode property regexes require.
- **Audit schema:** the only addition is three row-ID lists in `audit.analysis`. See `domain-engine.md`.

| Check (run 2026-10-15) | Result |
| --- | --- |
| `pnpm test` (web) | 8 files, 174 tests passed |
| `npx tsc --noEmit` (web) | Clean |
| `pnpm lint` (web) | Clean |
| `pnpm build` (web) | Succeeded |
| `uv run pytest -q` (api, unchanged) | 35 passed |
| `uv run ruff check .` / `ruff format --check .` | Clean |

The canonical fixture integration test passes. It produces 3 accepted pairs (P01 and P03 by ID, plus tote/bag by an injected manual decision), 1 unmatched A row, 2 unmatched B rows and a P03 delta of `-1`. Replaying the serialized audit reproduces both CSVs byte for byte.

Still open: the workflow reducer and UI, the `/api/suggest` request builder and client-side response schema, AI-context clipping, cancellation orchestration, browser downloads, the eval harness, and live inference.

The phase 01 report below is kept as written, except for item 5 under Open items.

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
5. ~~Nothing is committed.~~ Superseded: phase 01 was merged to `develop` in PR #1.

## Running locally

```sh
# terminal 1
cd api && uv sync && uv run python -m app      # http://127.0.0.1:8000/docs

# terminal 2
cd web && pnpm dev                          # http://localhost:3000
```
