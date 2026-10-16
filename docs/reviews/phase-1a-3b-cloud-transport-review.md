# Phase 1A-3B cloud filesystem correction

PR #5, branch `cr8or-006-workspace-authorization`; reviewed starting commit
`4c579b2a78d4270c0ed5c18cf8642b5ab7d3d62d`. This correction keeps private cloud
writes unavailable. It does not activate authentication or change production.

## Original issue

The private filesystem helper previously serialized write content with the
operation/path into Base64 JSON and placed it in a shell command argument.
Base64 is reversible encoding, not encryption. Provider command capture, process
inspection, or diagnostic exceptions could disclose source contents. Encoding
also increases payload size (approximately four thirds before JSON escaping),
making even ordinary source files vulnerable to OS argument-size limits or
provider request limits. Quoting prevents shell injection but solves neither
confidentiality nor argument-size constraints.

## Installed SDK investigation and decision

The installed `@daytona/sdk` is **0.214.0**. Inspection covered its implementation
and the bundled toolbox client's request contracts; no live workspace was used.

| Transport | SDK evidence | Assessment |
| --- | --- | --- |
| One-shot command | `esm/Process.js`, `executeCommand` | Accepts command, working directory, environment, and remote timeout. No stdin, caller abort signal, or response byte limit is exposed. |
| Session command input | `createSession`, `executeSessionCommand`, `sendSessionCommandInput` | Supported: input is sent separately as `{ data }`, and `suppressInputEcho` is available. This is a potential future transport, not evidence that stdin is unavailable everywhere in the SDK. |
| PTY input | `createPty`, `PtyHandle.sendInput` | Supports string/byte input, but introduces interactive shell/terminal behavior and echo, framing, and lifecycle concerns. |
| Buffer upload | `esm/FileSystem.js`, `uploadFile` | Multipart transfer avoids content in argv. Its destination is a pathname; the API does not expose descriptor-relative, no-follow, hard-link, or atomic commit guarantees. It cannot replace the contained helper safely. |
| Streaming file transfer | `uploadFileStream`, `downloadFileStream` | Explicitly rejected in the SDK's serverless runtime, which includes Vercel (`esm/utils/Runtime.js`). |
| File move | `moveFiles` | Forwards source/destination paths without an exposed no-follow or atomic commit contract. A separate upload followed by a pathname move would not establish the required guarantees. |

A safe session-input implementation needs a separately reviewed protocol for
readiness, byte framing, input echo/history, timeouts, cleanup, and fresh session
authorization before committing a write. The session command's timeout is an
HTTP request timeout in this SDK, unlike the documented remote timeout of
`executeCommand`. An atomic commit would also need a securely created temporary
file, descriptor-relative containment checks, hard-link protection, and a safe
rename strategy. Upload-and-rename alone is not an adequate replacement.

For this narrow correction, **every private cloud write is rejected before
content encoding or provider access**. Authorization is still checked first in
the runtime. An ordinary authorized write returns a static 503; an oversized
write returns a static resource-limit error. No SDK-upload fallback is used and
existing source files remain untouched. Local private writes and inactive-stage
cloud writes retain their existing supported behavior; tests verify exact UTF-8
contents for the latter. There is no successful private cloud write path to
claim or test until the new transport is implemented and reviewed.

Private read/list operations retain the fixed Python helper and existing
registered-project/provider binding and before/after session revalidation.
Arguments contain only a fixed program and bounded operation/path metadata.
The helper has no write or arbitrary-command branch. Root and descendant
directories use descriptor-relative `O_NOFOLLOW`; reads require a regular file
with one hard link. Traversal, symlinks, hard links, and special files remain
rejected. DTOs are reconstructed and provider exceptions are replaced by static
errors, without returning commands, file contents, stdout, or provider details.

## Resource limits

| Resource | Limit and behavior |
| --- | --- |
| Private file POST body | 2 MiB of declared and actual UTF-8 bytes, including JSON escaping/metadata; 10-second read deadline. Authentication/origin checks run first. Oversize is 413; malformed bodies, invalid UTF-8, timeout, and abort are static 400 responses. |
| Private cloud write content | 256 KiB of UTF-8; oversized content fails with 409 before encoding/provider access. Smaller writes remain blocked with 503. |
| Private cloud file read | 256 KiB; checks file size before reading and reads at most limit + 1 bytes to detect growth. Oversize is 409; no truncated source is returned. Invalid UTF-8 fails closed. |
| Relative cloud path | 4 KiB of UTF-8 before encoding. |
| Directory enumeration | At most 4,096 examined entries and 200 visible entries. Exceeding either fails the whole operation; no silent partial listing. |
| Remote output | 2 MiB of UTF-8 JSON, bounded by the helper before printing and checked again on both SDK result fields before parsing. |
| Remote operation | Python alarm and SDK execution timeout of 30 seconds; local wait deadline of 35 seconds. Timeout returns a static unavailable error. |

