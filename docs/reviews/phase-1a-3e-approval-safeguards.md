# Phase 1A-3E: operation-scoped command approvals

Correction on existing draft PR #7, branch `cr8or-009-command-execution-safeguards`,
starting commit `2c57b0a3adb249ff691b842c7dadc6d6cd0d9968`.

## Correction and binding policy

An action-only `commands.execute` approval no longer authorizes a private command.
The server stores an immutable scope containing singleton owner `owner`, canonical
registered project ID, exact Workspace registration ID, exact Daytona provider
workspace ID, and exact catalogue key. Titles and previews are generated from
that stored scope; client prose, role claims and workspace identifiers supply no
authority. The Workspace registration ID also prevents deleting/recreating a
registration from inheriting a previous approval accidentally.

Approvals bind to **both the initiating authenticated session and its credential
generation**. Creation, review/decision, consumption and receipt validation require
the original session to remain valid. A different owner device cannot consume or
decide that session's approval; it must request its own. Locking that session,
expiry, credential rotation or revoke-all invalidates its approvals. Rotation
and revoke-all already increment the existing credential generation; no changes
to those operations or the owner identity are necessary.

Lifetime is ten minutes from the PostgreSQL clock, capped by session expiration.
Expiration applies to consumed receipts as well: an operation cannot keep using
an expired approval. Explicit revocation may invalidate an already-consumed
receipt, causing later command-grant validation to deny further work/output.
The existing remote cancellation and UNKNOWN-operation safeguards remain in force.

## Enforcement flow

1. Existing private API guards validate the owner session, origin and mutation
   header before processing approval requests.
2. A strict request selects only a project and catalogue command. The server
   resolves an execution capability from the authenticated session and canonical
   database registry; no request can provide a session, owner or workspace scope.
3. Persistence verifies the capability again and validates the live owner,
   session, project and exact unique Daytona association under database locks.
4. A pending durable approval stores that scope. Its review DTO contains the
   exact command/project/provider identifiers and server-generated JSON preview.
5. The authenticated owner decides the approval. The service rechecks the stored
   scope against the current registration and the original session/generation.
6. Balanced and strict command policies require an approved, unexpired,
   unrevoked matching row. The command authorization service creates the operation
   UUID and atomically consumes the approval for that operation and agent.
7. Only then can the service mint the opaque command grant. It retains the exact
   execution capability, command, operation UUID, agent, policy profile and
   private approval receipt. Runtime validation rechecks the consumed receipt in
   PostgreSQL, including later expiry, revocation and scope changes.

The explicit autonomous policy intentionally waives human approval. It still
requires genuine owner authentication, registered project/sandbox binding, agent
permissions, the exact catalogue, resource coordination and the hardcoded release
restriction. A profile change invalidates existing grants. Policy profiles retain
their existing process-local administration; this correction does not broaden
that separate workflow.

## HTTP contracts and compatibility

Private command creation uses the existing endpoint:

```http
POST /api/security/approvals
Content-Type: application/json
Origin: <configured application origin>
X-CR8OR-Auth: 1
```

```json
{
  "intent": "request",
  "payload": {
    "action": "commands.execute",
    "projectId": "registered-project-selector",
    "commandKey": "npm run lint"
  }
}
```

A successful response is `201 { "ok": true, "approval": ... }`. The review DTO
includes `scope: { ownerId, projectId, providerWorkspaceId, commandKey }`, generated
`title`/`preview`, status, timestamps and one-time consumption information. It
never includes the internal session reference, credential version, token or hash.
Extra fields such as `ownerId`, `sessionId`, `providerWorkspaceId`, `scope`,
`title` or `preview` are rejected for private command creation. The project
selector is untrusted until its database registration is resolved.

Decisions retain the existing endpoint and structure:

```json
{ "intent": "decide", "payload": { "id": "approval-uuid", "decision": "approved" } }
```

