Shared `/api/suggest` contract fixtures. `api/tests/test_contract_fixtures.py` checks them against
the Pydantic models and `web/src/analysis/contract.test.ts` against the Zod schemas, so a change
to either side's contract fails a test on that side. Status codes per error code are in
`docs/ai-orchestration.md`.
