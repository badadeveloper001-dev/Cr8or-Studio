# ADR 0003: Sandbox and Execution Isolation

Status: Accepted
Date: 2026-08-05

## Context

Workspace operations currently execute in shared process context with broad path reach.

## Decision

Use project-scoped execution contexts with path boundary checks, command policy controls, quotas, and cancellation.

## Consequences

- Commands cannot execute outside approved workspace roots.
- Long-running operations have enforceable timeout and cancellation.
- Policy violations and blocked commands are auditable.

## Follow-up

- Introduce sandbox runtime wrapper.
- Add integration tests for boundary escapes and blocked commands.
