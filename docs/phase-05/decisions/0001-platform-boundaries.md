# ADR-0001 — Keep the browser reconciliation engine; add a Next.js product backend

- **Status:** Proposed (accept before implementation)
- **Date:** 2026-10-17

## Context

Accord v0.1.0 is a Next.js browser UI and framework-independent TypeScript domain engine, with FastAPI responsible only for bounded OpenRouter inference. The browser owns accepted decisions and export artifacts. Auth and persistent projects now require authenticated server operations but do not require rewriting the matching engine.

## Decision

Use Next.js Node runtime for Better Auth, Prisma and owner-scoped project APIs. Keep FastAPI for current AI inference; preserve existing engine and workflow ownership. Make `/api/auth/*` and `/api/projects/*` Next routes, with only three explicit `/api/map`, `/api/suggest`, `/api/capabilities` routes proxied to FastAPI. Guest mode never depends on DB.

## Consequences

Pros: minimal changes to v0.1 logic, one TS domain language across client and Next server validation, smaller operational footprint, clear auth ownership.

Costs: Next becomes both frontend and business API; runtime routing requires careful Next/Vercel tests; domain replay logic must remain server-compatible (Web Crypto availability and no DOM assumptions). Self-hosting includes one extra DB service. This is acceptable for Phase 05-I.

## Alternatives rejected

- Migrating authentication, DB and authoritative reconciliation into Python (needlessly duplicates TS policy).
- Adding a new NestJS gateway or separately managed auth service (extra runtime and shared-session complexity).
- Auth gate on every visitor (breaks guest product value).

## Validation before acceptance

Check actual dependency compatibility, Next and Vercel routes, no FastAPI regressions, privacy of guest data, server-side replay compatibility.
