# Cr8or Studio Milestone Tracker

Status key:
- [ ] Not started
- [~] In progress
- [x] Done

## M0 Program Setup
- [x] Feature flag map created
- [x] Shared API error envelope implemented
- [x] ADRs: auth, policy, sandbox, audit
- [x] Baseline SLI metrics captured

## M1 Auth and Access Control
- [x] Auth middleware and session enforcement
- [x] Workspace ownership model
- [x] Roles: owner, maintainer, viewer
- [x] Permission checks on protected API routes
- [x] Audit for auth and permission denials

## M2 Secrets and Provider Safety
- [x] Secret manager abstraction
- [x] Runtime key validation and readiness states
- [x] Terminal/log redaction utilities
- [x] Secret-access audit logging

## M3 Agent Safety and Policy Engine
- [x] Policy profiles: strict, balanced, autonomous
- [x] Approval workflow APIs
- [x] Approval center UI
- [x] Dry-run previews for risky operations
- [x] Approval decision audit trail

## M4 Workspace Isolation and Sandbox
- [x] Project-level execution isolation
- [x] Path boundary enforcement
- [x] Command allow/deny policies
- [x] Timeouts, cancellation, and quotas
- [x] Sandbox violation logging

## M5 Reliability and Quality
- [x] Unit tests for critical layers
- [x] Integration tests for core flows
- [x] Automated GitHub API smoke tests
- [x] CI required checks (lint/type/test/build)
- [x] Retry/backoff for transient failures
- [x] User recovery actions (retry/resume/rerun)
- [x] Dependency vulnerability scanning

## M6 Product UX Completion
- [x] Persisted chat/run/artifact history
- [x] Replay run, fork run, restore state
- [x] Source control diff + staging UX
- [x] Command palette enhancements
- [x] Agent health indicators + execution timeline
- [x] First-run onboarding wizard
- [x] Workspace health panel
- [x] Virtualized heavy lists/logs

## M7 Security and Compliance
- [ ] Full audit log coverage
- [ ] Retention settings
- [ ] Data export/delete workflows
- [ ] Supply-chain integrity checks
- [ ] Security runbook and checklist

## M8 Performance and Scalability
- [ ] Streaming stability under concurrency
- [ ] Metadata/content caching
- [ ] Cache invalidation strategy
- [ ] Render/query optimization for large history
- [ ] Benchmark suite and regression gates
- [ ] Capacity and scaling report
