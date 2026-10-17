---
paths:
  - "web/src/domain/**/*"
  - "web/src/workflow/**/*"
  - "web/src/analysis/**/*"
  - "web/src/ui/AccordApp.tsx"
  - "web/src/ui/useExportArtifacts.ts"
---

# Phase 05 — Preserve reconciliation correctness

- Existing `docs/domain-engine.md`, `docs/workflow-state.md` and `docs/ai-orchestration.md` remain binding for shipped v0.1 semantics.
- Review `docs/phase-05/persistence-contract.md` before any persistence-facing changes.
- Do not alter `checkPair`, Jaccard retrieval, BigInt arithmetic, proposal validation, generation/hash gating, explicit decisions, audit format or export field order without an approved versioned change.
- `replayAudit` currently **does not return** live workflow state. Add a shared, checked restore path rather than accepting JSON into a reducer directly.
- Preserve guest local-only behavior. Do not introduce DB/Better Auth dependencies into pure domain modules.
- Run canonical fixture and tamper/invariant tests for every risky change; never spend OpenRouter quota for unit/E2E.
