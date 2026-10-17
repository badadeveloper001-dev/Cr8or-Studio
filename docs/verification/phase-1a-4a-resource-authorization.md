# Phase 1A-4A resource and cost authorization

This is an approval worksheet for a **future** isolated verification assignment. It grants no resource, credential, migration, execution, cleanup or release authority. **NO LIVE PROVIDER TESTS PERFORMED.** All future live-provider tests are **NOT RUN**.

Use this with the [master plan](phase-1a-4a-provider-verification-plan.md), [test matrix](phase-1a-4a-test-matrix.md), [recovery runbook](phase-1a-4a-recovery-runbook.md) and [release readiness checklist](phase-1a-4a-release-readiness.md). The later harness must be separately implemented and reviewed; this preparation does not supply a live runner or a way around application release restrictions.

## Authorization required before execution

The owner must approve a completed inventory, exact test subset, provider account and region, credential permissions, financial ceiling, execution window and cleanup scope. A blank or `TBD` value blocks execution. These are proposed ceilings for one verification wave, not a claim that every scenario fits in that wave. Additional waves, resources or time require another authorization.

| Approval field | Proposed bound / required decision | Current state |
| --- | --- | --- |
| Reviewed implementation and later harness | Pin exact application commit, harness commit and package-lock digest; record Node and SDK versions | Harness not implemented; approval required |
| Operator and observation | Name execution operator, independent reviewer and cleanup owner; name backup owner for unresolved resources | TBD |
| Test selection | Select explicit matrix rows and negative fixtures; no open-ended stress testing | TBD; all NOT RUN |
| Provider accounts | Dedicated Daytona test account/organization and GitHub test owner; no access to production resources | TBD |
| Daytona count | At most two disposable sandboxes total, at most two present concurrently, one provisioning dispatch at a time; no replacement after uncertain creation | Proposed; not authorized |
| Daytona duration | At most two hours of active verification per sandbox; four sandbox-hours aggregate per wave; stop dispatch at deadline | Proposed; not authorized |
| Retention after stop | Explicit owner-approved deadline for deleting confirmed disposable resources; separately budget unresolved resources that must remain quarantined | TBD; stopped storage may continue billing |
| GitHub resources | One dedicated disposable private repository with only synthetic data; a second empty test repository only if separately approved for cross-repository denial tests | Proposed; not authorized |
| PostgreSQL | One disposable local PostgreSQL instance/database, test schemas only; two application workers for coordination tests | Proposed; not authorized |
| Maximum expenditure | Numeric ceiling, currency, taxes/credits treatment, provider billing measurement and alert thresholds | TBD; execution blocked |
| Cleanup scope | List exact resource IDs and allowed stop/delete actions; include repository, snapshot if created separately, test credentials, database and evidence retention | TBD; no deletion authorized now |
| Failure authority | Read-only reconciliation and quarantine permitted only within approved inventory; no automatic retry, replacement or destructive recovery | Explicit owner acceptance required |

Two sandboxes are useful for proving isolation from a different test project and for initialization fixtures that cannot overwrite an existing repository. Do not recreate resources to squeeze additional fixtures into the approved count. Initialization over a deliberately occupied destination should fail; a new successful-initialization fixture requires an unused approved destination. If more fresh resources are needed, stop and amend the inventory before creation.

## Daytona inventory and configuration

Record provider-assigned IDs, not just names. No existing owner workspace, historical mount, customer data or existing project registration may be used.

| Inventory item | Required evidence before use |
| --- | --- |
| Test account / organization | Operator confirms separation from production and verifies the test API key cannot administer owner workspaces; if provider permissions cannot be scoped by resource, use an account containing only authorized disposable resources |
| Reviewed snapshot | Exact snapshot ID, provenance/version or digest where available, review date, installed Python/Git/Node/npm versions, system ownership and dependency inventory; no embedded tokens, histories, mounts or private source |
| Region / target | Exact approved target. The current lifecycle facade uses the adapter default `us`; choosing another target requires a separately reviewed compatible harness/configuration path, not an undocumented environment override |
| Sandbox identities | Provider sandbox ID, reserved project ID, workspace registration ID, lifecycle operation ID and exact creation labels from the trusted service |
| Isolation | User `daytona`, private visibility, `networkBlockAll: true`, empty environment/secrets/volumes, no network/domain allowlist, outbound proxy, linked sandbox, OpenTelemetry override or warm-pool association |
| Resources | No GPU; verified positive CPU ≤ 2, memory ≤ 4 GiB and disk ≤ 10 GiB. The current snapshot-based create path does not independently set these quotas; review snapshot/provider defaults and reject excessive returned metadata |
| Lifetime behavior | Auto-stop 15 minutes; auto-pause 0; auto-delete -1; no automatic destroy deadline; creation requests TTL 0 and non-ephemeral behavior. Provider semantics must be tested; do not substitute auto-delete 0, which can delete immediately on stop |
| Local fixture contents | Synthetic files and npm scripts only; dependencies already available in the reviewed snapshot. No test may relax network blocking merely to run package installation |
| Runtime evidence | Actual UID/GID, expected repository directory, filesystem/mount boundary, available resource controls, network-denial observations and absence of cross-sandbox canaries. Metadata alone is not runtime isolation proof |

