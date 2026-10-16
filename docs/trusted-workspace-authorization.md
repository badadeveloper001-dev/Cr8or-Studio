# Trusted agent and workspace authorization — Phase 1A-3B

This stage connects the private owner session to agent execution and workspace
access. It does not activate production authentication. The existing complete
private-authentication configuration enables the authentication services, API
boundary, and execution boundary together; no new switch or bypass is added.
Deployment protection remains necessary while the configuration is inactive.
The frontend lock screen and final production cutover still require review.

## Execution authority

`auth.ts` mints an immutable owner context only after resolving the configured
cookie through PostgreSQL. A non-enumerable proof with JavaScript private fields retains the internal
session reference and original credential generation. Revalidation accepts only that
exact server-created object and queries the current session, owner relationship,
credential version, revocation state, and expiration using the database clock.
An internal session ID alone is never a credential or a public API input.

`execution-context.ts` creates a second immutable, server-only capability from
this verified owner context and an exact registered project ID. It binds the
singleton owner, canonical project ID, Workspace row ID, runtime type, provider
workspace ID, repository and branch, allowed operation categories, and abort
signal. Its private fields cannot be reconstructed from JSON or transferred by
copying properties to another object. No raw token or token digest is retained
in this capability. Agent prompts and tool arguments receive neither the session
reference nor the capability.

Every sensitive boundary rechecks PostgreSQL and the project/runtime binding.
Deleted projects, changed mappings, duplicate provider-runtime associations,
unknown references, revoked or expired sessions, and obsolete credential
versions stop execution. Database or configuration failure fails closed. There
is no authorization cache or process-local session authority. Existing
registered local projects without a Workspace row remain usable locally;
ambiguous local IDs resolving to the same directory are rejected without rewriting them; an
unmapped cloud project never falls back to the local filesystem.

## Agent and chat pipeline

The context flows from the protected API through orchestrator, executor, tool
loop, tool executor, and authorized runtime. Agent identity remains separate
from the owner. Server-owned agent tool tiers and existing policy/approval
checks still apply. Tool parameters cannot change project scope; unknown
parameters are rejected. Read operations require authorization too.

Checks precede orchestration work, model requests and retries, tool execution,
runtime operations, memory updates, and emitted progress/results. Model calls
receive an abort signal where the provider interface supports it. Streaming
callbacks are awaited, so failure to validate an event stops later work rather
than allowing an unobserved background stream to continue.

Main chat requires a selected registered project in private mode. Its direct
inspection and readiness reads use the same authorized runtime as tools.
Inspection helpers propagate authorization errors instead of treating them as
missing files and continuing. Model output cannot replace the authorized scope.

## Runtime and endpoint availability in private mode

| Operation | Behavior |
| --- | --- |
| `POST /api/chat/main` | Enabled behind the session/project boundary; no-project requests are rejected before model work. |
| `POST /api/orchestrate` | Enabled behind the session/project boundary and guarded agent pipeline. |
| `POST /api/orchestrate/stream` | Enabled with guarded, awaited progress emission and cancellation on disconnect. |
| `GET/POST /api/files` | Registered-project reads and local writes through the guarded runtime and existing write policy. Private cloud writes are blocked before content transport. |
| Existing cloud open/clone selection | Reuses the exact registered project and provider workspace; no read-triggered provisioning, recovery, restart, or remapping. The sandbox must already be running. |
| New cloud create/clone | Returns `503` until a separately reviewed provisioning lifecycle can bind and revalidate each side effect. |
| Local directory recent/open/create/clone | Returns `503`; legacy directory selection is not a registered-project authorization boundary. |
| `POST /api/github/ops`, `POST /api/deploy` | Returns `503`; these legacy local command paths are not an isolated execution boundary. |
| `POST /api/workspaces/[projectId]/preview` | Returns `503`; persistent processes and signed URLs need a reviewed lifecycle beyond request admission. |
| Runtime Git/commands | Unavailable in both local and cloud private runtimes: an allowed command and working directory do not constrain scripts or Git helpers to the authorized repository. |
| Cloud file tools | Bounded reads/lists use a fixed Python 3 helper on the bound existing Daytona sandbox, with revalidation before dispatch and after completion. Private writes return `503` without sending content. There is no unsafe SDK fallback. |

These restrictions apply only when private authentication is selected. Existing
inactive-stage behavior is preserved. Public authentication exceptions remain
exactly POST unlock, GET session, and POST lock. Sensitive responses remain
`Cache-Control: no-store`; mutations retain exact origin and custom-header
validation. No authentication endpoints, credential policy, KDF, rate limits,
cookie settings, or 12-hour session lifetime are weakened.

