# ADR 0002: Policy and Approval Engine

Status: Accepted
Date: 2026-08-05

## Context

Autonomous operations (file writes, git push, deploy) require user control and explainability.

## Decision

Introduce policy profiles (strict, balanced, autonomous) with an approval workflow for risky actions.

## Consequences

- Strict mode requires explicit approval before destructive actions.
- Approval decisions must be recorded with actor, time, and scope.
- System must support dry-run previews before execution.

## Follow-up

- Implement policy evaluator and approval queue APIs.
- Add approval center in UI.
