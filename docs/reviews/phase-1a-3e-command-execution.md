# Phase 1A-3E: development command safeguards

Base: PR #6, `cr8or-008-cloud-file-operations`, reviewed HEAD
`c24689b77135ffc0e04f988f6971a82cb9e92692`.
Implementation branch: `cr8or-009-command-execution-safeguards`.

## Release status

Private commands remain blocked by `assertPrivateCloudCommandAvailable()`.
This hardcoded restriction has no environment, request, model, or legacy-auth
switch. Tests replace that function only within their isolated fixture. They
still require genuine PostgreSQL-backed authentication and command authorization.
The lower-level mechanism also independently requires those capabilities.
No public command endpoint or unrestricted terminal was added.

PR #6's private cloud-write restriction is unchanged. Private local-host commands,
Git and deployment remain blocked. Authentication activation, frontend locking,
production migration and provider verification are outside this change.

## Authorization and catalogue

The flow is owner session → registered project and exact Daytona sandbox → fixed
agent permission tier → command policy/approval → opaque command grant → shared
reservation → remote READY → session/registry recheck → one-shot dispatch claim →
recheck → START → monitored execution → authorization recheck → cleanup → final
session recheck → result.

The immutable server catalogue permits exactly `npm run typecheck`, `npm run lint`,
`npm test`, `npm run test:unit`, and `npm run test:integration`. Runtime validation
independently checks the command and key, exact rules and fixed timeout. Matching
caller rules do not authorize execution. Extra properties, cwd/env overrides,
shell fragments, arguments, substitutions, and unknown commands are rejected.
The remote helper repeats the exact command-to-argv mapping defensively.

All npm scripts are potentially mutating, high-risk project code. The new
`commands.execute` action requires approval under balanced and strict profiles;
the existing autonomous profile retains its reviewed no-approval behavior.
Approvals are consumed through the existing server policy guard. Client role or
approval claims cannot mint a grant. Writer-tier agents retain command access;
reviewer/read-only agents do not. Nonzero exit codes produce failed tool results
with potentially changed workspace state. Existing inactive commands also use the
exact catalogue, 60-second requested timeout and corrected policy metadata.

`CommandAuthorization` uses private fields and an inaccessible constructor key.
It binds the exact initiating execution capability, operation UUID, catalogue
key, agent identity, request correlation and policy profile. Copies or serialized
objects cannot pass validation. Profile changes invalidate an outstanding grant.
The dispatch mechanism snapshots the request so later caller mutation cannot
replace its operation or grant. Each execution capability has a random correlation
UUID, which is neither a session identifier nor authentication evidence.
No raw token/session credential is sent to Daytona or stored with command records.

## Shared coordination and persistence

The additive `20261016000000_command_operations` migration creates
`CommandOperation` and its status enum. It never modifies projects, workspaces,
GitHub/Daytona identifiers, history, memory, or authentication records. Snapshot
identifiers intentionally have no cascading foreign keys: operational records
must survive registry changes, which ongoing authorization detects separately.
The table contains only operation/context/project/workspace/agent/catalogue
identifiers, lifecycle timestamps, status, exit code and confirmation flags.
It stores no command output, source, credential, or token.

A PostgreSQL transaction takes a workspace advisory lock, checks limits against
the database clock and reserves the UUID. A partial unique index independently
enforces one unresolved operation per exact provider workspace. Reservations,
running operations and UNKNOWN outcomes retain that slot. A conditional
RESERVED→RUNNING update is the one-shot dispatch claim; duplicate requests never
replay the provider command. There is no queue and no process-local concurrency
authority. Database failures deny dispatch and output release.

Statuses are RESERVED, RUNNING, SUCCEEDED, FAILED, TIMED_OUT, CANCELLED and UNKNOWN.
Only confirmed termination and cleanup release a dispatched slot. A timeout,
disconnect, failed deletion, ambiguous provider response, or lost application
process can leave an unresolved row. **No timer automatically frees it.** A trusted
operator must identify the sandbox and operation, establish that the supervisor
and all relevant descendants are stopped, inspect provider session cleanup, and
perform a separately reviewed reconciliation. There is deliberately no browser
endpoint or automatic retry that clears UNKNOWN. Even completed remote work can
remain unresolved if the database completion write fails.

`readCommandOperation` supplies internal metadata for monitoring; it does not
authorize operations and is not exposed publicly. `cleanupCompletedCommandOperations`
removes only confirmed terminal history older than 30 days by default (minimum
one day); unresolved rows and the five-minute rate window are never pruned.

Execute `npm run db:migrate` through the controlled operator deployment procedure
before deploying code that needs the new table. Importing Prisma still performs
no migration. `prisma/manual-schema.sql` remains a clearly labelled bootstrap
reference, not an incremental deployment procedure. This change applies migrations
only inside disposable local test schemas, never production.