Private local file access rejects traversal, absolute paths, sensitive paths,
symbolic roots/descendants, and linked files. File opens use no-follow semantics
and operation boundaries are revalidated. Cloud read/list operations use a fixed Python helper with directory descriptors,
no-follow opens, and regular-file/link checks inside the repository root. Python
runs in isolated mode; command payloads contain only bounded operation/path
metadata. Private cloud write content is never sent. This helper never receives
authentication data. The local host and Daytona
control plane remain trusted infrastructure; path checks are not an OS sandbox.

Historical cloud repository reuse searches the existing canonical repository
and requested branch before deriving any identity from the new singleton owner.
Ambiguous matches fail closed. Existing project IDs, Workspace row IDs, Daytona
IDs, GitHub references, histories, and relationships are not rewritten. No
schema migration or ownership table is introduced.

The [final cloud transport correction](reviews/phase-1a-3b-cloud-transport-review.md)
explains why Base64-in-argv writes were removed, the installed SDK transport
limitations, resource limits, and the requirements for a future safe write path.
Reads are limited to 256 KiB without truncation; helper output is limited to 2 MiB,
paths to 4 KiB, directory scans to 4,096 entries and returned listings to 200.
The remote operation is limited to 30 seconds, with a 35-second local deadline.
Private file-write HTTP bodies are bounded to 2 MiB and ten seconds before JSON
parsing; bounded requests still require all existing authorization checks.

The subsequent [staged cloud writer](reviews/phase-1a-3d-cloud-file-operations.md)
implements a bounded session-input protocol, descriptor-relative temporary files,
and atomic replacement after a fresh PostgreSQL authorization check. Direct file
requests and agent writes use the same runtime path. Its fixed release restriction
remains before provider access until separately authorized isolated Daytona
compatibility verification is complete; there is no environment override. Actual
temporary-filesystem/PTY tests and controlled SDK adapters do not prove live
provider compatibility. The one-shot read/list transport still rejects writes.

## Revocation and cancellation limits

Locking revokes the initiating session in PostgreSQL. Rotation invalidates its
credential generation. Expiration uses the database clock. The next sensitive
boundary detects invalidity, aborts the shared execution signal, suppresses
results/progress, and prevents further tools, writes, model requests, and queued
work. Request/stream cancellation also aborts the execution context.

There is no continuous session polling. A model request or external command
already dispatched may finish before another boundary observes revocation;
remote SDK operations without cancellation support cannot be recalled. File
writes already completed are not rolled back. Database checks and external
effects are not one atomic transaction, so a revocation or mapping change that
commits immediately after a check can overlap an already-authorized operation.
A trusted host or sandbox administrator can still change mounts or rename
directories held open by file operations; these checks do not isolate a hostile
operating system or control plane. The system
guarantees denial of subsequent sensitive operations once invalidity is
detected, not instantaneous cancellation of all remote work.

## Validation and release constraints

Use the existing isolated PostgreSQL test URL safeguard, synthetic credentials,
and disposable schemas. Run the full unit suite, `test:auth-db`,
`test:execution-auth`, compiled-server `test:auth-http`, and client-bundle
`test:auth-boundary`, plus Prisma validation/generation, lint, typecheck, and build.
Run database suites sequentially because authentication hashing capacity is
database-wide. Never substitute production credentials when test infrastructure
is unavailable.

Compare Node.js 20 with a supported newer runtime. Existing AI SDK, Supabase, and
nanoid packages declare Node.js 22+ requirements; successful Node.js 20 checks
do not make that runtime vendor-supported. Dependency upgrades and the existing
audit findings remain separate work. The GitHub Actions account restriction is
not investigated or bypassed by this stage.

Production authentication remains unactivated. This change requires no database
migration, production settings update, real credential provisioning, merge, or
manual deployment. Review this boundary independently before further stages.

## Development command implementation (Phase 1A-3E)

The fixed command catalogue now feeds an opaque policy-bound command grant,
PostgreSQL operation coordination and a bounded Daytona session supervisor.
Private commands remain behind a hardcoded release restriction; cloud-write,
Git and deployment restrictions remain unchanged. See
[the command execution review](reviews/phase-1a-3e-command-execution.md) for the
protocol, additive migration, limits, cancellation evidence and required provider
isolation verification. This implementation does not activate authentication.
