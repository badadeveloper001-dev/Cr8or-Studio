# Phase 1A-3D: staged Daytona file writing

Base: PR #5, `cr8or-006-workspace-authorization`, reviewed HEAD
`7d577777fb38c0ff421f2800e87e70fc867ca38c`.
Implementation branch: `cr8or-008-cloud-file-operations`.

## Implementation and release status

The private cloud writer is implemented with the installed Daytona SDK's session
input APIs and a fixed Python filesystem helper. Real temporary-filesystem tests,
a local PTY test, controlled SDK adapters, and PostgreSQL authorization tests
exercise the complete staged-write protocol. These are not live Daytona tests.

**Application private cloud writes remain blocked pending separately authorized
isolated Daytona compatibility verification.**
`assertPrivateCloudWriteTransportAvailable()` is a hardcoded release restriction
before provider lookup. It has no environment, request, credential, or browser
override. Tests replace only this restriction to exercise direct HTTP and agent
runtime paths; they still require actual PostgreSQL-issued authorization.
Removing it requires a reviewed code change after isolated provider verification.
No additional authentication system or bypass switch is introduced.

The unchanged `writeFile` runtime interface serves both `/api/files` and the
agent `write_file` tool. Existing agent permission tiers, approval policies,
origin protection, registered project IDs, and Daytona bindings remain intact.
Local writes and inactive-stage cloud behavior are unchanged. The one-shot
read/list helper still rejects writes; no pathname upload fallback exists in
private mode. General commands, Git, deployment, preview, and provisioning
restrictions are unchanged.

## Transport protocol

The initiating genuine `ExecutionAuthorizationContext` is required even if the
legacy authentication flag is disabled. The writer queries the existing session
and project registry before starting, validates the exact cloud/daytona sandbox
association, and revalidates during transfer and immediately before commit.
No session ID, raw token, owner identifier, or agent-generated authorization
metadata is included in the remote command, environment, or content frames.

1. A dedicated provider client retrieves only the exact already-running sandbox.
   It uses the public SDK options `requestTimeoutMs: 5000` and
   `useDeprecatedPolling: true`. This preserves the ordinary client and avoids
   an unnecessary lifecycle WebSocket. It cannot start/recover/create/remap a
   workspace, and it caches no authorization decision.
2. `createSession` creates a random one-operation session. An asynchronous command
   launches `exec python3 -I -S -u -c <fixed program> <path/nonce metadata>` with
   `suppressInputEcho: true`. No file contents or content digest appear in argv.
3. The helper validates the path and configures terminal input before emitting
   `CR8OR-WRITE/1 <nonce> READY`. Pipes are also supported. On a PTY it disables
   echo, canonical buffering, CR/LF translation, and flow-control processing.
4. `sendSessionCommandInput` sends bounded ASCII lines beginning with
   `#CR8OR-WRITE/1 <nonce> `. `BEGIN <UTF-8 byte count> <SHA-256 digest>` declares
   the transfer. Sequence-numbered `DATA <sequence> <Base64>` frames carry at most
   12,288 decoded bytes each; the final chunk must exactly match the remaining
   declared length. `END` finishes the transfer, including zero-byte files.
5. The helper checks exact length, sequence, canonical Base64, strict UTF-8, and
   the digest; it syncs and verifies the stage before emitting `STAGED <bytes>`.
   **Staging does not change the destination.**
6. The server revalidates the initiating session, credential version, permission,
   project, and sandbox binding in PostgreSQL. Only then does it send `COMMIT`.
   The helper rechecks filesystem identities, atomically replaces the destination,
   syncs the directory, and emits `COMMITTED <bytes>`.
7. The server requires the exact cumulative acknowledgement transcript, validates
   authorization again, and deletes the operation session. Errors before commit
   trigger best-effort `ABORT` and session deletion. A late successful session
   creation receives a compensating deletion; it cannot resume the transfer.

