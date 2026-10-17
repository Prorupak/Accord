---
name: accord-platform-architecture
description: Use when planning or reviewing changes to Accord's service boundaries, Next.js/FastAPI responsibilities, authentication routing, module ownership, infrastructure, or v0.2.0 architecture. Read actual repository code before recommending changes; preserve the working v0.1.0 domain engine.
---

# Accord platform architecture

Use this skill to prevent architecture drift during Phase 05 and later platform changes. It complements, **never replaces**, `accord-design-system`.

## Required reading

1. Root `CLAUDE.md`, `web/AGENTS.md` if working in Next, and `docs/phase-05/README.md`.
2. `docs/phase-05/architecture.md` and `docs/phase-05/decisions/0001-platform-boundaries.md`.
3. Relevant actual sources: `web/next.config.ts`, `vercel.json`, `web/src/ui/AccordApp.tsx`, `web/src/domain/*`, `web/src/workflow/*`, `api/app/main.py`, `compose.yaml`.
4. For domain contract questions, the existing `docs/domain-engine.md`, `docs/workflow-state.md`, `docs/ai-orchestration.md` take priority over unsupported assumptions.

## Process

1. **Baseline**: Identify the git branch and commit, current files and code path. Distinguish implemented from proposed.
2. **Map ownership**: State input → validation → authoritative state → output for each changed flow.
3. **Minimal alternative**: Prefer a narrow adapter/route rather than a new service, queue, shared store or domain rewrite.
4. **Cross-boundary check**: Explain which data may reach Python, Next server, PostgreSQL, OpenRouter and the browser. Confirm guest path remains available.
5. **Routing proof**: For API work inspect Next and Vercel rewrites and test which runtime handles each path.
6. **Change proposal**: List concrete files to touch and untouched files, possible regressions and tests before edits.
7. **Review**: Read diffs; ensure no duplicate source of truth or accidental extra provider calls.

## Non-negotiable contracts

- AI proposes; TS domain code verifies; human decides.
- FastAPI owns `/api/map`, `/api/suggest`, `/api/capabilities`. Planned Next product APIs own `/api/auth/*` and `/api/projects/*`.
- Preserve `AuditV1`, quantity `B−A`, exact ID eligibility, duplicate quarantine, proposal evidence and strict AI contracts unless the owner explicitly approves a versioned change.
- No global authenticated gate on `/`; guest data is not saved implicitly.
- `CLAUDE.md` global rules stay short. Phase-specific detail belongs in docs and on-demand skills.

## Output

Provide a short architecture impact note: existing behavior, proposed files, trust boundaries, risks, required tests, deferred decisions. Never claim code is implemented without inspection.
