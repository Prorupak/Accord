## Problem

<!-- What is wrong or missing? Link the issue: Closes #123 -->

## Changes

<!-- What this PR changes, briefly. -->

## Screenshots

<!-- UI changes only: before/after of the affected screen. Otherwise write N/A. -->

## Testing

<!-- Commands you ran and their results. Mark items that don't apply as N/A. -->

- [ ] `web`: `pnpm exec next typegen && pnpm exec tsc --noEmit && pnpm lint && pnpm test && pnpm build`
- [ ] `api`: `uv run ruff check . && uv run ruff format --check . && uv run pytest -q`
- [ ] `e2e`: `pnpm e2e`
- [ ] `docker`: `docker compose up -d --build --wait && scripts/docker-smoke.sh`

## Invariants and contracts

<!-- Does this touch web/src/domain/, the API contract (schemas.py / contract.ts),
     fixtures/contracts/, http.py or the CI workflow? Say what and how it is tested, or N/A. -->

## Checklist

- [ ] Test data is synthetic. No real inventory, customer data, keys or `.env` files.
- [ ] AI output still needs an explicit user action, and a failed or invalid model response is never shown as success.
- [ ] Docs (`README.md`, `docs/`, `CHANGELOG.md`) are updated if behaviour changed.
