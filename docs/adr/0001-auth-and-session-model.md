# ADR 0001: Auth and Session Model

Status: Accepted
Date: 2026-08-05

## Context

Cr8or Studio currently exposes operational APIs without authenticated user boundaries.

## Decision

Adopt server-enforced session authentication and per-workspace ownership checks for all protected routes.

## Consequences

- Unauthorized requests receive 401.
- Cross-workspace access attempts receive 403.
- Route handlers must evaluate ownership and role prior to sensitive actions.

## Follow-up

- Implement auth middleware and role model (owner, maintainer, viewer).
- Add integration tests for auth and authorization.