After ABORT, cleanup gives the helper a bounded opportunity to exit before
deleting the SDK session. The helper masks termination signals while adopting
new filesystem objects and while cleaning up, and retains cancellation without
raising again into an exception already unwinding. This prevents ordinary
abort/delete races from losing track of a newly created stage or interrupting
its cleanup. Linux `pthread_sigmask` support is required alongside the POSIX
descriptor and terminal operations.

Base64 is only transport encoding within the separate input API; it is not
confidentiality. The comment prefix makes late frames inert if an ended helper's
input unexpectedly reaches a shell. It does not substitute for authorization or
the READY handshake. Status messages never include source, paths, hashes, or
provider diagnostics. Application errors are reconstructed from static messages;
provider exceptions and request bodies are never logged by this implementation.

## Filesystem guarantees

The helper opens `repo` and descendants with descriptor-relative no-follow
operations. It independently rejects absolute/traversal/sensitive paths, symbolic
links, hard-linked destinations, and unsupported special files. Missing parent
directories are created through the same boundary and removed on failure only
if still matching and empty.

A random stage is created in the destination directory with exclusive/no-follow
creation and mode `0600`. Only this file receives transfer bytes. Invalid frames,
incomplete input, digest mismatch, invalid UTF-8, cancellation, or a detected
authorization failure before COMMIT leave the destination unchanged. Cleanup
removes the operation's own stage without following a replaced staging pathname.

Before replacement the helper rewalks and compares the root/ancestor identities,
checks the destination's identity/link count/size/timestamps against its original
snapshot, and revalidates the stage's identity, single link, size, and content
digest. It uses same-directory descriptor-relative `os.replace`; there is no
cross-filesystem copy or partial destination write. Existing permission bits are
preserved without setuid/setgid; new files use `0600`. The host filesystem must
support these POSIX operations; unsupported operations fail closed.

Atomic replacement means readers see the old or complete new file. It is not a
transaction with PostgreSQL or a defense against a fully hostile same-UID process
inside the trusted sandbox. Namespace changes between the final filesystem check
and rename, and session invalidation after the last database check but before
remote commit, cannot be eliminated by this application protocol.

## Limits and failure semantics

| Resource | Bound |
| --- | --- |
| File content | 256 KiB of exact UTF-8; malformed UTF-16 input is rejected before encoding |
| Private file POST body | Existing 2 MiB and 10-second reader, unchanged |
| Relative path | Existing 4 KiB UTF-8 limit; safe redundant separators are canonicalized |
| Data frame | 12 KiB decoded, remote line cap 16,512 bytes; no unlimited buffering |
| Writer status output | 4 KiB per SDK field, strict cumulative READY/STAGED/COMMITTED transcript; stderr is rejected |
| Remote helper | 30-second alarm, termination/hangup handling |
| Server transfer | 35-second monotonic deadline, cancellation signal, at most 160 polls at 100 ms intervals |
| Cleanup | Separate 5-second budget; failures never report confirmed cleanup |
| SDK HTTP | 5 seconds per attempt on the scoped client, including input/log/delete calls |

The SDK may retry connection failures and safe GET/DELETE operations. Its timeout
is per attempt; a logical request may last approximately 16 seconds. It does not
replay a potentially delivered input POST after a mid-flight failure, but even
connect-only retries can extend the interval between authorization and commit.
The independent operation deadline and remote alarm remain necessary.

An HTTP timeout does not cancel an already-dispatched remote operation. After
COMMIT is dispatched, an input error, missing acknowledgement, directory-sync
failure, revocation, or cleanup failure can occur **after replacement succeeded**.
The writer does not automatically replay a commit. Inspect the destination
before retrying an uncertain write. Precommit rejection and postcommit uncertainty
are intentionally distinguished; no rollback of a completed external write is
claimed.

The remote helper handles ordinary timeout/abort/termination cleanup. SIGKILL,
host loss, or provider behavior that does not deliver signals can leave an
orphaned private stage/session. No automatic broad deletion of unknown files or
sessions is introduced. If this occurs, a trusted operator must identify the
abandoned operation before cleanup. These failure modes must be included in the
isolated provider verification.

## Remaining SDK verification

