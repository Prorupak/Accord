# Accord Phase 05 — Documentation index

**Status: Proposed / documentation-only.** These documents describe the *planned* v0.2.0 platform foundation. No database, authentication, project API, migration, save/restore, or production deployment is implemented by this documentation pack.

**Baseline:** `Prorupak/Accord` release `v0.1.0`, commit `c3ddc82a32b850f76e81737427206e855a720b48`, inspected 2026-10-17.

## How documents relate

| Read first | Purpose | Source of truth for |
|---|---|---|
| `architecture.md` | As-is architecture, planned runtime and boundaries | Component/service ownership |
| `decisions/0001-platform-boundaries.md` | Keep existing TS engine and FastAPI; add Next product backend | Structural decisions |
| `data-model.md` | PostgreSQL aggregate, ownership, constraints, indexing | Logical schema design |
| `auth-authorization.md` | Session, per-user access, CSRF, isolation, signup policy | Auth boundary and threat model |
| `http-contracts.md` | Planned API routes, validation, HTTP errors, proxy routing | Public and internal routes |
| `persistence-contract.md` | Audited save, optimistic locking, idempotency, restore | Consistency invariants |
| `deployment-operations.md` | Compose, migrations, Vercel, secrets, backup | Self-host operations |
| `verification-matrix.md` | Test cases, quality gates, traceability | Definition of done |
| `decisions/0002-audit-snapshots.md` | Use `AuditV1` for first server persistence | Snapshot strategy |
| `decisions/0003-personal-workspaces.md` | Single private workspace, no organization plugin | Tenancy strategy |

## Existing documentation stays authoritative for v0.1 behavior

- `docs/accord-implementation-spec.md`: published product constraints, matching policy, export schema.
- `docs/domain-engine.md`: implemented TS engine and invariant enforcement.
- `docs/workflow-state.md`: existing pure reducer and staleness handling.
- `docs/ai-orchestration.md`: bounded AI inference and output validation.
- `docs/ui-design-system.md` and `web/app/globals.css`: visual contracts; the existing `accord-design-system` skill stays untouched.
- `docs/docker.md`, `docs/vercel.md`, `.github/workflows/ci.yml`: current deployment/test configuration.
- `CLAUDE.md`, `web/AGENTS.md`: global repository rules and Next.js-specific agent guidance.

These new documents **extend**, not retroactively rewrite, v0.1.0. A conflict in existing behavior is a review item, not permission for Claude to silently change the engine or the published audit format.

## Phase workflow

1. **05-0: Document**. Review these files and ADRs; freeze decisions and install agent skills. No production code.
2. **05-I/A: Routing and compatibility spike**. Verify installed Better Auth / Prisma 7 versions and Next/Vercel routing precedence on a throwaway branch. Commit only demonstrated choices. *Routing allowlist implemented (see `docs/progress.md`); Vercel preview check and the Better Auth / Prisma version checks are still open.*
3. **05-I/B: PostgreSQL and migrations**. Introduce database/Compose and CI migration checks.
4. **05-I/C: Auth, personal workspace and project metadata**. Prove authorization with two real DB users.
5. **05-I/D: Immutable snapshots, validation and explicit save/restore**. Prove replay and conflicts.
6. **05-I/E: Harden and release**. Re-run v0.1 regressions, CI, Docker, preview routes, security and self-host docs.

## No premature abstractions

Do not add organizations, team membership, cloud file storage, long-running workers, Redis, autosave, OAuth, password-reset/SMTP flows or a generic API framework during Phase 05-I. Document possible future extensions only under 'Deferred'.

## Acceptance for documentation-only PR

- All links to existing paths resolve in a v0.1.0 checkout.
- Each new file says it is proposed, not shipped.
- `README.md`, `CLAUDE.md`, `web/AGENTS.md`, existing product docs and `.claude/skills/accord-design-system/` are preserved except for an explicitly reviewed small link/addendum.
- Skills have valid YAML metadata and distinct invocation scopes.
- No application source, package manifests, lockfiles, Docker manifests, migrations or runtime environment values change in this PR.
