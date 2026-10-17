# Phase 1A-3G: Workspace lifecycle safeguards

Stacked on draft PR #8, starting at
`d5ce13738f00ab327351b1ddb6700c359063caa6`. This implementation does not activate
private authentication or any provider operation. The existing cloud-write,
development-command and private Git release restrictions remain unchanged.

The follow-up [workspace isolation correction](phase-1a-3g-workspace-isolation.md)
documents the additional existing-workspace startup and reconciliation checks
and their validation. The implementation results below describe the original
foundation at `1906b3c9a7adc78d64a743b0ede1edc64149fd3c`.

## Architecture and trusted registration

The private lifecycle service accepts only an authentic owner proof from the
existing PostgreSQL session resolver. A client-supplied owner, role, session ID,
workspace ID, provider resource ID or approval preview is not authority. The
service revalidates the owner before scope resolution and every sensitive step.

Create and clone requests contain a UUID idempotency key, not a project identity.
The server derives reserved project and registration identifiers from the
verified initiating session and that key. Existing start/stop requests resolve
the registered project through the existing execution capability with `manage`
permission. Both project and workspace repository associations must match, and
the provider ID must have exactly one registered association.

The flow is owner authentication → canonical scope → structured approval →
durable reservation → fresh authorization → provider operation → independent
resource verification → atomic database registration. Provider creation and
PostgreSQL registration are deliberately separate. There is no upsert that can
replace a historical workspace, no name-based ownership inference and no
fallback to local execution or legacy sandbox recovery.

New Project and Workspace rows are inserted together only after verified
provider evidence. Existing rows retain their IDs, provider IDs, repository and
branch associations. Successful start/stop only updates lifecycle state; a
failed operation leaves that state unchanged. Task, memory and file history are
not changed. New resources require a reviewed snapshot and independently
verified resource ID, reservation labels and restrictive metadata.

## Durable approvals and coordination

The additive migration `20261017000000_workspace_lifecycle` creates:

- `WorkspaceLifecycleApproval`: exact structured scope and SHA-256 digest,
  owner/session/credential-generation binding, decision timestamps, ten-minute
  lifetime capped by session expiry, and a unique one-time operation receipt.
- `WorkspaceLifecycleOperation`: server-generated operation UUID, immutable
  scope, session-bound idempotency key, approval receipt, original and observed
  provider identities, dispatch attempt, lifecycle timestamps and reconciliation
  metadata.
- `WorkspaceLifecycleStatus`: `RESERVED`, `DISPATCHED`, `SUCCEEDED`, `FAILED`,
  `CANCELLED`, `UNKNOWN`.

The tables have RLS with no public policies, identity/lifetime/state constraints,
unique idempotency and approval receipts, and partial unique indexes preventing
multiple unresolved operations for a project or provider resource. Audit
snapshots intentionally do not cascade with session/project deletion.

Approvals bind action, canonical project, reserved/registered workspace,
provider ID where known, canonical repository, exact branch and project name.
Previews are generated from that scope. Generic action-only approvals cannot be
consumed. Balanced and strict profiles require approval for all private
lifecycle mutations; autonomous explicitly waives human approval only. None of
these profiles bypass authentication, coordination or release restrictions.

Reservation and approval consumption share one transaction. Session and owner
rows are checked under locks against database time, including after potentially
blocking coordination. Rotation/revocation and changed registrations deny
dispatch or registration. The global lifecycle lock protects distributed limits;
the existing workspace advisory lock also excludes unresolved command and Git
operations. Reciprocal checks prevent either subsystem entering a workspace
reserved by lifecycle work.

Limits are one unresolved provisioning operation, four unresolved lifecycle
operations globally, three creation reservations per 15 minutes, six lifecycle
mutations per project per five minutes, and twenty active approval requests.
There is no queue. Each reservation permits one dispatch. A repeated idempotency
key returns its existing receipt and never repeats provider work; changed scope
or approval claims conflict.

## Interrupted operations and reconciliation

Pre-dispatch failure is `FAILED`. Once dispatch is recorded, a provider timeout,
disconnect, invalid result, database failure or authorization loss is uncertain:
`UNKNOWN` retains the distributed reservation. If recording UNKNOWN also fails,
the existing `DISPATCHED` record retains it. Neither state is reclaimed by age
or automatically retried. A late SDK completion cannot trigger registration
after the service stops waiting.

