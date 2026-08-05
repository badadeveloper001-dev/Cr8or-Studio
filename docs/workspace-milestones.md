# Cr8or Studio Workspace Program

This plan delivers all remaining work as milestones with clear scope, acceptance criteria, and rollout sequence.

## Program Principles

- Ship in small vertical slices.
- Keep main branch releasable after each milestone.
- Gate risky actions behind approvals and policies.
- Add tests and observability with every feature.

## Milestone 0 - Program Setup (2 days)

Goal: establish delivery controls so parallel work does not destabilize the app.

Scope:
- Define feature flags for new systems.
- Add architecture decision records for auth, policy, sandbox, and audit.
- Define error model shared by API routes.
- Establish baseline performance budget and SLIs.

Deliverables:
- Feature flag map.
- ADR set.
- Error response contract.
- Initial SLI dashboard definitions.

Acceptance Criteria:
- Every new feature in later milestones is flaggable.
- Every API route can return standardized error envelopes.
- Baseline app latency and failure metrics recorded.

## Milestone 1 - Auth and Access Control (1 week)

Goal: secure user boundaries and workspace ownership.

Scope (High Priority):
- Implement authentication and server session validation.
- Add workspace ownership model and permission checks.
- Add role model for privileged actions (commit, push, deploy, repo mutations).
- Add per-user authorization checks in all API routes.

Scope (Security):
- Add audit entries for sign-in, sign-out, and permission denials.

Deliverables:
- Auth middleware and session enforcement.
- Roles: owner, maintainer, viewer.
- Policy helpers used by all write/deploy endpoints.

Acceptance Criteria:
- Anonymous users cannot call protected routes.
- Users cannot access workspaces they do not own.
- Privileged actions are denied for insufficient role and logged in audit.

## Milestone 2 - Secrets and Provider Safety (1 week)

Goal: protect credentials and prevent accidental leakage.

Scope (High Priority):
- Centralize server-side secrets access.
- Add startup/runtime key validation with user-facing readiness states.
- Add terminal/log redaction for token-like patterns.

Scope (Security):
- Add secret access audit events.
- Add data handling policy for retention and masking.

Deliverables:
- Secret manager abstraction.
- Readiness checks in UI and API.
- Redaction utility with tests.

Acceptance Criteria:
- No secrets exposed in client responses or logs.
- Missing key states are explicit and actionable in UI.
- Redaction covers known key formats and custom patterns.

## Milestone 3 - Agent Safety and Policy Engine (1.5 weeks)

Goal: make autonomous actions safe and controllable.

Scope (High Priority):
- Add approval gates for destructive actions.
- Add policy profiles: strict, balanced, autonomous.
- Add dry-run preview for file edits, shell commands, and git operations.

Scope (Product UX):
- Approval center panel with pending actions queue.
- User decisions: approve once, approve always for session, deny.

Scope (Security):
- Record approval decision trail for all gated actions.

Deliverables:
- Policy engine and evaluator.
- Approval workflow API and UI.
- Dry-run preview renderer.

Acceptance Criteria:
- Destructive operations require explicit approval in strict mode.
- All decisions are traceable with actor and timestamp.
- Users can switch policy profiles without restart.

## Milestone 4 - Workspace Isolation and Execution Sandbox (2 weeks)

Goal: isolate projects and reduce blast radius.

Scope (High Priority):
- Isolate each managed project in independent execution context.
- Restrict path access to approved workspace roots.
- Add command allow/deny controls with policy binding.
- Add resource quotas and execution timeouts.

Scope (Performance):
- Timeout/cancellation propagation for long tasks.

Scope (Security):
- Log sandbox violations and blocked commands.

Deliverables:
- Sandbox runtime wrapper.
- Path and command policy enforcement.
- Quota and timeout manager.

Acceptance Criteria:
- Commands cannot escape workspace boundaries.
- Long-running tasks can be cancelled reliably.
- Quota overruns are blocked and surfaced clearly.

## Milestone 5 - Reliability and Quality Foundation (2 weeks)

Goal: enforce quality before merge and increase runtime resilience.

Scope (Reliability and Quality):
- Unit tests for APIs, orchestration, policy, redaction, sandbox.
- Integration tests for core flows (chat, orchestration, git, deploy, github api).
- Deterministic smoke tests for GitHub API paths.
- CI pipeline with required checks: lint, typecheck, test, build.
- Error handling standardization and retry/backoff for transient failures.
- User recovery actions: retry step, rerun workflow, resume run.

Scope (Security):
- Dependency vulnerability scanning in CI.

Deliverables:
- Test suites and CI workflows.
- Retry library wrappers and error taxonomy.
- Recovery UX actions in run history.

Acceptance Criteria:
- PR cannot merge unless required checks pass.
- Critical flows have automated integration coverage.
- Transient failures recover without manual intervention in most cases.

## Milestone 6 - Product UX Completion (2 weeks)

Goal: make the workspace feel complete for daily use.

Scope (Product UX):
- Persisted chat history, run history, artifacts, and decisions.
- Replay run, fork run, restore workspace state.
- Source control ergonomics: diff preview, staging controls, conflict guidance.
- Command palette improvements and discoverability.
- Agent health/status indicators and execution timeline.
- First-run onboarding wizard.
- Workspace health panel (keys, repo access, provider readiness, policy mode).

Scope (Performance):
- Virtualized lists for logs/files/output.

Deliverables:
- History model and APIs.
- Run replay/fork system.
- Enhanced source control panel.
- Onboarding and health UX.

Acceptance Criteria:
- Users can recover and continue prior work sessions seamlessly.
- Source control actions are explainable and reversible where possible.
- Onboarding gets a new user to first successful run without docs.

## Milestone 7 - Security and Compliance Hardening (1 week)

Goal: complete enterprise-level governance and policy controls.

Scope (Security):
- Complete audit log coverage for all sensitive operations.
- Data retention settings and data export/delete tooling.
- Policy docs and admin controls.
- Supply-chain integrity checks and lockfile enforcement.

Deliverables:
- Audit explorer UI and query API.
- Data governance controls.
- Security checklist and runbook.

Acceptance Criteria:
- Every sensitive action is auditable end-to-end.
- Retention policy can be configured and enforced.
- Data export and delete requests are verifiable.

## Milestone 8 - Performance and Scalability (1 week)

Goal: optimize responsiveness and throughput under load.

Scope (Performance):
- Streaming stability under concurrent agent workloads.
- Incremental caching for repo metadata, branches, and file content.
- Smarter invalidation strategy for cache coherence.
- Query and render optimization for heavy session histories.

Deliverables:
- Cache layer and invalidation hooks.
- Performance benchmarks and regression checks.
- Capacity report with scaling recommendations.

Acceptance Criteria:
- Defined P95 latency targets met for core workspace actions.
- No major UI slowdowns with large logs/history.
- Concurrency test passes for target number of active runs.

## Cross-Milestone Non-Functional Targets

- Uptime target: 99.9% for API routes.
- P95 action latency target: under 1.5s for non-build operations.
- Error budget defined and tracked.
- 90%+ test pass stability in CI over rolling 14 days.

## Suggested Delivery Order

1. M0 Program Setup
2. M1 Auth and Access
3. M2 Secrets and Safety
4. M3 Policy and Approvals
5. M4 Sandbox Isolation
6. M5 Reliability and Quality
7. M6 UX Completion
8. M7 Security Hardening
9. M8 Performance Scaling

## Execution Notes

- Keep all new systems behind feature flags until acceptance criteria pass.
- Run progressive rollout: internal -> beta users -> general availability.
- Validate each milestone with demo scripts and release notes.