`denied` and `revoked` are supported. Decisions are immutable except revocation;
repeated identical valid decisions are safe. Revocation retains any consumed
operation/agent metadata. An optional legacy reason is not authorization scope.

`GET /api/security/approvals` returns the current session's durable approvals and
unrelated legacy approvals, with no-store responses. Legacy action-only command
approvals are hidden/rejected in private mode, never upgraded. A missing durable
ID permits lookup of an unrelated legacy action only; a database failure does
not trigger fallback. Inactive-stage legacy behavior remains unchanged.

The private body reader enforces 16 KiB of actual UTF-8 JSON and a ten-second
stream deadline. Authentication and origin protection precede parsing. Invalid
requests return 400 (oversize 413), session failures 401, unauthorized operations
403, missing records 404, incompatible/stale scope 409, and infrastructure failures
503 with sanitized errors. Unknown command keys cannot create a durable row.

The existing Approval Center can display the generated title and exact preview
returned by this API. Its automatic submission still uses legacy payloads and
lacks the private mutation header, as before this correction. Full frontend
cutover remains a later phase; this task exercises the scoped workflow through
actual authenticated API handlers and isolated tests. No frontend authentication
or lock-screen changes are included.

## Persistence, concurrency and audit

Additive migration `20261016010000_command_approvals` creates `CommandApproval`
and `CommandApprovalStatus` (PENDING, APPROVED, DENIED, REVOKED). Columns include:

- UUID ID; fixed owner identity; internal initiating session ID and credential generation.
- Project ID, Workspace registration ID, Daytona workspace ID and exact command key.
- Creation/expiration, decision/revocation and consumption timestamps.
- Unique consumed operation UUID and consuming agent identity.

PostgreSQL checks constrain singleton identity, lengths, supported catalogue keys,
ten-minute maximum lifetime, decisions and complete consumption metadata. RLS is
enabled with no public policies; PUBLIC table privileges are revoked. Indexes
support session/history lookup and expiration, and a unique operation receipt
prevents one operation ID from consuming two approvals.

Transactions lock owner then session rows with FOR SHARE, matching existing
credential rotation/revoke-all lock order. They then lock the project and briefly
hold a Workspace table SHARE lock to exclude remapping/duplicate-provider
registration phantoms. Approval FOR UPDATE serializes decision/consumption across
independent application instances. Consumption additionally coordinates on the
operation UUID with a transaction advisory lock; the conditional UPDATE requires
APPROVED and unconsumed. Exactly one concurrent consumer succeeds.

The session rows and database clock are checked again after waiting on locks.
Receipt validation checks the same live scope, operation and agent without
consuming again. Prisma errors are sanitized; missing infrastructure fails closed.
Short transaction timeouts bound lock waits; contention can produce a safe
unavailable response instead of granting stale access.

Identity fields are audit snapshots with no cascading foreign keys. Existing
session cleanup or project deletion does not erase decision history. No raw
authentication token, credential hash, arbitrary preview, source contents or
command output is stored. The durable row retains creation, decision, revocation
and the one-time operation receipt even if the existing optional audit log is
disabled. No automatic approval-history pruning is introduced in this correction.

Consumption precedes remote admission. A later failure, changed policy, busy
workspace or release restriction may consume an approval without dispatching a
command. It is never automatically refunded or transferred to another operation;
a new approval is required. This conservative behavior prevents uncertain retries
from silently reusing authorization.

Use the existing controlled `npm run db:migrate` procedure before a future
deployment requiring the table. `prisma/manual-schema.sql` remains a bootstrap
reference. No historical migrations are rewritten. Existing projects, workspace
IDs, provider mappings, tasks and memory records are unchanged.

## Release limitations

Private commands and PR #6's private cloud writes remain hard-blocked by their
unchanged release restrictions. No client, model, environment setting, generic
approval or policy profile removes those restrictions. Private authentication
remains inactive in production; existing deployment protection remains necessary.