## Provider admission and execution isolation

The scoped SDK client uses 5-second per-attempt HTTP timeouts and retrieves only
the registered, already-started sandbox. It cannot create, restart, recover,
replace, or remap it. Admission requires explicit metadata: user `daytona`,
nonpublic sandbox, no declared environment variables, no volumes or linked
sandbox, outbound network blocked with no allow-list/proxy, no GPU, positive
CPU ≤2, memory ≤4 GiB and disk ≤10 GiB. Missing metadata fails closed. These checks
are necessary conditions, not an attestation that a historical sandbox is safe.
Resource units follow the installed SDK's sandbox configuration conventions.

The fixed `/usr/bin/python3 -I -S` supervisor opens each repository path component
without symlink traversal, retains the directory descriptor, and rechecks repository
identity before starting. It requires an unprivileged UID and trusted root-owned,
non-writable Node/npm installations under `/usr` or `/usr/local`. It runs exact
argv with `shell=False`; npm itself intentionally executes the project's scripts.
It forwards no application-server environment. The child receives only fixed
locale/PATH/CI settings, a fresh private HOME/TMP directory, empty separate npm
user/global configs and an isolated npm cache. Temporary state is cleaned up.
Project npm configuration and scripts remain untrusted code, not sanitized code.

**Working directory is not a filesystem jail.** Scripts can access other files
and processes permitted to the sandbox UID. A same-UID process can attack its
supervisor, inspect sibling environments, alter repository contents, forge output,
or escape a process group. Rlimits do not establish a per-job cgroup, memory cap,
or aggregate disk quota. A clean child environment does not prove the parent or
sandbox contains no credentials. Historical clone paths supplied GitHub credentials
to sandbox Git; `.git/config`, helpers, mounts, files and peer processes must be
checked in a separately authorized disposable environment. Existing workspaces
must never be treated as credential-free solely from empty SDK env metadata.

The SDK supplies no per-session filesystem/network namespace or UID separation.
Provider-enforced sandbox boundaries, immutable network policy, credential-free
execution, trustworthy supervisor isolation and descendant containment remain
release prerequisites. The hardcoded gate remains closed even if admission checks
pass. No live Daytona workspace was used to establish these guarantees.

## Protocol, lifecycle and limits

`createSession` creates one random execution session. `executeSessionCommand`
launches only the fixed supervisor and catalogue key, asynchronously with terminal
echo suppressed. No source contents, owner token, database URL or provider secret
is placed in its argv or environment. The supervisor also disables terminal echo
and input translation where supported. After `CR8OR-COMMAND/1 READY`, the server
performs the last database recheck and sends only `START\n`. `CANCEL\n` or EOF
requests termination. Malformed, pipelined and oversized control frames fail.
Child stdout/stderr is captured separately; only a terminal bounded JSON envelope
is emitted. Cumulative fragmented SDK logs are validated before parsing.

| Resource | Limit |
| --- | --- |
| Active commands | One unresolved operation per registered provider workspace, enforced in PostgreSQL |
| New reservations | Six per rolling five minutes per workspace, database clock |
| Queued work | Zero; busy/rate-limited work is rejected |
| Command wall time | 60 seconds in the remote supervisor |
| READY handshake | 10 seconds |
| Application operation | 80-second monotonic deadline, then at most 5 seconds remote cleanup, 5 seconds persistence and 5 seconds final authorization |
| Provider calls | Five-second per-attempt SDK timeout; retries may extend a logical request |
| Child output | 64 KiB combined stdout/stderr; excess output is discarded and reported as failure |
| Supervisor response | 512 KiB per SDK field; strict JSON schema and 64 KiB returned UTF-8 output |
| Control frame | 16 bytes |
| Child CPU/file/descriptors/processes | 60 CPU seconds per process, 16 MiB per-file limit, 128 descriptors, 64 processes per UID, no core dump |
| Provider-reported sandbox resources | At most 2 CPU, 4 GiB memory, 10 GiB disk; no GPU |
| Monitoring | SDK status every 250 ms; PostgreSQL revalidation at most every two seconds while awaiting completion, plus sensitive boundaries |

Timeout, cancellation and excess output never appear as complete successful
results; partial output is withheld. Ordinary nonzero exits retain bounded output
and their failure status. Output is untrusted project data and can itself contain
sandbox secrets; preventing that requires the credential-free isolation described
above. Application audit events never include output or provider error details.
Persistent rows supply audit metadata even if the existing optional in-memory
audit log is disabled. Event timestamps, operation/project/workspace/catalogue/
agent/context IDs and lifecycle outcomes are sufficient for correlation.

