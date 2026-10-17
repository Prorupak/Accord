---
name: accord-persistence-review
description: Use when designing, implementing, debugging, or reviewing Accord's PostgreSQL snapshot persistence, audit replay, restore adapter, idempotent saves, optimistic concurrency, Prisma migrations, or database integrity. Ensure saved state cannot bypass deterministic matching rules.
---

# Accord persistence and replay correctness

## Required reading

1. `docs/phase-05/persistence-contract.md`, `docs/phase-05/data-model.md`, `docs/phase-05/decisions/0002-audit-snapshots.md`.
2. Current `web/src/domain/auditReplay.ts`, `web/src/domain/exportSnapshot.ts`, `web/src/domain/reconcile.ts`, `web/src/workflow/workflowReducer.ts`, `web/src/ui/useExportArtifacts.ts`.
3. Existing `docs/domain-engine.md`, `docs/workflow-state.md`, `docs/ai-orchestration.md` and `docs/phase-05/verification-matrix.md`.

## Mandatory code review checks

- Separate `Project.version` (CAS) from `audit.revision` (domain).
- Persist only a full frozen, invariant-checked `AuditV1` created by `prepareExport`.
- Server validates saved audits through the same shared replay rules, never an abbreviated check that trusts accepted-pair flags.
- Current `replayAudit` cannot rehydrate React; extract common validated rebuild semantics before adding restore adapter. Do not duplicate validation or expose a generic `setWorkflowState`.
- Save transaction atomically CAS-updates project version and inserts an immutable snapshot; unique constraints backstop concurrent attempts and idempotency retries.
- UI may claim saved only if current domain hash and revision still match the acknowledged snapshot.
- When restoring, reject running AI status, invalid references, unsupported policy, altered evidence and bad accounting. No in-flight run can write into restored data.
- Preserve source strings, IDs, quantities and three export formats. Audit lacks raw CSV bytes; never claim hash provenance was independently reverified on reopen.
- Project list never selects the audit blob; audit responses are private, no-store, owner-checked.

## Test-first checklist

Canonical fixture replay; conflicting/duplicate identifiers; AI suggestion accepted, rejected and undone; cancellation and partial analysis; tampered audit; same-key retry; two-tab race; stale in-memory edit during save; cross-owner request; migration/data persistence. Use a real disposable PostgreSQL for transaction tests.

## Review report

For each risky change: invariant targeted, exact path, failure modes, tests run, and any assumptions not demonstrated. Prefer the smallest viable diff.