An approval authorizes a command identity within a project/workspace, not an
immutable snapshot of npm scripts or source code. Those scripts remain untrusted.
Daytona isolation, historical sandbox credentials, descendant cancellation,
provider buffering/tracing and in-flight request limitations from the original
command implementation remain unresolved. No live Daytona verification occurred.
Database approval checks and external dispatch are not one atomic transaction;
revocation after the last check can still race an in-flight remote operation.
Subsequent validation stops scheduling/output and attempts the existing bounded
cancellation; completed mutations cannot be undone.

## Validation

Actual results on Node.js **24.19.0**, npm **11.9.0**, PostgreSQL **16**, and the
unchanged dependency lockfile:

| Command | Result |
| --- | --- |
| `npm ci` | Passed |
| `npx prisma validate` | Passed |
| `npx prisma generate` | Passed |
| `npm run lint` | Passed |
| `npm run typecheck` | Passed |
| `npm run test:unit` | 1,519 tests passed in 41 files |
| `npm run test:auth-db` | 297 tests passed in 8 files |
| `npm run test:execution-auth` | 196 tests passed in 5 files |
| `npm run test:auth-http` | 5 compiled HTTP verification groups passed |
| `npm run test:auth-boundary` | 6 real Next.js client-import rejection probes passed |
| `npm run build` | Passed |

This correction adds 97 behavioral tests: 43 route tests, 12 command-grant tests,
and 42 PostgreSQL approval tests. The database suite also ran independently with
all 42 tests passing. Suites overlap; their totals are not distinct test counts.
Coverage includes different commands/projects/sandboxes, separate application
instances racing consumption, invalid and revoked sessions, rotation, expiry,
legacy approvals, forged request fields, remapping, unavailable infrastructure,
receipt revocation after grant creation, and the unchanged release restrictions.
The compiled HTTP checks now exercise scoped approval creation/review, reject
forged and remapped scope, and fail closed when the approval table is unavailable.

PostgreSQL checks used a disposable local container and temporary schemas with
synthetic owner credentials. Command regression tests used controlled SDK
adapters and disposable local filesystem/process fixtures. These checks do not
constitute live Daytona verification. No production credentials or database were
used. No dependency upgrades, production configuration changes, real-owner provisioning,
authentication activation, manual deployment or merges occurred. The known
GitHub Actions account restriction was not investigated or modified.

## Changed files in this correction

| File | Change |
| --- | --- |
| `src/lib/security/command-approvals.ts` | New durable scope, decision, consumption and receipt validation service |
| `src/lib/security/command-authorization.ts` | Require exact durable approval before minting grants; revalidate receipts |
| `src/lib/security/auth.ts` | Resolve a server-internal binding from a genuine private-session proof |
| `src/lib/security/execution-context.ts` | Extract that binding only from a validated execution capability |
| `src/app/api/security/approvals/route.ts` | Strict scoped command requests and authenticated durable decisions/review |
| `prisma/schema.prisma` | Approval model and status enum |
| `prisma/migrations/20261016010000_command_approvals/migration.sql` | Additive approval DDL, constraints, indexes and RLS |
| `prisma/manual-schema.sql` | Matching manual bootstrap reference |
| `tests/integration/command-approvals.test.ts` | New PostgreSQL scope, concurrency and lifecycle tests |
| `tests/integration/command-execution-authorization.test.ts` | Existing execution fixtures use real scoped approvals |
| `tests/unit/private-command-approval-route.test.ts` | New behavioral API tests |
| `tests/unit/command-authorization.test.ts` | Durable consumption and receipt tests |
| `scripts/check-private-authorization-http.mjs` | Compiled scoped-approval HTTP verification |
| `scripts/check-auth-client-boundary.mjs` | Approval-store server-only boundary probe |
| `package.json` | Include scoped approval tests in database/command suites |
| `docs/reviews/phase-1a-3e-command-execution.md` | Update the command architecture and link this correction |
| `docs/reviews/phase-1a-3e-approval-safeguards.md` | Binding policy, API/migration procedure, limitations and actual results |
