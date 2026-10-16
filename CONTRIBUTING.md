# Contributing to Accord

Thanks for helping. Small, focused pull requests are easiest to review and merge.

You do not need an OpenRouter key or any paid credits. Every test stubs the AI provider. Without a
key, the app still runs and the AI buttons report `NOT_CONFIGURED`.

## Before you start

- Read `README.md` (what Accord does, and the decision boundary) and `docs/progress.md` (what is
  built and what is open).
- `docs/accord-implementation-spec.md` is the source of truth. Code and docs cite it as `§N`.
- For anything larger than a bug fix, open an issue first so we can agree on scope.

## Setup

Requirements: Node 24, pnpm 10 (the lockfile is pnpm), Python 3.13 and
[uv](https://docs.astral.sh/uv/). Docker with Compose v2 is optional.

```sh
# web
cd web
pnpm install --frozen-lockfile
pnpm dev                          # http://localhost:3000

# api (only needed for the AI buttons)
cd api
uv sync --locked
cp .env.example .env              # optional; leave the key empty to work without AI
uv run python -m app              # http://127.0.0.1:8000/docs
```

Or run both in containers: `docker compose up -d --build` (see `docs/docker.md`).

## Checks

CI runs four jobs on every pull request. Run the same commands locally:

| Job | Commands |
| --- | --- |
| `web` | `cd web && pnpm exec next typegen && pnpm exec tsc --noEmit && pnpm lint && pnpm test && pnpm build` |
| `api` | `cd api && uv run ruff check . && uv run ruff format --check . && uv run pytest -q` |
| `e2e` | `cd web && pnpm exec playwright install chromium` (once), then `pnpm e2e` |
| `docker` | `docker compose up -d --build --wait && scripts/docker-smoke.sh; docker compose down` |

Do not skip, weaken or delete a test to get a green check. If a test is wrong, say why in the PR.

## Branches and commits

- Branch from `develop` and open the PR against `develop`. Use the prefixes `feat/`, `fix/`,
  `docs/`, `test/` and `ci/`.
- Keep one topic per PR. Separate refactors from behaviour changes.
- Commit messages are short and imperative. A scope prefix helps but nothing enforces it:
  `fix(web): keep selection after Accept pair`, `docs: clarify Docker setup`.
- Pull requests are squash-merged.

## Test data

- Only use synthetic data. Never commit a real inventory export, customer data or anything
  copied from a production system, even with names changed.
- Inventory samples live in `fixtures/inventory/`. The prerendered home page and the Docker
  smoke test read `source-a.csv` and `source-b.csv`, so changing them changes those checks.
- Shared API contract fixtures live in `fixtures/contracts/`. Both `api/tests/test_contract_fixtures.py`
  and `web/src/analysis/contract.test.ts` read them. A contract change needs both sides updated in
  the same PR.
- Tests must be deterministic: no network access and no live model calls.

## The proposal and approval boundary

The model proposes and a person decides (see "Decision boundary" in `README.md`). A change must
not:

- apply an AI mapping draft or suggestion without an explicit user action;
- treat a failed, partial or unverifiable model response as success, or invent a fallback result;
- pair rows that `checkPair` rejects (in `web/src/domain/`);
- move parsing, matching state, decisions or exports to the API, or make the API store data.

## High-risk areas

Changes here need tests that show the behaviour, and a note in the PR:

- `web/src/domain/`: parsing, identity, eligibility, quantities, invariants, export and audit replay.
- `web/src/analysis/contract.ts` and `api/app/schemas.py`: the request/response contract, limits
  and model-output verification. They must agree, and `fixtures/contracts/` tests both.
- `api/app/http.py`: the Host/Origin/body-size trust boundary and the single inference slot.
- `api/app/openrouter.py`: the retry/repair budget and error mapping.
- `.github/workflows/`: CI must never use `pull_request_target`, secrets or live model calls.

## Secrets

Never commit `api/.env`, keys, tokens or logs that contain cell values. `.gitignore` excludes
`.env` files. If you commit a secret by mistake, tell the maintainer privately (see `SECURITY.md`)
and rotate it. Deleting it in a later commit is not enough.

## Conduct

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
