# Phase 1A-4A: release-readiness checklist

**Preparation only. NO LIVE PROVIDER TESTS PERFORMED.** All future live-provider verification is **NOT RUN**. This checklist grants neither live-test permission nor release permission. A successful isolated run is evidence for independent review, not authorization to remove a restriction.

Use the [master plan](phase-1a-4a-provider-verification-plan.md), complete [test matrix](phase-1a-4a-test-matrix.md), [resource authorization](phase-1a-4a-resource-authorization.md) and [recovery runbook](phase-1a-4a-recovery-runbook.md). Store test results using the master plan's evidence record; distinguish mocked/offline results from actual provider observations.

## Current release decision

**BLOCKED.** Cloud file writing, private development commands, private Git operations, workspace lifecycle mutations and repository initialization retain their existing hardcoded release restrictions. Private authentication is not activated by this preparation. Current staged application exposure continues to depend on deployment protection until the separately reviewed authentication cutover.

| Restriction | Current implementation | Change authorized here |
| --- | --- | --- |
| Cloud file writes | [private-cloud-write-availability.ts](../../src/lib/workspace/private-cloud-write-availability.ts): `assertPrivateCloudWriteTransportAvailable` rejects | None |
| Development commands | [private-cloud-command-availability.ts](../../src/lib/workspace/private-cloud-command-availability.ts): `assertPrivateCloudCommandAvailable` rejects | None |
| Private Git, including object transfer | [private-git-availability.ts](../../src/lib/workspace/private-git-availability.ts): `assertPrivateGitAvailable` rejects | None |
| Workspace lifecycle | [private-workspace-lifecycle-availability.ts](../../src/lib/workspace/private-workspace-lifecycle-availability.ts): `assertWorkspaceLifecycleAvailable` rejects | None |
| Repository initialization/cloning | Same lifecycle availability module: `assertPrivateRepositoryCloningAvailable` rejects; legacy credential-clone fallback remains blocked | None |

No request field, model output, environment variable, policy profile, synthetic owner or successful test may bypass these restrictions. Future isolated verification needs a separately reviewed harness using narrowly controlled server composition, not a production switch. This assignment does not implement that harness.

## Before live verification can be authorized

- [ ] Owner approves the exact disposable provider/account/repository/database inventory, snapshot, region, duration, maximum resources, financial limit and cleanup authority. Pricing and account limits are confirmed without inventing estimates.
- [ ] A future harness is independently reviewed: fixed test scope, no production connectivity, no general shell/API proxy, no request/environment gate bypass, bounded fault injection and safe evidence capture.
- [ ] Dedicated repository-scoped GitHub read and write credentials and isolated Daytona credentials are reviewed for actual permissions, expiry and revocation. An environment-variable name is not evidence of least privilege.
- [ ] Synthetic fixture repository is within supported format/history/size restrictions; negative fixtures are separate and cannot replace the approved source.
- [ ] Disposable PostgreSQL configuration, synthetic owner/session records and the exact application commit/SDK version are pinned. Any future test database setup is separately approved; no migration is performed by this preparation.
- [ ] Test ordering, abort criteria, unresolved-resource inventory and the recovery runbook are accepted. No live operation begins before these decisions are recorded.

## Evidence needed before any release reconsideration

Unchecked items are blockers. Current live evidence status for every row is **NOT RUN**. A critical INCONCLUSIVE or FAIL must remain a blocker; a code change, stronger evidence or explicit architectural decision may be required before review can proceed.

| Area | Acceptance evidence required | Live status |
| --- | --- | --- |
| SDK session compatibility | Actual session creation, async command/input delivery, echo suppression, framing, cumulative logs, status/exit behavior, timeouts and cleanup are observed with the installed SDK and reviewed snapshot. Unsupported semantics fail closed. | NOT RUN |
| Exact resource ownership | Original PostgreSQL reservation, registered project/workspace mapping, returned provider ID, fresh provider lookup and operation labels agree; substitution/unknown/duplicate cases cannot dispatch or become ready. | NOT RUN |
| Runtime isolation | Controlled runtime observations substantiate user identity, filesystem and process boundaries, no unexpected volumes or secret-bearing environment, restricted network and effective CPU/memory/disk limits. Metadata alone is insufficient. Provider guarantees and residual same-user/peer-process risks are documented. | NOT RUN |
| File integrity/publication | UTF-8, Unicode, empty and maximum allowed writes preserve bytes; SHA-256 agrees; traversal/symlink/hard-link/special-file attacks fail; interruption/revocation before commit preserves the destination; atomic replacement and cleanup are observed. Unsupported binary use is not misreported as supported text writing. | NOT RUN |
| Command scope/isolation | Every exact catalogue entry runs only in its authorized sandbox/cwd with controlled environment and expected permissions/policy. Untrusted npm code cannot gain application credentials or another project. No host fallback, arbitrary flags or shell fragments. | NOT RUN |
| Termination/resource limits | Real command timeout, output-limit and cancellation cases verify process, child and descendant outcomes separately from SDK session deletion. Surviving or unverifiable work retains `UNKNOWN`, prevents output release and blocks subsequent dispatch. Any unavoidable residual limitation is documented for review. | NOT RUN |
| Git object identity | Actual GitHub API upload preserves exact blob/tree/commit SHAs and required ancestry, including binary/empty/Unicode data. Unsupported or incomplete graphs reject before unintended mutation. API-returned SHA alone is insufficient without independent readback and hashing. | NOT RUN |
| Push and PR safety | Non-force update, exact approved branch and expected remote state, remote races, uncertain mutation retention, neutral approved title and independently confirmed open/draft PR invariants pass. No automatic retry, merge, force-push or SHA substitution. | NOT RUN |
| Repository initialization | Approved repository/branch/HEAD and complete supported graph survive transfer; `renameat2(RENAME_NOREPLACE)` behavior is verified; no existing destination is replaced; independent full inspection confirms object DB, HEAD, worktree, credential-free origin and original registration before ready state. | NOT RUN |
| Unsupported repositories | More than 16 commits, merge/signed commits, `.gitignore`, `.github`, unsupported modes, oversize, missing ancestry and identity mismatch fail as documented restrictions. No truncated history is reported as a successful clone. | NOT RUN |
| Lifecycle safety | Creation/start/stop/reconciliation honor exact resource identity, authorization and approval. Start and ready reconciliation require verified isolation even when already started; historical safe stop never implies execution readiness. No replacement or destructive recovery occurs. | NOT RUN |
| Authorization and approvals | Missing/forged/revoked/expired/rotated sessions, changed mapping and mismatched/expired/consumed approvals deny subsequent sensitive work. Title/branch/commit/operation scope remains immutable. Autonomous policy bypasses only its explicit human-approval step, never authentication or gates. | NOT RUN |
| Distributed coordination | Separate application instances contend against the same disposable PostgreSQL records; duplicate/concurrent dispatch, stale scope, DB outage, quota and `UNKNOWN` slot retention behave as designed. Process-local success alone is insufficient. | NOT RUN |
| Credential containment | Synthetic canaries do not appear in Daytona command arguments, remotes, Git config, provider-visible input where forbidden, application responses or captured logs. Reusable GitHub credentials remain server-side; no production credentials are present. Control-plane trust and log-retention limitations are explicit. | NOT RUN |
| Recovery and cleanup | Faults retain original IDs/reservations; read-only reconciliation never repeats mutations. Unresolved original-session/remote-head cases have an accepted operator procedure. Cleanup is independently confirmed or treated as a blocker with accountable ownership and cost containment. | NOT RUN |

