# ADR 0004: Audit and Observability Baseline

Status: Accepted
Date: 2026-08-05

## Context

The system needs consistent operational visibility and evidence trails for security-sensitive actions.

## Decision

Establish shared API error contracts, route-level SLI telemetry, and audit logging foundations.

## Consequences

- API routes emit a consistent error envelope.
- Route responses include request correlation ID and server timing.
- Baseline SLI endpoint provides in-memory metrics for rapid health checks.

## Follow-up

- Persist audit events and metrics to durable storage.
- Add dashboards and SLO alerting in CI and production.