Source: [private-lifecycle-provider.ts](../../src/lib/workspace/private-lifecycle-provider.ts), [private-workspace-lifecycle.ts](../../src/lib/workspace/private-workspace-lifecycle.ts), [Daytona adapter](../../src/lib/workspace/providers/daytona.ts). Current SDK and exact methods are recorded in the master plan.

Keep sandbox networking blocked while the trusted test application contacts GitHub. Plan any network-isolation probe in advance: use an approved operator-controlled endpoint/canary, a strict request/time cap and no internal scanning. Failure to connect is evidence only for the tested route, not proof of universal isolation. Never probe production hosts, instance-metadata credentials or another customer's environment.

An unsafe historical-configuration fixture must itself be a disposable test sandbox. Approval to simulate an unsafe configuration is not approval to start it. The expected behavior is refusal to start or report ready; separately authorized safe shutdown must preserve the no-auto-delete check.

## GitHub inventory and credentials

The future repository must be created by an explicitly authorized operator, not by an unrestricted application test credential. Repository creation and deletion privileges are unnecessary for the application transport. Use a private repository with no Actions secrets, webhooks, packages, deployments, production branches or real identity data. Use synthetic commit names/emails and known fixture object IDs. Do not reuse the Cr8or Studio application repository, its branches or its installed integration credentials.

| Credential role | Minimum intended repository permissions | Allowed location and use |
| --- | --- | --- |
| Repository source | Metadata read and Contents read on the exact disposable repository | Trusted application process only; `CR8OR_PRIVATE_GITHUB_CLONE_TOKEN` resolver for the future isolated composition |
| Object upload and branch update | Metadata read and Contents write on the exact disposable repository | Trusted application process only; `CR8OR_PRIVATE_GITHUB_TOKEN` object-transfer resolver; no broad-token fallback |
| Draft PR verification, if selected | Metadata read, Contents read and Pull requests write on the exact disposable repository; Contents write only if that credential also performs a separately approved branch mutation | Trusted GitHub adapter only; no repository administration, Actions or workflow permission requested |
| Resource setup / cleanup operator | Separately approved authority for creating/deleting only the inventoried test repository | Not supplied to application execution, models, Daytona or test npm scripts |

Prefer separate expiring credentials for read-only initialization and write tests. Record the credential type, opaque credential identifier, repository selection, expiration and an independently reviewed permission summary; never record token values. Confirm the currently documented permission requirements for each selected GitHub REST endpoint before issuance. The intended permission table is not proof that an issued credential is least-privileged. An environment-variable name is not such proof either.

Use repository-scoped fine-grained credentials or an equivalently scoped installation credential supported by the transport. Account-wide classic credentials and the historical `GITHUB_TOKEN` / `GH_TOKEN` cloning fallback are not approved substitutes. Credentials may be supplied only through the later approved secret-delivery channel to the isolated application process; no production environment-variable changes are permitted.

There is a preparation blocker: [git-project-naming.ts](../../src/lib/security/git-project-naming.ts) currently maps only the application repository to `CR8OR`. Success-path commit/push/PR tests on a disposable repository require a separately reviewed, server-owned test naming composition in the later harness. Do not point the disposable transport at the application repository key, accept a request/env-selected project code, or weaken canonical repository checks. The production naming map remains unchanged in this phase.

The basic compatible initialization fixture must have unsigned canonical SHA-1 commits with complete linear history, supported file modes and a small graph. Negative branches may contain unsupported history, `.gitignore`, `.github`, modes or excessive sizes, but remain bounded synthetic fixtures and must be rejected. No workflow execution is needed to test rejection of a `.github` path; keep repository Actions disabled through the separately approved setup procedure and avoid executable workflow contents.

## PostgreSQL and application isolation

