# Changelog

All notable changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). No version has been released yet;
detailed phase notes are in `docs/progress.md`.

## [Unreleased]

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
