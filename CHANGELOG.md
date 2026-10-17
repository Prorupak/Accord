# Changelog

All notable changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Detailed phase notes are in
`docs/progress.md`.

## [Unreleased]

### Changed

- Only `/api/map`, `/api/suggest` and `/api/capabilities` are routed to FastAPI, in both
  `web/next.config.ts` and `vercel.json`. Every other `/api/*` path is now handled by Next.js
  (currently a 404), reserving it for the planned auth and project routes. Inference contracts
  are unchanged.

## [0.1.0] - 2026-10-16

### Added

- FastAPI inference API with two bounded endpoints, `POST /api/map` and `POST /api/suggest`,
  with request guards, strict-schema provider calls and verification of model output.
- Deterministic reconciliation engine in the browser: CSV parsing, exact product-ID matching,
  eligibility, exact quantity arithmetic, invariants, export snapshot and audit replay.
- Workflow state, AI orchestration for suggestions, and the import, mapping, review and export
  screens.
- Editorial design system and redesigned import, mapping, review and export screens.
- Docker images and Compose for local integration, with a smoke test that makes no provider calls.
- GitHub Actions CI (`web`, `api`, `e2e`, `docker`), Dependabot, and community and security docs.
- Vercel deployment config for the `web` and `api` services. The API host/origin guard trusts
  the hostnames Vercel provides.
- Rate limits on `/api/map` (6/min) and `/api/suggest` (12/min) and a daily budget of 30 provider
  attempts, retries and repairs included. Over a limit the API returns 429 `RATE_LIMITED` with
  `Retry-After`. Uvicorn runs without proxy-header trust.

### Known limitations

- Rate limits, the daily budget and the single inference slot are in memory per instance. A
  restart resets them and separate instances do not share them. See `docs/edge-protection.md`.
- Limits are shared buckets, not per client, and the UI has no specific message for a
  server-side 429.
- Mapping does not state what is sent to the AI provider. The caption is commented out and the
  button's `aria-describedby="ai-disclosure"` points at nothing.
- Import no longer shows the session-privacy note (a departure from spec §11.7).

[Unreleased]: https://github.com/Prorupak/Accord/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Prorupak/Accord/releases/tag/v0.1.0