- Provision no database now. In the future, use a fresh local test instance with no replication, import, tunnel or network route to production. Do not copy production rows or connection strings.
- Existing integration tests accept `localhost` / `127.0.0.1`, port `55432`, database `cr8or_auth_test`; preserve these checks rather than substituting a production URL. Use unique schemas and synthetic owner/session/approval/project/operation rows.
- Apply schema only to that verified disposable instance under the later explicit authorization. This document does not authorize any migration. Keep the runtime test account's privileges separate from the schema-setup operator where practical.
- Use two isolated application worker processes with independent clients against the same test database to verify transaction locks, one-time approval consumption and reservations. Do not use two promises in a single mocked store as evidence of cross-instance enforcement.
- Bind every synthetic project to the exact approved test sandbox and repository. Record UUIDs and sanitized state transitions; never record raw tokens, encoded owner hashes or connection strings.
- Give the isolated application only required test credentials. Start from a reviewed environment-variable allowlist, rather than inheriting the developer shell or deployed application's full environment. No application-server environment is forwarded to Daytona.
- Use a non-public test origin and approved isolated auth configuration. Production auth stays inactive; the hardcoded execution gates stay unchanged. The later internal test composition must exercise real authorization, approvals and coordination without adding a request or environment release bypass.

## Enforced software bounds and additional run caps

The following implementation bounds are ceilings, not a budget or authorization to consume them. The future run must stop at the smaller of the owner-approved cap and the implementation limit. Pin the source revision before verifying these values.

| Capability | Current implementation ceiling | Future operator control |
| --- | --- | --- |
| Lifecycle coordination | One provisioning operation at a time; four pending operations; three creations per 15 minutes; six project mutations per five minutes; approvals expire in ten minutes | Proposed total creations per wave ≤ 2, including uncertain creations; never reclaim an UNKNOWN slot just to continue |
| Lifecycle waits | Service 60 seconds; provider operation 30 seconds; SDK request 5 seconds | No retry after a timeout unless read-only reconciliation proves retry eligibility and a fresh action is approved |
| Commands | One concurrent command per workspace; six starts per five minutes; no work queue; child duration 60 seconds; transport 80 seconds; returned output 64 KiB | Count actual dispatched operations across both workers; approve a finite list of npm script fixtures and command invocations |
| Command resources | RLIMIT_NPROC 64 per real UID, not a per-job descendant limit; 16 MiB per-file limit, 128 open-file limit; these controls are not a sandbox isolation guarantee | Stop if provider limits or descendant termination are unverifiable; do not deliberately run an uncontrolled fork bomb |
| Private file I/O | 256 KiB read/write; 2 MiB request body; 4 KiB relative path; write transport 35 seconds, cleanup 5 seconds | At most one boundary-size fixture and one oversized fixture per planned case; exact hashes, never truncated-success claims |
| Git graph | 16 commits, 128 objects, 256 KiB/object, 1 MiB raw graph, 2 MiB wire, 512 expanded tree entries, depth 32; initialization also caps expanded HEAD checkout at 1 MiB | Fixture generator must declare exact expected counts and bytes before upload; unsupported fixtures cannot trigger unbounded enumeration |
| GitHub graph transport | 300 requests per phase, 30-second phase, 5-second request/body timeout, 1 MiB response; upload request body also 1 MiB | Approve aggregate request cap before run; track HTTP method/count/status without payloads or Authorization headers |
| Repository session | 40-second transport, 35-second helper, 1,000 SDK calls, 12 KiB chunks, 4 KiB output, 5-second cleanup and at most ten cleanup polls | Stop remaining tests on an unexplained SDK-call increase; do not replay initialization after lost acknowledgment |

Sources: [lifecycle store](../../src/lib/security/workspace-lifecycle-store.ts), [command store](../../src/lib/security/command-operation-store.ts), [command supervisor](../../src/lib/workspace/private-cloud-command-program.ts), [command session](../../src/lib/workspace/private-cloud-command-session.ts), [file limits](../../src/lib/workspace/private-cloud-files.ts), [file-write session](../../src/lib/workspace/private-cloud-write-session.ts), [Git graph limits](../../src/lib/security/git-object-transfer.ts), [GitHub source](../../src/lib/workspace/private-github-repository-source.ts), [GitHub upload](../../src/lib/workspace/private-github-object-transfer.ts), [repository helper](../../src/lib/workspace/private-repository-program.ts).

## Cost checklist

No provider pricing has been obtained or assumed in this preparation. Exact prices, units, included allowances and taxes require confirmation with the selected provider account before authorization.

| Potential cost / persistent effect | Required estimate and control |
| --- | --- |
| Snapshot build, storage or image transfer | Record whether the reviewed snapshot already exists, who owns it, retention and applicable charges. A new snapshot is an additional resource requiring approval |
| Sandbox creation, running compute and storage | Price the approved CPU/memory/disk configuration and target; include startup time and four proposed sandbox-hours, not just command duration |
| Stopped, quarantined or uncertain sandboxes | Confirm whether disk/storage and other charges continue. Auto-stop is not deletion, and current auto-delete is disabled |
| Transfer/network/API use | Confirm applicable Daytona and GitHub quotas/charges; account for framing overhead, object verification GETs, polling and controlled disconnect cases |
| GitHub repository, object retention and account plan | Confirm private-repository allowance and retained object storage; a failed ref update may leave uploaded unreferenced objects |
| Database, evidence storage and logging | Prefer disposable local PostgreSQL; confirm any paid hosting or evidence retention separately. No paid logging sink may receive source or secrets |
| Negative/recovery tests | Interrupted creation, cleanup failure and independent peer tests can keep additional resources alive; allocate contingency inside the approved ceiling, not an uncapped exception |