An explicit reconciliation examines only the original reservation. For new
resources it searches using all server-generated reservation labels, requires
one result, refreshes it by exact ID and verifies configuration again. A name is
never enough. A recorded provider ID cannot be substituted. Existing resources
are inspected only by their registered ID. Missing, duplicate, mismatched or
unverifiable evidence leaves the operation blocked; there is no creation,
reclone, deletion, start/stop or registration remapping during reconciliation.

Stale DISPATCHED operations become eligible for reconciliation after 60 seconds.
A RESERVED operation older than 60 seconds can be cancelled under the row lock
because no provider dispatch was recorded. Reconciliation has a durable limit
of three attempts with at least 60 seconds between attempts. Expired unconsumed
approvals can be cleaned in batches of at most 100 after at least 30 days;
consumed approvals and operation receipts are retained for audit and idempotency.
No provider cleanup/deletion API is introduced.

Reconciliation remains bound to the original live session and credential
generation. After logout, expiry or rotation, a fresh session cannot silently
adopt an old operation. These stranded records require separately authorized
operator investigation and a reviewed recovery procedure. No automatic recovery
or production repair utility is included in this phase.

## Daytona SDK and credential boundaries

The installed `@daytona/sdk` structured create/get/start/stop/list interfaces are
used directly. A separate client has a five-second request timeout, polling
instead of lifecycle WebSocket subscriptions, and telemetry disabled. Each
adapter operation has a 30-second deadline; the service bounds its wait to
60 seconds and revalidates authorization every two seconds during waits.
Additional callbacks revalidate immediately before actual mutating SDK calls.

New resources request the reviewed snapshot, `daytona` user, private visibility,
blocked network, no secrets/environment/volumes, no ephemeral destruction,
15-minute auto-stop, disabled auto-pause and **auto-delete -1**. The SDK documents
zero as deletion immediately after stopping, so it must not be used. Returned
CPU, memory and disk must fit 2 CPUs, 4 GiB and 10 GiB, with no GPU, links, proxy,
network allowlists, destroy deadline or other unreviewed configuration. The
snapshot interface does not let this implementation independently set its
resources; returned limits are verified before registration.

Existing startup now requires the same verified isolation metadata as creation,
including an already-started resource and read-only start reconciliation.
Historical shutdown does not require development isolation, but still rejects
unknown or unsafe automatic deletion configuration rather than changing it.
Read-only inspection never starts,
recovers, recreates or changes resource configuration. Metadata returned to the
service is minimized; credentials, environment values, arbitrary provider
messages and output are never logged or returned.

The SDK has no lifecycle AbortSignal or confirmed cancellation API. Aborting
stops local waiting and subsequent dispatch/output; the remote operation may
continue. A database check and external mutation cannot be atomic. Resource
metadata and snapshot names cannot attest filesystem contents, repository-root
containment, peer processes or actual isolation. Those are explicit prerequisites
for separately approved isolated provider verification.

Cloning remains blocked even through the isolated service adapter. The installed
`git.clone` accepts username/password fields in a toolbox JSON request, but does
not provide a verified scoped, ephemeral credential mechanism or proof that
credentials cannot persist. No broad GitHub token is forwarded, no credential
remote URL is constructed and no shell/upload fallback is used. Canonical
clone scope and approval preparation are implemented; provider cloning and
repository-access verification await a reviewed credential transport.

Historical sandboxes may retain credentials from the inactive legacy cloning
path. A future owner-authorized remediation should first inventory registrations
without changing identities, establish backups and exact provider/repository
bindings, review credential exposure with the provider, then separately approve
credential revocation and contained cleanup. This task neither inspects nor
modifies those credentials or resources.

## API and deployment staging

`POST /api/workspaces/lifecycle` is private-only and Node-runtime based. Owner
authentication and origin validation precede strict JSON parsing. Bodies are
limited to 32 KiB, valid UTF-8 and ten seconds; responses are `no-store`.

| Action | Request fields | Current behavior |
| --- | --- | --- |
| `prepare` | `request` with create/clone/start/stop and `idempotencyKey` | Create structured approval in PostgreSQL |
| `decide` | `approvalId`, `decision: approve/reject` | Session-bound decision |
| `status` | `operationId` | Minimal database status |
| `execute` | Same `request`, optional `approvalId` | Hardcoded 503 before provider dispatch |
| `reconcile` | `operationId` | Hardcoded 503 before provider lookup |
| `open`, `state` | `projectId` | Hardcoded 503 for the new provider-backed workflow |

Create needs `projectName`; clone needs canonical GitHub `repositoryUrl` and
explicit `branch`, with optional `projectName`; start/stop need registered
`projectId`. Unknown fields, including provider IDs, role claims and preview
text, are rejected. No client-selected adapter or release flag exists.

