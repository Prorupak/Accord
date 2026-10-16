# Accord — Technical Recommendations

**Status:** Architecture locked · **Updated:** 15 October 2026  
**Purpose:** A concise implementation reference for Accord v1.  
**Priority:** Ship a correct, demonstrable CSV reconciliation workflow—not a general spreadsheet platform.

## 1. Final recommendation

Use **one Git repository with two independently runnable applications**:

- **`web/`** — Next.js App Router + TypeScript; browser-owned import, reconciliation, review, and exports.
- **`api/`** — Python + FastAPI; bounded, validated AI inference via OpenRouter.

This is a small monorepo. **Do not split it into two repositories**, introduce Turborepo/Nx, or add an extra internal API between Next.js and FastAPI. Both services can be deployed independently later if necessary.

The governing rule is **AI proposes; deterministic code verifies; the user approves.** No model suggestion becomes a match automatically.

## 2. Locked minimal stack

| Responsibility | Choice | Notes |
| --- | --- | --- |
| User interface | Next.js App Router, React, TypeScript | Keep existing initialized application. |
| Styling | Tailwind CSS + CSS variables | Editorial visual language; avoid a large custom component library. |
| UI controls | shadcn/ui components as needed + Lucide | Install only the components actually used. |
| Motion | CSS transitions | No GSAP requirement in v1. Respect reduced motion. |
| Domain engine | Plain TypeScript in `web/src/domain/` | Framework-independent, deterministic and unit-tested. |
| CSV import/export | Papa Parse | Parse in the browser; preserve source strings. |
| Client contracts | Zod | Preserve existing schemas and domain invariants. |
| Python API | FastAPI | Only inference and capabilities/health endpoints. |
| API contracts/settings | Pydantic v2 + pydantic-settings | Reject invalid inputs and unsupported model outputs. |
| Model access | OpenRouter + OpenAI Python SDK | One configured model, no silent fallback. |
| Python runtime/packages | Python 3.13 + uv | Existing setup; commit `uv.lock`. |
| Web tests | Vitest; Playwright for E2E | Add browser E2E in the workflow phase. |
| API tests | pytest + httpx | Mock provider calls; keep live smoke test opt-in. |
| Database, queue, auth | None | Not required for v1. |
| Deployment | Local-first | A static case-study page can be hosted separately. |

**Model selection:** Set `OPENROUTER_MODEL` to a currently available free model that actually supports the required structured-output contract. The documented local configuration previously selected `google/gemma-4-31b-it:free`, but **live compatibility has not been verified**. Availability, free quotas, and schema support must be tested; never assume a `:free` suffix guarantees structured output.

## 3. Repository shape

```text
accord/
├── web/
│   ├── src/app/                 # Next.js routes/UI
│   ├── src/components/          # Screens and controls
│   ├── src/domain/              # Existing reconciliation engine
│   └── src/lib/                 # API client and helpers
├── api/
│   ├── app/main.py             # FastAPI app, health/capabilities
│   ├── app/config.py           # Validated settings
│   ├── app/http.py             # Request guards / error envelope
│   ├── app/schemas.py          # Pydantic contracts
│   ├── app/openrouter.py       # Model provider integration
│   ├── app/routes/             # mapping.py, suggestions.py
│   ├── tests/
│   ├── pyproject.toml
│   └── uv.lock
├── fixtures/
├── docs/
├── accord-implementation-spec.md
└── README.md
```

Adapt to files actually present; don't create duplicate modules or reorganize existing working code for aesthetic reasons.

## 4. Responsibilities and data flow

```text
Two local CSV files
        │
        ▼
Next.js/browser: parse and validate, hash originals, map columns
        │
        ├──► FastAPI POST /api/map ──► OpenRouter ──► validated mapping drafts
        │
        ▼
Browser: confirm mapping → exact-ID matching → candidate generation
        │
        ├──► FastAPI POST /api/suggest ──► OpenRouter ──► validated proposals
        │
        ▼
Browser: revalidate references → user accepts/rejects/defers/undoes
        │
        ▼
Browser: invariant checks + frozen snapshot
        │
        ▼
 matches.csv · unresolved.csv · audit.json
```

The browser owns original files, authoritative state, eligibility policy, exact quantity arithmetic, and final exports. The API receives **only bounded, necessary fields** (not complete source files) and owns the key, provider calls, limits, and response validation.

### API surface

| Endpoint | Responsibility |
| --- | --- |
| `GET /health` | Local liveness check. |
| `GET /api/capabilities` | Non-sensitive inference configuration/limits. |
| `POST /api/map` | Suggest column mappings from headers and limited samples. |
| `POST /api/suggest` | Select from supplied candidate IDs or abstain. |

Connect Next.js to the loopback API through the **existing rewrite** using `ACCORD_API_ORIGIN`. Do not add duplicate Next.js route handlers for these endpoint paths. Store OpenRouter credentials exclusively in `api/.env`, which must be Git-ignored.

## 5. Non-negotiable product rules