Before execution, fill in unit rates, quantity caps, estimated total, numeric hard financial ceiling, monitoring method and who can halt the test. If the provider cannot enforce a hard account cap, disclose that limitation and obtain explicit acceptance of the monitoring and shutdown plan. A local deadline does not cap billing after an unconfirmed provider mutation. At the spend/time threshold, stop new work, reconcile and contact the named owner; do not delete uncertain resources without the approved cleanup scope.

## Secret-exposure verification procedure

This procedure is planned only; current status **NOT RUN**. It is not permission to inspect historical workspaces or production credentials.

1. Before the future run, seed uniquely identifiable **non-secret synthetic canaries** in the test application environment and synthetic source fixtures. Keep the canary list in the restricted test manifest. Use separate labels for credential-location canaries and source-content canaries.
2. Run only selected approved fixtures. Instrument the later harness to capture command shape, input/output byte counts, target origin, exact sandbox ID and sanitized status. Redact headers, cookies, token parameters and environment values before evidence is persisted. Do not enable SDK HTTP-body debug logging.
3. In the disposable sandbox only, use an approved read-only probe to inspect the fixture process's permitted environment/configuration, command metadata and credential-free Git origin. Check canary absence/presence as booleans; report variable names or file locations only when reviewed safe. Never dump a full environment or arbitrary home directory into logs.
4. Check the authorized application logs and owner-accessible provider command metadata/log surfaces for canary matches, reporting match counts and surface identifiers, not source text. Test both raw and encoded source-canary representations to detect accidental command-argument or echo exposure.
5. Confirm the real dedicated GitHub credential is delivered only as an HTTPS request header by the trusted server transport. Validate absence from recorded command arguments, remote config, generated responses and sandbox-bound metadata without printing or hashing the real token into the evidence record. A local secret matcher may report a boolean; it must not upload the token to a scanning service.
6. Treat any unexpected canary or real-credential exposure as FAIL, stop dispatch, preserve sanitized evidence and invoke the recovery runbook. Credential revocation must use the separately authorized test credential owner. Never inspect or rotate production tokens to investigate a test failure.
7. Record provider retention/logging policy and access controls. A clean customer-visible log check is not proof that Daytona cannot observe or retain submitted input. The Daytona control plane is trusted infrastructure; echo suppression and framed input do not provide confidentiality from the provider itself.

## Inventory and cleanup sign-off

Create the future inventory **before** the first resource operation, then append actual IDs immediately when observed. Each entry requires: run ID, test account, resource type, exact ID, project/registration/operation IDs where relevant, creation intent/time, observed state, cumulative usage, cleanup authorization reference, intended retention deadline, cleanup owner, last reconciliation result and final evidence link. Never store a credential value in this manifest.

Future cleanup must follow the [recovery runbook](phase-1a-4a-recovery-runbook.md):

1. Stop accepting new operations. Preserve operation records and sanitize evidence before deleting any fixture infrastructure.
2. Reconcile all RESERVED/DISPATCHED/UNKNOWN operations against exact inventoried IDs. A lost create response may mean a resource exists; a name or missing client response is insufficient proof of absence.
3. Verify process-tree termination independently. Deleting a Daytona execution session is cleanup, not evidence that all descendants stopped. Quarantine unconfirmed execution and keep the reservation unresolved.
4. Stop only authorized test sandboxes under safe shutdown rules. Do not change auto-delete settings, repair isolation or delete historical resources as cleanup shortcuts.
5. Delete only explicitly authorized, confirmed disposable resources by exact ID after reconciliation. No automatic delete after ambiguity, no wildcard deletion and no sandbox replacement. Repository deletion and unreachable Git-object cleanup are separate operator actions, not transport retries.
6. Confirm provider absence or retained/quarantined state through an independently observed exact-ID check; confirm billed-resource inventory and outstanding cost. Record INCONCLUSIVE when absence or termination cannot be established.
7. Revoke or expire dedicated test credentials through their approved owner; remove isolated local secret material and dispose of the test database only after retaining the necessary sanitized operation evidence.
8. Both operator and reviewer sign the final inventory: every resource is either confirmed cleaned up or explicitly retained with owner, budget, deadline and reason. Unconfirmed cleanup prevents closing the run as successful.

The checklist authorizes nothing by itself. Live execution and later release consideration each require separate explicit owner authorization; test success cannot remove a hardcoded release restriction.
