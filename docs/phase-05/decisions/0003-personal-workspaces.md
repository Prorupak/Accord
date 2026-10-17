# ADR-0003 — One personal workspace per account; no organization plugin

- **Status:** Proposed (accept before implementation)
- **Date:** 2026-10-17

## Context

The product aims to grow into a collaboration-ready open-source platform. Phase 05-I needs first-party persistence and isolation, but no multi-user collaboration or invitation workflow yet.

## Decision

Create a private `Workspace` for each verified Better Auth user (`ownerId` UNIQUE), provisioned idempotently. Projects are workspace-owned. Every route checks the current session and workspace owner in the database. Use `404` for both absent and another user's project. Keep guest mode without auth. Defer membership, team roles, invitation email and Better Auth organization plugin.

## Consequences

Pros: simple data ownership, clear privacy boundary and tests, future migrations can add members without changing every project's basic parent relationship.

Costs: no teams, no ownership transfer, no shared workspace activity. Public signup remains disabled until verification/recovery or explicit operator bootstrap controls are implemented.

## Validation before acceptance

Two-user isolation matrix, concurrent provisioning uniqueness, sign-out cookie revocation, project delete cascade, signup-disabled server check.