Installed SDK **0.214.0** forwards session input separately as `{ data }`; the
implementation uses only public SDK methods. Client types do not prove the
server's working-directory, terminal, input-delivery, cumulative-log, deletion,
or process-lifecycle semantics. A separately authorized disposable Daytona test
must exercise exact Unicode/empty/max-size writes, echo suppression, interrupted
transfer, revocation before commit, timeout, deletion, and orphan handling before
the release restriction is removed.

The SDK buffers log responses and exposes no byte-limited stream or caller abort
signal for these session calls. The helper emits tiny fixed status output and
the caller rejects excess before parsing; this is not a network-memory bound
against a malicious provider. The Daytona control plane remains trusted and can
observe submitted content. SDK tracing can record provider-reflected exception
details before application catches; no claim is made to prevent provider-side
observation or retention.

## Actual validation

Checks ran on 2026-10-16 using **Node.js 24.19.0 / npm 11.9.0**.

| Command | Actual result |
| --- | --- |
| `npm ci --cache /tmp/cr8or-008-npm-cache` | Passed; 929 packages installed with the unchanged lockfile |
| `npx prisma validate` | Passed using explicit isolated test configuration |
| `npx prisma generate` | Passed, Prisma 6.19.3 |
| `npm run lint` | Passed |
| `npm run typecheck` | Passed |
| `npm run test:unit` | **1,342 passed / 36 files** |
| `npm run test:auth-db` | **182 passed / 5 files** |
| `npm run test:execution-auth` | **81 passed / 2 files**, including all 26 new cloud write authorization cases |
| `npm run build` | Passed, Next.js 15.5.22, including type/lint checks |
| `npm run test:auth-http` | All four compiled local-server check groups passed |
| `npm run test:auth-boundary` | All three actual Client Component/server-only rejection probes passed |
| `git diff --check` | Passed |

The full unit count includes **76 actual Python/filesystem/PTY tests**, **46
controlled session transport tests**, and **19 scoped-provider tests**. The
PostgreSQL cases use actual session provisioning, expiration, rotation,
revocation, registration checks, direct file POST handlers, and agent execution.
The new integration fixture substitutes the SDK client/provider adapters and the availability gate
only for isolated runtime testing; PostgreSQL authentication is not mocked.

All database and compiled HTTP checks used the disposable PostgreSQL 16 container
bound to loopback, strict test URL validation, synthetic credentials, and temporary
schemas. No environment file or production database fallback is used. The local
PTY and controlled adapters cannot establish live Daytona compatibility. Temporary
test infrastructure was removed after validation.

Existing dependency engine constraints make Node 24 the supported baseline here;
Node 20 was not rerun for this task. Dependency versions and the lockfile were not
changed, and existing audit findings remain separate. No audit check was removed.
The known GitHub Actions account restriction was not investigated or treated as
a local code-validation failure.

No live Daytona test, production credential use, production database/settings
change, owner provisioning, authentication activation, merge, or manual deployment
is part of this task. Existing project/workspace identifiers and histories remain
unchanged. No dependency upgrade or database migration is introduced.

## Changed files

- `package.json` (include the new PostgreSQL suite in the existing test commands)
- `src/lib/workspace/private-cloud-write-program.ts`
- `src/lib/workspace/private-cloud-write-session.ts`
- `src/lib/workspace/private-cloud-write-availability.ts`
- `src/lib/workspace/private-cloud-files.ts`
- `src/lib/workspace/runtime-cloud.ts`
- `src/lib/workspace/providers/daytona.ts`
- `tests/helpers/daytona-session-adapter.ts`
- `tests/unit/private-cloud-write-program.test.ts`
- `tests/unit/private-cloud-write-session.test.ts`
- `tests/unit/daytona-private-file-process.test.ts`
- `tests/integration/cloud-write-authorization.test.ts`
- `docs/trusted-workspace-authorization.md`
- `docs/private-api-authorization.md`
- `docs/reviews/phase-1a-3d-cloud-file-operations.md`

The existing execution context and private request-body reader were reviewed and
reused without modification. Authentication/session policy, access-code length,
schema, migration history, dependencies, and lockfile remain unchanged.