Revocation, expiration, rotation, request abort and policy changes stop subsequent
scheduling and output release. Cleanup attempts CANCEL, waits for a terminal
supervisor envelope plus its successful exit, then deletes the session. A deleted
session alone is not evidence of stopped processes. Confirmation means disappearance
of the supervised process group; it does not attest escaped descendants. Failed
confirmation/cleanup retains UNKNOWN. Late session creation gets a compensating
bounded delete, and timed-out cleanup loops schedule no subsequent provider polls.

PostgreSQL and remote START are not an atomic transaction. Invalidation after the
last check but before provider delivery can still race dispatch. Monitoring limits
continued authorization, but cannot undo completed mutations. SDK calls have no
per-call AbortSignal and an in-flight request may finish after local cancellation.
No cancellation of completed or escaped external work is claimed.

## Remaining release review

The implementation is ready for technical review and separately authorized,
disposable provider verification, not production enablement. Provider verification
must test shell/PTY framing, supported binary paths/UID, resource and outbound
network enforcement, absent credentials, descendant isolation/cancellation,
remote timeout, fragmented/oversized logs, deletion, reconnect behavior and
orphan reconciliation. Mocked SDK adapters and local processes prove application
behavior, not live Daytona compatibility. SDK logs are fully buffered before
application byte checks; a malicious control plane can still exceed network-memory
expectations. SDK instrumentation may record provider exception text before
application sanitization; provider tracing/log retention also needs review.

Existing policy profiles and approvals remain process-local, as in the approved
foundation. A record missing on another application instance denies approval;
this does not grant permission but can cause unavailable approval workflows.
Profile changes are checked against the current process. Consistent distributed
policy/approval administration is a release concern; no broad approval-system
rewrite is included. PostgreSQL coordination itself is shared across instances.

## Validation

Node.js **24.19.0**, npm **11.9.0**, installed Daytona SDK **0.214.0**.

| Check | Actual result |
| --- | --- |
| `npm ci` | Passed; no dependency or lockfile changes |
| `npx prisma validate` / `npx prisma generate` | Passed |
| `npm run lint` / `npm run typecheck` | Passed |
| `npm run test:unit` | 1,464 passed across 40 files |
| `npm run test:auth-db` | 255 passed across seven files |
| `npm run test:execution-auth` | 154 passed across four files |
| `npm run test:auth-http` | Four compiled HTTP verification groups passed |
| `npm run test:auth-boundary` | Five real Next.js client-import rejection probes passed |
| `npm run build` | Passed |

The suites include 195 new command-specific tests (122 unit and 73 database-backed).
The initial database run exposed test expectations that incorrectly assumed local
process-group disappearance, plus a completion invariant tightened during review.
After correcting the expectations to preserve truthful UNKNOWN outcomes and
requiring both completion flags, both database suites passed in full. Local PID1
can retain orphan zombies; tests never reinterpret those as confirmed cancellation.

Tests use only a disposable PostgreSQL instance on loopback and synthetic credentials. The
command supervisor tests run real npm processes in temporary local fixtures;
SDK transport tests use controlled adapters and genuine database authorization.
The fixtures' binary paths, non-root requirement and process limits are adapted
only in test program strings for this container; production constants have no
runtime override. The known account-level GitHub Actions restriction is separate
from these local results and was not investigated or changed.

## Changed files

- `docs/reviews/phase-1a-3e-command-execution.md`
- `docs/trusted-workspace-authorization.md`
- `package.json`
- `prisma/manual-schema.sql`
- `prisma/migrations/20261016000000_command_operations/migration.sql`
- `prisma/schema.prisma`
- `scripts/check-auth-client-boundary.mjs`
- `src/app/api/security/approvals/route.ts`
- `src/lib/agents/tool-executor.ts`
- `src/lib/agents/tools.ts`
- `src/lib/security/command-authorization.ts`
- `src/lib/security/command-catalogue.ts`
- `src/lib/security/command-operation-store.ts`
- `src/lib/security/execution-context.ts`
- `src/lib/security/policy.ts`
- `src/lib/workspace/private-cloud-command-availability.ts`
- `src/lib/workspace/private-cloud-command-program.ts`
- `src/lib/workspace/private-cloud-command-session.ts`
- `src/lib/workspace/providers/daytona.ts`
- `src/lib/workspace/runtime-cloud.ts`
- `src/lib/workspace/runtime-local.ts`
- `src/lib/workspace/runtime.ts`
- `tests/helpers/command-session-adapter.ts`
- `tests/integration/command-execution-authorization.test.ts`
- `tests/integration/command-operation-store.test.ts`
- `tests/unit/command-authorization.test.ts`
- `tests/unit/command-catalogue.test.ts`
- `tests/unit/command-provider.test.ts`
- `tests/unit/private-cloud-command-program.test.ts`
