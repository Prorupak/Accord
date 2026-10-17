# ADR-0002 — Persist immutable AuditV1 snapshots, not duplicated row tables

- **Status:** Proposed (accept before implementation)
- **Date:** 2026-10-17

## Context

`prepareExport` already produces a validated `AuditV1` with two parsed source datasets, confirmed mapping, proposal evidence, decisions and final row accounting. `replayAudit` verifies semantic consistency but currently does not reconstruct application state. Separate mutable tables for each record and pairing would introduce a second state machine and replay divergence.

## Decision

Store one immutable AuditV1 JSONB payload per explicit successful save, plus project version, idempotency key, creation time and configuration metadata. Use the same invariant/replay validator server-side. Implement a validated state-restoration adapter sharing replay internals. Keep public export schema v1 unchanged. Enforce max request size, version CAS and transactional unique constraints.

## Consequences

Pros: preserves determinism, complete history, minimal initial schema, traceability and exact CSV comparison.

Costs: full snapshots duplicate source rows, project list must avoid fetching blobs, DB volume contains private inventory data, JSONB isn't ideal for cross-record queries. Audit has no raw CSV bytes; dataset hashes cannot be independently recomputed from reopened snapshots. `audit.revision` is a domain counter separate from database `Project.version`.

## Alternatives deferred

Normalized dataset/row/decision tables, reusable file objects, event-sourcing from scratch, cloud object storage, incremental delta snapshots. Add only after a concrete query/scale requirement.

## Validation before acceptance

Replay of fixtures, tamper rejection, save race, idempotent retry, restore partial/failed/AI-reviewed cases, no automatic file upload.