## Automated and operational review

- [ ] Relevant automated suites pass on the pinned supported Node.js 24 environment and exact candidate commit: Prisma validation/generation, lint, typecheck, unit, auth database, execution authorization, lifecycle, Git, authentication HTTP/client-boundary and production build. Use disposable test infrastructure only and report actual results, including absent scripts or environmental limitations.
- [ ] SDK/package lockfile, helper source and snapshot used in live evidence match the release candidate. Changed SDK versions, helper protocols, snapshot/runtime or limits require assessment of which evidence must be repeated; stale evidence is not carried forward silently.
- [ ] Independent review confirms all release gates remain effective throughout verification and records the proposed exact future gate change. No broad removal of unrelated restrictions is bundled with a capability release.
- [ ] The known GitHub Actions account restriction is recorded as an execution limitation, not a code-test failure or a passed check. Required branch/CI checks remain intact; account restoration or an explicitly accepted verification arrangement must be resolved before any merge/deployment approval. This preparation does not investigate or modify Actions.
- [ ] Future deployment checks, environment separation, controlled migrations if needed, deployment protection and rollback expectations are accounted for. This preparation neither validates a deployment nor grants deployment permission.
- [ ] There is no unexplained credential exposure, production connectivity, unsafe isolation, identity mismatch, corrupted data or unbounded execution. Such findings require remediation; they are not converted into PASS by accepting cost or functionality trade-offs.
- [ ] Remaining bounded risks and supported-feature limitations have named owner acceptance or reviewed remediation. Evidence includes the unavoidable interval between database validation and external commit, inability to undo a completed mutation, and uncertain remote cancellation.
- [ ] Independent technical review is complete, and the owner separately approves **release consideration**, identifying the capability, candidate commit and accepted limits.
- [ ] Any actual release-gate change is implemented in a separate reviewed change with explicit owner authorization. Authentication activation, merge and deployment each remain outside this preparation's authority.

## Known dependencies and unresolved decisions

1. **Live harness and resource approval:** no live harness or resource budget is implemented/approved here. Snapshot, region, provider account isolation, actual credential permissions, pricing and cleanup scope require owner confirmation before a future test.
2. **Provider runtime guarantees:** installed SDK types expose methods, not proof of terminal behavior, Linux primitives, command descendant containment, network isolation or credential absence. Actual isolated observations and relevant provider guarantees are required.
3. **Narrow clone compatibility:** initialization intentionally supports only bounded complete SHA-1 histories and permitted modes/paths. Common `.git*` files/directories, signatures and merge histories remain unsupported. Verification must not imply general-purpose cloning or support for this application repository.
4. **Reconciliation limits:** current lifecycle reconciliation needs the original valid session/credential generation; cloning also requires the approved remote HEAD unchanged. Git/command `UNKNOWN` records have no general operator-clearance API. A separately reviewed recovery procedure is needed where these constraints prevent safe completion; database edits are not a workaround.
5. **Remote mutation and cancellation races:** GitHub non-force ref updates do not provide an atomic expected-old-SHA compare-and-swap; authorization cannot be transacted with a provider mutation. Deleting a Daytona session does not prove descendant termination. Evidence must establish acceptable limits before reconsidering affected capabilities.
6. **Historical credentials:** old owner workspaces may have legacy credential/configuration exposure. This assignment neither inspects nor remediates them. Future admission of historical workspaces needs a separately authorized procedure; disposable-sandbox results do not attest to historical resources.
7. **Current staging boundary:** provider verification does not finish frontend locking, production authentication cutover, deployment protection review or any later phase. Those approvals remain separate.

The release recommendation remains **BLOCKED pending independent verification and review**. All future live-provider results are **NOT RUN**; no application behavior or release restriction is changed by these documents.