The larger JSON/body limits accommodate escaping without reducing the 256 KiB
file limit. Response validation checks exact UTF-8 byte counts and rejects
malformed surrogate data. The request reader also checks a monotonic deadline
between chunks, so immediately resolved chunks cannot starve its timeout. A
single bounded byte buffer and one interruption race prevent tiny or empty
chunks from accumulating per-chunk strings or retained promise reactions.

## Logging, cancellation, and trust limits

- SDK instrumentation does not directly record method arguments in the inspected
  decorator, but does record exceptions. Provider-side command, input, and output
  retention cannot be verified from the client library. No confidentiality claim
  is made about that infrastructure. Reads still return file contents through
  provider output, so the provider/control plane remains trusted.
- The one-shot SDK buffers output before returning it. The producer bound protects
  the normal helper path, and the response check prevents oversized JSON parsing
  or release. It is not a hard network-memory bound against a malicious provider.
- The local deadline bounds how long the application waits; it cannot abort an
  already-dispatched SDK request. The helper alarm and provider timeout bound
  ordinary remote execution. Uninterruptible kernel I/O or a malfunctioning
  provider can exceed those guarantees. No claim is made to undo completed work.
- Existing session revalidation prevents subsequent operations and result release
  after revocation is detected. There is no continuous database polling, and no
  private cloud write can run while this restriction is in place.
- The Python 3/POSIX helper must still be verified in an explicitly authorized
  isolated Daytona sandbox before production activation. Tests here use temporary
  local files and mocked provider adapters, never production workspaces.
- General command execution and other previously blocked private operations
  remain blocked. Deployment protection remains required while authentication
  is inactive. No dependency versions or lockfile entries changed.

## Validation

Checks ran on 2026-10-16 with Node.js **24.19.0 / npm 11.9.0** and comparison
runtime **20.20.2 / npm 10.8.2**, using the existing installed dependencies.

| Check | Node 24 | Node 20 comparison |
| --- | --- | --- |
| `npm run lint` | Passed | Passed |
| `npm run typecheck` | Passed | Passed |
| Unit tests | `npm run test:unit`: **1,201 passed / 33 files** | Focused helper/runtime/body suites: **91 passed / 3 files** |
| `npm run test:execution-auth` | **55 passed** | **55 passed** |
| `npm run build` | Passed, Next.js 15.5.22; Prisma generation also passed | Passed; Prisma generation also passed |
| `npm run test:auth-http` | All four compiled-server check groups passed | All four passed |
| `npm run test:auth-boundary` | All three actual Client Component rejection probes passed | All three passed |

The focused Node 20 Vitest runs covered `private-cloud-files.test.ts`,
`workspace-authorization-runtime.test.ts`, and `private-file-write-body.test.ts`.
The full unit suite was run on Node 24 for this correction. `git diff --check`
also passed.

The unit checks execute the actual Python helper in temporary local directories
and real file POST handlers with controlled dependencies. They cover content-free
command arguments, unchanged files after blocked writes, exact supported UTF-8
contents, symlink/hard-link/traversal/special-file rejection, size/list/output
limits, deadlines, error sanitization, and fragmented/aborted HTTP bodies. A
final review found and corrected per-chunk promise retention in the body reader;
the final full suite includes the resulting stress/cancellation regressions.

The PostgreSQL checks use a disposable PostgreSQL 16 container bound to loopback,
explicit test-only configuration, synthetic credentials, and temporary schemas.
They exercise actual session revocation, expiration, rotation, capability
provenance, project/provider binding, and rejection before side effects. Provider
adapters are controlled fixtures. The HTTP checks launch compiled local servers
against disposable schemas; no production service or workspace is accessed.

The Node 20 comparison is not a supported-runtime declaration. Existing AI SDK
and Supabase packages require Node 22+, and installed nanoid declares
`^22 || ^24 || >=26`; the comparison emits the existing Supabase warning. No
dependency changes or audit-check removal were made. The known GitHub Actions
account restriction was not investigated or treated as a local test failure.

No production databases, environment variables, credentials, or deployments
were changed. Authentication remains inactive, all existing project/workspace
identifiers are preserved, and no migration, merge, or Phase 1A-3C work occurred.

## Changed files

- `src/lib/workspace/private-cloud-files.ts`
- `src/lib/workspace/runtime-cloud.ts`
- `src/lib/security/private-file-write-body.ts`
- `src/app/api/files/route.ts`
- `tests/unit/private-cloud-files.test.ts`
- `tests/unit/workspace-authorization-runtime.test.ts`
- `tests/unit/private-file-write-body.test.ts`
- `tests/integration/execution-authorization.test.ts`
- `docs/trusted-workspace-authorization.md`
- `docs/private-api-authorization.md`
- `docs/reviews/phase-1a-3b-validation.md`
- `docs/reviews/phase-1a-3b-cloud-transport-review.md`