1. Exactly two UTF-8 comma-delimited CSVs; at most 256 KiB, 200 data rows and 12 columns per file in v1.
2. Preserve source strings, original byte hashes, leading-zero IDs, side-qualified row IDs and source order.
3. Only unique, normalized identical nonempty IDs may pair automatically; duplicate IDs quarantine affected rows; conflicting nonempty IDs cannot pair.
4. Semantic candidate generation uses positive token-set Jaccard similarity, at most five candidates per row. **Do not silently substitute RapidFuzz, embeddings, vector search or an LLM retriever.**
5. At most 20 Source A rows per AI analysis pass, sent sequentially in batches of up to five.
6. Each semantic/manual pair needs explicit user acceptance and is rechecked against one-to-one and ID policies at decision time.
7. Quantity comparison uses exact `BigInt` thousandths, **delta = Source B minus Source A**, with explicit unit rules. Missing/invalid quantities are not zero.
8. Reject unknown model IDs, nonexistent evidence, altered cited values, missing coverage, and stale generation/configuration results.
9. One frozen revision produces `matches.csv`, `unresolved.csv`, and `audit.json`. Every source row is accounted for and CSV formula risks are protected.
10. Failures, cancellation, abstentions, incomplete analysis, and unresolved rows remain visible. Never simulate live AI results.

See `accord-implementation-spec.md` §§2, 4, 6–10 and `docs/domain-engine.md` for detailed contracts and edge cases.

## 6. Security and cost controls

- API binds to `127.0.0.1:8000` for local development; Next.js runs at `localhost:3000`.
- Validate Host/Origin, JSON content type, and a **64 KiB** body cap. Avoid wildcard CORS.
- Allow one active inference request per local API instance; use a **45-second** deadline and at most three provider attempts including one schema repair.
- Preserve strict structured-output requirements; do not auto-switch models, paid tiers, or silently downgrade validation.
- Never log API keys or raw inventory cell values, and never place secrets in `NEXT_PUBLIC_*` variables.
- No database, file storage, hosted arbitrary-file inference, analytics, LangChain, Celery, Redis, Docker, or background jobs for v1.
- Run one deliberate real-model smoke test to verify schema support and record actual results; mocked tests cannot establish real model compatibility.

## 7. Current documented implementation status

Based on `progress.md` dated **15 October 2026** (not an independent inspection of the live repository):

**Implemented**
- FastAPI backend, Next.js dev proxy, strict request/response verification, provider adapter and 35 mocked API tests.
- Browser-side deterministic engine: CSV parsing, mapping/configuration, exact-ID and candidate policies, exact arithmetic, decision operations, invariants, three exports, and pure audit replay.
- 174 web domain tests reported passing; TypeScript, lint, build, and Python quality checks reported clean.
- Canonical fixture reportedly yields three accepted pairs after an injected manual decision, one unmatched A row, two unmatched B rows and a `-1` quantity delta.

**Not yet implemented/verified in that report**
- The React workflow reducer and actual import → map → review → export UI.
- The suggestion-request builder, client-side response schema, context clipping, cancellation orchestration and browser download controls.
- Browser E2E tests, evaluation harness, and a confirmed **live OpenRouter request**.

These are **reported results**, not a claim that the current checkout has been retested.

## 8. Recommended next implementation order

1. **Confirm clean repository state** and ensure no secrets are staged. Preserve working phase 01/02 code; do not regenerate the backend or domain engine.
2. **Verify one real OpenRouter request** with the configured free model. Record strict schema support, latency, provider errors and returned token usage (if supplied). Change the model only with an explicit, tested configuration update.
3. **Build the browser workflow wiring** around existing pure domain functions: import, mapping drafts/confirmation, exact results and derived counts.
4. **Integrate `/api/suggest`** with bounded request builders, client-side validation, generation/hash guards, cancellation and real progress accounting.
5. **Build review and export UI**: side-by-side original evidence, accept/reject/defer/undo, manual eligible row picker, partial-run warnings and three real Blob downloads.
6. **Run end-to-end verification and evaluations**: canonical fixtures, ambiguity, duplicates, stale responses, export partitions, audit replay, keyboard/mobile behavior and measured suggestion quality.
7. **Polish the editorial presentation** only after one real input-to-export vertical slice works. Record actual behavior for the portfolio case study.

### Immediate milestone

> Import both bundled CSVs → confirm mappings → show exact matches and a quantity difference → request live semantic suggestions → approve a pair → download all three correct artifacts.

Keep the UI based on the product specification: off-white/near-black/blue typography, table-first review, restrained CSS motion, visible evidence and explicit statuses. No chatbot panel, decorative dashboards or new logo exercise.

## 9. Local commands

```bash
# Terminal 1 — FastAPI
cd api
uv sync
uv run python -m app

# Terminal 2 — Next.js
cd web
pnpm install
pnpm dev

# Backend verification
cd api
uv run pytest -q
uv run ruff check .
uv run ruff format --check .

# Frontend verification
cd web
pnpm test
pnpm lint
pnpm exec tsc --noEmit
pnpm build
```

- Next.js: `http://localhost:3000`
- FastAPI docs: `http://127.0.0.1:8000/docs`
- Keep credentials in `api/.env`; use `api/.env.example` as the committed template.

## 10. Sources of truth and change policy

1. Current user request.
2. `accord-implementation-spec.md` — authoritative v1 product behavior, contracts, UX, invariants and limits.
3. `docs/domain-engine.md` — documented implemented TypeScript domain behavior and deliberate deviations.
4. `progress.md` — reported milestone status and verification (confirm against the actual repo).
5. **This recommendation** — chosen Next.js/FastAPI/OpenRouter architecture and implementation sequence; it supersedes only the spec's original Node/Express backend decision.

When documents disagree, preserve the specification's domain invariants and explicitly document any intended change. Prefer minimal modifications to working code. Do not broaden v1 scope to improve perceived architectural sophistication.