Existing private create/clone routes reject before environment inspection,
generic policy evaluation or legacy provider access. Existing registered reads
retain their exact-ID, already-started behavior and never start a stopped
sandbox. Inactive-stage behavior remains unchanged. The core adapter-injection
seam is server-only and used by disposable tests; production route facades
enforce the hardcoded gate before constructing a provider.

Run the explicit `npm run db:migrate` deployment procedure in a controlled
environment before any future deployment that requires these tables. The
manual SQL file remains a fresh-bootstrap reference, not an incremental
migration command. No historical migration is rewritten. No production migration
was run here. Authentication remains inactive and existing deployment protection
remains necessary until the separately reviewed final cutover.

## Validation

Actual results on Node.js **24.19.0**, npm **11.9.0**:

| Check | Result |
| --- | --- |
| `npm ci` | Passed; no dependency or lockfile changes |
| `npx prisma validate` | Passed |
| `npx prisma generate` | Passed; Prisma Client 6.19.3 |
| `npm run lint` | Passed |
| `npm run typecheck` | Passed |
| `npm run test:unit -- --no-file-parallelism` | 2,355 passed in 54 files |
| `npm run test:auth-db` | 476 passed in 10 files |
| `npm run test:execution-auth` | 375 passed in 7 files |
| `npm run test:lifecycle` | 272 passed in 4 files |
| `npm run test:auth-http` | All 7 compiled HTTP scenario groups passed |
| `npm run test:auth-boundary` | All 13 server-only client-import probes passed |
| `npm run build` | Passed; Next.js 15.5.22 production build |
| `git diff --check` | Passed |

Suite counts overlap. Lifecycle coverage includes 67 real PostgreSQL integration
cases, 89 controlled SDK adapter cases, 54 HTTP boundary cases and 62 catalogue
and release-gate cases. PostgreSQL tests exercise separate client pools for
cross-instance contention, actual owner-session proofs, scope mismatch,
one-time approvals, immutable registrations, database failure after creation,
provider uncertainty, cancellation, revocation/rotation and reconciliation
limits. Reciprocal command/Git reservation tests cover unresolved lifecycle
operations. Compiled HTTP checks exercise the real new endpoint, trusted
approval preparation and its pre-reservation release gate.

Initial validation identified one outdated legacy clone/open expectation and
five integration expectations that predated the final callback, read-isolation
and reconciliation-claim interfaces. Those tests were corrected; explicit
historical opening, final-dispatch revocation and remapping-during-read cases
were added. The complete final runs above passed. An early fixture typing error
was also fixed before final TypeScript validation.

Tests used disposable PostgreSQL 16, synthetic owner credentials and controlled
provider adapters. No Daytona resources or real repositories were created,
modified or inspected by the lifecycle implementation. Controlled SDK responses
are not evidence of live provider compatibility. The known GitHub Actions
account restriction was not investigated or changed.

## Changed files

28 files changed:

- `docs/reviews/phase-1a-3g-workspace-lifecycle.md`
- `package.json`
- `prisma/manual-schema.sql`
- `prisma/migrations/20261017000000_workspace_lifecycle/migration.sql`
- `prisma/schema.prisma`
- `scripts/check-auth-client-boundary.mjs`
- `scripts/check-private-authorization-http.mjs`
- `src/app/api/projects/workspace/route.ts`
- `src/app/api/workspaces/lifecycle/route.ts`
- `src/app/api/workspaces/route.ts`
- `src/lib/security/command-operation-store.ts`
- `src/lib/security/git-operation-store.ts`
- `src/lib/security/private-lifecycle-http.ts`
- `src/lib/security/workspace-lifecycle-catalogue.ts`
- `src/lib/security/workspace-lifecycle-store.ts`
- `src/lib/workspace/cloud-service.ts`
- `src/lib/workspace/private-lifecycle-provider.ts`
- `src/lib/workspace/private-workspace-lifecycle-availability.ts`
- `src/lib/workspace/private-workspace-lifecycle.ts`
- `tests/integration/command-approvals.test.ts`
- `tests/integration/command-execution-authorization.test.ts`
- `tests/integration/command-operation-store.test.ts`
- `tests/integration/git-authorization.test.ts`
- `tests/integration/workspace-lifecycle.test.ts`
- `tests/unit/cloud-project-authorization.test.ts`
- `tests/unit/private-lifecycle-provider.test.ts`
- `tests/unit/workspace-lifecycle-http.test.ts`
- `tests/unit/workspace-lifecycle.test.ts`
